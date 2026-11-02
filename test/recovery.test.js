const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Brief 041: "Email me a recovery link." Requesting a link always returns
// the same generic confirmation; a matching email gets a single-use,
// hashed, 60-minute token; the link restores that profile's session.
// Fixtures are fictional. No real data, no real mail (test capture file).

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PORT = 37500 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const GENERIC = 'If that email has a family with us, a recovery link is on its way.';

test('recovery entry points and request form are on the page', () => {
  assert.ok(PAGE.split('Lost access to your family? Email me a recovery link.').length >= 3,
    'entry point appears in the sign-in area and the invite account-choice screen');
  assert.ok(PAGE.includes('id="recoveryEmail"'), 'request form has one email field');
  assert.ok(PAGE.includes('id="recoverySubmitBtn"'), 'request form has a submit button');
  assert.ok(PAGE.includes('/api/recovery/request'), 'form posts to the recovery endpoint');
  assert.ok(PAGE.includes(GENERIC), 'generic confirmation wording is used');
  assert.ok(PAGE.includes('recovery_configured'), 'entry points are gated on a configured sender');
});

test('email recovery: generic response, hashed single-use token, restore, expiry, invalidation', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-recovery-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const mailFile = path.join(tmpDir, 'mail.jsonl');
  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();

  const rita = db.createProfile({
    parent_name: 'Recovery Rita',
    parent_email: 'known@example.com',
    children: [{ name: 'Rita Junior' }],
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  const older = db.createProfile({
    parent_name: 'Shared Older',
    parent_email: 'shared@example.com',
    children: [{ name: 'Older Junior' }],
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  await new Promise((r) => setTimeout(r, 15));
  const newer = db.createProfile({
    parent_name: 'Shared Newer',
    parent_email: 'shared@example.com',
    children: [{ name: 'Newer Junior' }],
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });

  // Hashed storage, proven at the store level: the row holds only the
  // SHA-256 of the raw token, never the raw token itself.
  const unit = db.createRecoveryToken(older.id);
  const meta = db.recoveryTokenMetaForProfile(older.id);
  assert.ok(meta && meta.token_hash, 'token row exists');
  assert.notEqual(meta.token_hash, unit.token, 'raw token is not stored');
  assert.equal(meta.token_hash, crypto.createHash('sha256').update(unit.token).digest('hex'),
    'stored value is the SHA-256 hash of the token');
  assert.ok(Buffer.from(unit.token, 'base64url').length >= 16, 'token carries at least 128 bits');

  // An already-expired token for Rita, minted before the server boots.
  const expired = db.createRecoveryToken(rita.id, -1000);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath, PARENTLOOP_TEST_MAIL_FILE: mailFile },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
      post: (p, body) => req(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    };
  }

  function capturedMail() {
    if (!fs.existsSync(mailFile)) return [];
    return fs.readFileSync(mailFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  function tokenFromMail(to) {
    const mail = capturedMail().filter((m) => m.to === to).pop();
    assert.ok(mail, `a recovery email was captured for ${to}`);
    const m = mail.text.match(/\/recover\/([A-Za-z0-9_-]+)/);
    assert.ok(m, 'email contains a recovery link');
    return { mail, token: m[1] };
  }

  const probe = makeClient();
  {
    const deadline = Date.now() + 20000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await probe.get('/api/auth/status');
        if (res.res.ok) { up = true; break; }
      } catch { /* still starting */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, 'Test server did not start.');
  }

  let unknownBody;
  await t.test('unknown email → generic confirmation, no send', async () => {
    const before = capturedMail().length;
    const res = await probe.post('/api/recovery/request', { email: 'nobody@example.com' });
    assert.equal(res.res.status, 200);
    assert.equal(res.data.message, GENERIC);
    unknownBody = res.data;
    assert.equal(capturedMail().length, before, 'no email was sent');
  });

  await t.test('expired token is rejected', async () => {
    const visitor = makeClient();
    const res = await visitor.get(`/recover/${expired.token}`);
    assert.equal(res.res.status, 302);
    assert.match(res.res.headers.get('location') || '', /recovery=error/);
    const status = await visitor.get('/api/onboarding/status');
    assert.notEqual(status.data.profile && status.data.profile.parent.name, 'Recovery Rita');
  });

  let ritaToken;
  await t.test('known email → identical generic body, token created and send attempted', async () => {
    const res = await probe.post('/api/recovery/request', { email: 'known@example.com' });
    assert.equal(res.res.status, 200);
    assert.deepEqual(res.data, unknownBody, 'response cannot probe which emails have families');
    const { mail, token } = tokenFromMail('known@example.com');
    ritaToken = token;
    assert.ok(!mail.text.includes('Rita Junior'), 'email contains no family data');
    assert.ok(!mail.text.includes('Recovery Rita'), 'email contains no family data');
  });

  await t.test('link restores the session to the right profile', async () => {
    const visitor = makeClient();
    const res = await visitor.get(`/recover/${ritaToken}`);
    assert.equal(res.res.status, 302);
    assert.equal(res.res.headers.get('location'), '/?recovered=1');
    const status = await visitor.get('/api/onboarding/status');
    assert.equal(status.data.profile.parent.name, 'Recovery Rita');
    assert.equal(status.data.isDemo, false);
  });

  await t.test('token reuse is rejected', async () => {
    const visitor = makeClient();
    const res = await visitor.get(`/recover/${ritaToken}`);
    assert.equal(res.res.status, 302);
    assert.match(res.res.headers.get('location') || '', /recovery=error/);
    const status = await visitor.get('/api/onboarding/status');
    assert.notEqual(status.data.profile && status.data.profile.parent.name, 'Recovery Rita');
  });

  await t.test('a new request invalidates the old token; shared email restores the newest profile', async () => {
    await probe.post('/api/recovery/request', { email: 'shared@example.com' });
    const first = tokenFromMail('shared@example.com').token;
    await probe.post('/api/recovery/request', { email: 'shared@example.com' });
    const second = tokenFromMail('shared@example.com').token;
    assert.notEqual(first, second);
    const stale = makeClient();
    const staleRes = await stale.get(`/recover/${first}`);
    assert.match(staleRes.res.headers.get('location') || '', /recovery=error/);
    const visitor = makeClient();
    const okRes = await visitor.get(`/recover/${second}`);
    assert.equal(okRes.res.headers.get('location'), '/?recovered=1');
    const status = await visitor.get('/api/onboarding/status');
    assert.equal(status.data.profile.id, newer.id, 'most recently created profile with that email wins');
    assert.equal(status.data.profile.parent.name, 'Shared Newer');
  });

  await t.test('requests are rate limited per email', async () => {
    const client = makeClient();
    for (let i = 0; i < 5; i++) {
      const res = await client.post('/api/recovery/request', { email: 'hammer@example.com' });
      assert.equal(res.res.status, 200, `request ${i + 1} stays generic`);
    }
    const sixth = await client.post('/api/recovery/request', { email: 'hammer@example.com' });
    assert.equal(sixth.res.status, 429, 'sixth request in the window is limited');
  });

  await t.test('demo evening check regression unchanged', async () => {
    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    const run = await demo.post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.equal(run.data.nudges.length, 2);
    assert.equal(run.data.conflicts.length, 3);
    assert.equal(run.data.relevant_count, 28);
    assert.equal(run.data.filtered_out_count, 1);
    const lastLog = run.data.logs[run.data.logs.length - 1].message;
    assert.ok(lastLog.startsWith('PRIVACY CHECK: family profile data used only inside this Parent Agent run'));
  });
});
