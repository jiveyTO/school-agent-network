const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 34100 + (process.pid % 800);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let tmpDir = null;

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
    const opts = Object.assign({}, options || {});
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
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { res, data, text, setCookie };
  }
  return {
    req,
    get: (p) => req(p),
    post: (p, body) =>
      req(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    cookie: () => cookie,
  };
}

test('per-visitor sessions are isolated between browsers', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-sessions-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await t.test('a session cookie is issued on the first response', async () => {
    const fresh = makeClient();
    assert.equal(fresh.cookie(), '', 'no cookie before first request');
    const home = await fresh.get('/');
    assert.ok(home.setCookie, 'first response sets a cookie');
    assert.match(home.setCookie, /parentloop_session=[^;]+/, 'session cookie present');
    assert.match(home.setCookie, /Path=\//, 'cookie path is /');
    assert.match(home.setCookie, /HttpOnly/i, 'cookie is HttpOnly');
    assert.match(home.setCookie, /SameSite=Lax/i, 'cookie is SameSite=Lax');
    assert.doesNotMatch(home.setCookie, /Secure/i, 'no Secure flag over plain http');
    assert.ok(fresh.cookie().startsWith('parentloop_session='), 'client stored the session');
  });

  await t.test('two sessions hold different active profiles concurrently', async () => {
    const browserA = makeClient();
    const browserB = makeClient();

    const statusA0 = await browserA.get('/api/onboarding/status');
    assert.equal(statusA0.data.profile.parent.name, 'Alex Rivera', 'fresh session sees the demo family');
    assert.equal(statusA0.data.needsOnboarding, true, 'fresh session needs onboarding');

    const demoA = await browserA.post('/api/profile/demo', {});
    assert.equal(demoA.data.profile.parent.name, 'Alex Rivera');

    const beta = await browserB.post('/api/profile', {
      parent_name: 'Beta Parent',
      child_name: 'Beta Child',
      grade: 'Grade 2',
      class_name: '',
      school_name: 'Willow Creek Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
      actions: {},
    });
    assert.equal(beta.data.profile.parent.name, 'Beta Parent');

    const statusB1 = await browserB.get('/api/onboarding/status');
    assert.equal(statusB1.data.profile.parent.name, 'Beta Parent', 'browser B sees its own profile');
    assert.equal(statusB1.data.needsOnboarding, false, 'browser B is onboarded');

    const statusA1 = await browserA.get('/api/onboarding/status');
    assert.equal(statusA1.data.profile.parent.name, 'Alex Rivera', 'browser A still sees the demo family');

    const hubsB = await browserB.get('/api/hubs');
    assert.deepEqual(hubsB.data.hubs, [], 'Beta belongs to no hubs yet');

    const alpha = await browserA.post('/api/profile', {
      parent_name: 'Alpha Parent',
      child_name: 'Alpha Child',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
      actions: {},
    });
    assert.equal(alpha.data.profile.parent.name, 'Alpha Parent');

    const statusB2 = await browserB.get('/api/onboarding/status');
    assert.equal(statusB2.data.profile.parent.name, 'Beta Parent', 'creating Alpha did not disturb Beta');

    const resetB = await browserB.post('/api/profile/reset', {});
    assert.equal(resetB.data.ok, true);
    const statusB3 = await browserB.get('/api/onboarding/status');
    assert.equal(statusB3.data.profile.parent.name, 'Alex Rivera', 'reset returns B to the demo family');
    const statusA2 = await browserA.get('/api/onboarding/status');
    assert.equal(statusA2.data.profile.parent.name, 'Alpha Parent', 'resetting B did not disturb A');
  });

  await t.test('a fresh browser after A onboarded still lands on the demo family', async () => {
    const browserC = makeClient();
    const statusC = await browserC.get('/api/onboarding/status');
    assert.equal(statusC.data.profile.parent.name, 'Alex Rivera', 'no adoption of another visitor profile');
    assert.equal(statusC.data.profile.is_demo, true, 'fresh session falls back to demo');
    assert.equal(statusC.data.needsOnboarding, true, 'fresh session still needs onboarding');
  });
});
