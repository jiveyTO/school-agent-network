// Gmail connect OAuth state. /api/email/auth mints a random, single-use,
// short-lived token bound to the starting session and its family; the
// callback attaches tokens only to that bound family. A profile ID (or any
// other forged value) as `state` must be refused before Google is called,
// and no family's Gmail connection may change.
// All fixtures are fictional (Northwind / Harbor families). No real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 40100 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/onboarding/status`);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

function makeClient() {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({ redirect: 'manual' }, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (cookie) opts.headers.Cookie = cookie;
    const res = await fetch(`${BASE}${urlPath}`, opts);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/parentloop_session=([^;]+)/);
      if (m) cookie = 'parentloop_session=' + m[1];
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  }
  return {
    get: (p) => req(p),
    post: (p, body) =>
      req(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
  };
}

async function makeFamily(client, parentName, childName) {
  const created = await client.post('/api/profile', {
    parent_name: parentName,
    parent_email: 'family@example.com',
    child_name: childName,
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  assert.equal(created.res.status, 200);
  return created.data.profile;
}

async function startConnect(client) {
  const out = await client.get('/api/email/auth');
  assert.equal(out.res.status, 302);
  return new URL(out.res.headers.get('location')).searchParams.get('state');
}

// The callback always redirects; a refused state carries email=error and the
// "expired" message, which is raised before any Google request is made.
async function callback(client, state) {
  const qs = new URLSearchParams({ code: 'fake-code' });
  if (state !== undefined) qs.set('state', state);
  const out = await client.get(`/api/email/callback?${qs.toString()}`);
  assert.equal(out.res.status, 302);
  return new URL(out.res.headers.get('location'), BASE).searchParams;
}

function assertRefused(params, label) {
  assert.equal(params.get('email'), 'error', label);
  assert.match(params.get('message') || '', /expired/i, label);
}

async function assertNotConnected(client, label) {
  const status = await client.get('/api/email/status');
  assert.equal(status.data.connected, false, label);
  assert.equal(status.data.email, '', label);
}

test('Gmail connect refuses forged OAuth state', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-gmailstate-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: path.join(tmpDir, 'app.db'),
      APP_DB_GCS_BUCKET: '',
      APP_DB_GCS_OBJECT: '',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  const victim = makeClient();
  const attacker = makeClient();
  const victimFamily = await makeFamily(victim, 'Northwind Parent', 'Northwind Child');
  const attackerFamily = await makeFamily(attacker, 'Harbor Parent', 'Harbor Child');

  await t.test('state is an opaque token, not the profile ID', async () => {
    const state = await startConnect(victim);
    assert.ok(state && state.length >= 32, 'long random token');
    assert.notEqual(state, victimFamily.id);
    assert.ok(!state.includes(victimFamily.id), 'no profile ID inside the token');
    const again = await startConnect(victim);
    assert.notEqual(again, state, 'fresh token per connect');
  });

  await t.test("another family's profile ID as state is refused", async () => {
    assertRefused(await callback(attacker, victimFamily.id), 'victim id from attacker session');
    assertRefused(await callback(victim, victimFamily.id), 'own id from own session');
    assertRefused(await callback(attacker, attackerFamily.id), 'own id from attacker session');
    await assertNotConnected(victim, 'victim family unchanged');
    await assertNotConnected(attacker, 'attacker family unchanged');
  });

  await t.test('garbage or missing state is refused', async () => {
    assertRefused(await callback(attacker, 'not-a-real-state'), 'garbage');
    assertRefused(await callback(attacker, ''), 'empty');
    assertRefused(await callback(attacker, undefined), 'missing (no viewer fallback)');
    await assertNotConnected(victim, 'victim family unchanged');
    await assertNotConnected(attacker, 'attacker family unchanged');
  });

  await t.test("a real token is bound to its session and works only once", async () => {
    const state = await startConnect(victim);
    assertRefused(await callback(attacker, state), 'replayed from another session');
    assertRefused(await callback(victim, state), 'already consumed by the replay');
    await assertNotConnected(victim, 'victim family unchanged');
    await assertNotConnected(attacker, 'attacker family unchanged');
  });

  await t.test('a token is refused once the session no longer views its family', async () => {
    const state = await startConnect(victim);
    await makeFamily(victim, 'Northwind Second', 'Northwind Second Child');
    assertRefused(await callback(victim, state), 'viewer changed after connect started');
  });
});

test('Gmail state tokens expire and are single-use (store level)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-gmailstate-db-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  process.env.APP_DB_GCS_BUCKET = '';
  process.env.APP_DB_GCS_OBJECT = '';
  const db = require('../db');
  await db.initDb();
  const realNow = Date.now;
  try {
    const ok = db.createGmailState('session-north', 'profile-north');
    assert.equal(db.consumeGmailState(ok, 'session-north'), 'profile-north');
    assert.equal(db.consumeGmailState(ok, 'session-north'), null, 'single use');

    const wrong = db.createGmailState('session-north', 'profile-north');
    assert.equal(db.consumeGmailState(wrong, 'session-harbor'), null, 'other session');
    assert.equal(db.consumeGmailState(wrong, 'session-north'), null, 'burned by the mismatch');

    const stale = db.createGmailState('session-north', 'profile-north');
    const later = realNow() + 11 * 60 * 1000;
    Date.now = () => later;
    assert.equal(db.consumeGmailState(stale, 'session-north'), null, 'expired after 10 minutes');

    assert.equal(db.consumeGmailState('profile-north', 'session-north'), null, 'profile id is not a token');
    assert.equal(db.consumeGmailState('', 'session-north'), null);
  } finally {
    Date.now = realNow;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
