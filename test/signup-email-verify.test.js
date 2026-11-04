// Brief 073: a family made by typing an email confirms that address with a
// 6-digit code before it can do anything. Live test, Nov 4: "Start your own
// family" accepted any address with no proof, so anyone could squat someone
// else's email (and later recovery links would go to a stranger).
// Pending families can't create or join a hub or mint an agent token. A
// verified family's address can't be taken by a new signup; a pending one
// can be (whoever proves the inbox owns it). Families made before this, the
// demo, and Google-proven addresses are unaffected. Codes are kept hashed
// and never logged. Mail goes to a test capture file. Fictional data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PORT = 42800 + (process.pid % 90);
const SHORT_PORT = 42900 + (process.pid % 90);

function makeClient(base, ip) {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({ redirect: 'manual' }, options || {});
    opts.headers = Object.assign({ 'X-Forwarded-For': ip }, (options && options.headers) || {});
    if (cookie) opts.headers.Cookie = cookie;
    const res = await fetch(`${base}${urlPath}`, opts);
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
    post: (p, body, headers) => req(p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body || {}) }),
  };
}

// A server with the email check ON (mail goes to a capture file; the test
// switch PARENTLOOP_TEST_SIGNUP_VERIFIED is left unset on purpose).
async function startServer(t, port, extraEnv, seed) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-signup-verify-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const mailFile = path.join(tmpDir, 'mail.jsonl');
  if (seed) await seed(dbPath);
  const env = { ...process.env, PORT: String(port), APP_DB_PATH: dbPath, APP_DB_GCS_BUCKET: '', PARENTLOOP_TEST_AUTH: '1', PARENTLOOP_TEST_MAIL_FILE: mailFile, ...(extraEnv || {}) };
  delete env.PARENTLOOP_TEST_SIGNUP_VERIFIED;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const probe = makeClient(base, '10.9.0.1');
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await probe.get('/api/auth/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const mails = () => (fs.existsSync(mailFile) ? fs.readFileSync(mailFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // The newest code sent to an address.
  const codeFor = (email) => {
    const hit = mails().filter((m) => m.to === email && /Your ParentLoop code: \d{6}/.test(m.subject)).pop();
    assert.ok(hit, 'a code email went to ' + email);
    return hit.subject.match(/(\d{6})/)[1];
  };
  return { base, mails, codeFor, output: () => output, client: (ip) => makeClient(base, ip) };
}

const family = (name, email) => ({ parent_name: name, parent_email: email, children: [{ name: name + ' Kid' }] });
const otherCode = (code) => (code === '000000' ? '111111' : '000000');

test('page: the code step, its ways forward, and the pending pick-up on load', () => {
  for (const token of ['id="emailCodeView"', 'id="emailCodeInput"', 'autocomplete="one-time-code"', 'id="emailCodeConfirmBtn"',
    'id="emailCodeResendBtn"', 'id="emailCodeChangeBtn"', 'id="emailCodeSendNewBtn"', 'id="emailCodeDemoBtn"',
    'id="emailCodeTaken"', 'id="obEmailTaken"', 'so we know this email is really yours',
    "postJson('/api/profile/verify-email'", "postJson('/api/profile/resend-code'", 'if (data.needs_email_code)', 'if (status.emailPending)']) {
    assert.ok(PAGE.includes(token), `page has ${token}`);
  }
});

test('signup email verification', { timeout: 120000 }, async (t) => {
  // A family that existed before Brief 073 (made straight in the store, the
  // way every older row looks), to prove it is grandfathered.
  let oldFamilySession = '';
  const srv = await startServer(t, PORT, {}, async (dbPath) => {
    process.env.APP_DB_PATH = dbPath;
    process.env.APP_DB_GCS_BUCKET = '';
    const db = require('../db');
    await db.initDb();
    const old = db.createProfile({ parent_name: 'Older Oakley', parent_email: 'older.oakley@example.com', children: [{ name: 'Oak Kid' }] });
    const s = db.createSession();
    db.setSessionProfile(s.id, old.id);
    oldFamilySession = s.id;
  });
  const sentCodes = [];
  const note = (code) => { sentCodes.push(code); return code; };

  await t.test('the check is on, and says so', async () => {
    const status = await srv.client('10.9.1.1').get('/api/auth/status');
    assert.equal(status.data.signup_verification, true);
    assert.equal(status.data.recovery_configured, true);
  });

  // Founder Fia: signs up, gets a code, confirms, and can then make a hub.
  const fia = srv.client('10.9.2.1');
  let hubId = '';
  await t.test('signup lands pending; the right code activates it fully', async () => {
    const made = await fia.post('/api/profile', family('Founder Fia', 'fia.founder@example.com'));
    assert.equal(made.res.status, 200, made.text.slice(0, 300));
    assert.equal(made.data.needs_email_code, true);
    assert.equal(made.data.profile.email_pending, true);
    assert.equal(made.data.email_verification.sent_to, 'fia.founder@example.com');
    assert.equal(made.data.email_verification.sent, true);
    assert.match(made.data.message, /6-digit code to fia\.founder@example\.com.*really yours/);
    const code = note(srv.codeFor('fia.founder@example.com'));
    assert.ok(!made.text.includes(code), 'the code is never in the reply');
    const mail = srv.mails().find((m) => m.to === 'fia.founder@example.com');
    assert.match(mail.text, /so we know this email is really yours/);
    const status = await fia.get('/api/onboarding/status');
    assert.equal(status.data.emailPending, true);
    assert.equal(status.data.pending_email, 'fia.founder@example.com');
    const ok = await fia.post('/api/profile/verify-email', { code });
    assert.equal(ok.res.status, 200, ok.text.slice(0, 300));
    assert.equal(ok.data.verified, true);
    assert.equal(ok.data.profile.email_pending, false);
    assert.equal((await fia.get('/api/onboarding/status')).data.emailPending, false);
    const hub = await fia.post('/api/hubs', { name: 'Cedar Valley Skaters', kind: 'other' });
    assert.equal(hub.res.status, 200, hub.text.slice(0, 300));
    hubId = hub.data.hub.id;
    assert.equal((await fia.post(`/api/hubs/${hubId}/join-settings`, { open: true })).res.status, 200);
  });

  await t.test('a pending family is refused hub create, join, join request, and token mint', async () => {
    const pat = srv.client('10.9.3.1');
    assert.equal((await pat.post('/api/profile', family('Pending Pat', 'pending.pat@example.com'))).data.needs_email_code, true);
    note(srv.codeFor('pending.pat@example.com'));
    const token = (await fia.post(`/api/hubs/${hubId}/invites`, {})).data.token;
    const tries = [
      ['hub create', await pat.post('/api/hubs', { name: 'Pat’s Hub', kind: 'other' })],
      ['hub join', await pat.post(`/api/join/${token}/accept`, {})],
      ['join request', await pat.post(`/api/hubs/${hubId}/join-requests`, {})],
      ['token mint', await pat.post('/api/agent-tokens', { name: 'Helper' })],
    ];
    for (const [label, r] of tries) {
      assert.equal(r.res.status, 403, label + ': ' + r.text.slice(0, 200));
      assert.equal(r.data.needs_email_code, true, label);
      assert.equal(r.data.error, 'Confirm your email first — enter the 6-digit code we sent to pending.pat@example.com. Then you can create or join hubs.', label);
    }
    assert.equal((await pat.get(`/api/hubs/${hubId}`)).res.status, 403, 'not a member');
    assert.equal((await pat.get('/api/hubs')).data.hubs.filter((h) => !h.is_demo).length, 0, 'no hub was made');
  });

  await t.test('a wrong code says how many tries are left; the right one still works after', async () => {
    const wen = srv.client('10.9.4.1');
    await wen.post('/api/profile', family('Wrong Wen', 'wrong.wen@example.com'));
    const code = note(srv.codeFor('wrong.wen@example.com'));
    const w1 = await wen.post('/api/profile/verify-email', { code: otherCode(code) });
    assert.equal(w1.res.status, 400);
    assert.equal(w1.data.error, 'That code doesn’t match — 4 tries left.');
    assert.equal(w1.data.tries_left, 4);
    const w2 = await wen.post('/api/profile/verify-email', { code: '12' });
    assert.equal(w2.data.tries_left, 3, 'a malformed code counts too');
    assert.equal((await wen.get('/api/onboarding/status')).data.emailPending, true);
    const ok = await wen.post('/api/profile/verify-email', { code: code.slice(0, 3) + ' ' + code.slice(3) });
    assert.equal(ok.res.status, 200, 'spaces in a typed code are fine');
    assert.equal(ok.data.verified, true);
  });

  await t.test('a new code waits out the cooldown; a corrected address gets its own code', async () => {
    const tia = srv.client('10.9.5.1');
    await tia.post('/api/profile', family('Typo Tia', 'tia.typo@exmaple.com'));
    const oldCode = note(srv.codeFor('tia.typo@exmaple.com'));
    const soon = await tia.post('/api/profile/resend-code', {});
    assert.equal(soon.res.status, 429);
    assert.equal(soon.data.cooldown, true);
    assert.match(soon.data.error, /^A new code can be sent in \d+ seconds?\.$/);
    const moved = await tia.post('/api/profile/resend-code', { email: 'tia.typo@example.com' });
    assert.equal(moved.res.status, 200, moved.text.slice(0, 300));
    assert.equal(moved.data.email_verification.sent_to, 'tia.typo@example.com');
    assert.equal(moved.data.profile.parent_email, 'tia.typo@example.com');
    const newCode = note(srv.codeFor('tia.typo@example.com'));
    if (oldCode !== newCode) {
      const stale = await tia.post('/api/profile/verify-email', { code: oldCode });
      assert.equal(stale.res.status, 400, 'the old address’s code no longer counts');
    }
    const ok = await tia.post('/api/profile/verify-email', { code: newCode });
    assert.equal(ok.res.status, 200, ok.text.slice(0, 300));
  });

  await t.test('an email that already has a confirmed family is steered to sign-in or recovery', async () => {
    const dup = srv.client('10.9.6.1');
    const r = await dup.post('/api/profile', family('Second Sam', 'FIA.Founder@Example.com'));
    assert.equal(r.res.status, 409);
    assert.equal(r.data.email_has_family, true);
    assert.equal(r.data.error, 'This email already has a family. Sign in with Google, or get a recovery link sent to that address, to get back in.');
    assert.equal(r.data.recovery_available, true);
    const after = (await dup.get('/api/onboarding/status')).data;
    assert.ok(!after.hasActiveProfile || after.isDemo, 'no second family was made (still the demo)');
    assert.ok(!srv.mails().some((m) => m.to === 'FIA.Founder@Example.com'), 'no code went out');
    // A grandfathered family's address is protected the same way.
    const dup2 = srv.client('10.9.6.2');
    assert.equal((await dup2.post('/api/profile', family('Copy Cat', 'older.oakley@example.com'))).res.status, 409);
  });

  await t.test('a squatted pending signup never locks the real owner out', async () => {
    const squat = srv.client('10.9.7.1');
    const owner = srv.client('10.9.7.2');
    const s1 = await squat.post('/api/profile', family('Squat Sly', 'real.owner@example.com'));
    assert.equal(s1.data.needs_email_code, true);
    note(srv.codeFor('real.owner@example.com'));
    // The real owner signs up with the same address: a clean restart.
    const o1 = await owner.post('/api/profile', family('Real Rowan', 'real.owner@example.com'));
    assert.equal(o1.res.status, 200, o1.text.slice(0, 300));
    assert.equal(o1.data.needs_email_code, true);
    const ownerCode = note(srv.codeFor('real.owner@example.com'));
    assert.equal((await owner.post('/api/profile/verify-email', { code: ownerCode })).data.verified, true);
    assert.equal((await owner.post('/api/hubs', { name: 'Rowan’s Hub', kind: 'other' })).res.status, 200, 'the owner is fully in');
    // The squatter's pending family is left with nothing it can use.
    const late = await squat.post('/api/profile/verify-email', { code: ownerCode });
    assert.equal(late.res.status, 410, 'no live code for the squatter');
    assert.equal(late.data.can_resend, true);
    const again = await squat.post('/api/profile/resend-code', { email: 'real.owner@example.com' });
    assert.equal(again.res.status, 409);
    assert.equal(again.data.email_has_family, true);
    assert.equal((await squat.post('/api/hubs', { name: 'Sly Hub', kind: 'other' })).res.status, 403);
  });

  await t.test('the invite-join family setup carries the same gate', async () => {
    const token = (await fia.post(`/api/hubs/${hubId}/invites`, {})).data.token;
    const robin = srv.client('10.9.8.1');
    const first = await robin.post(`/api/join/${token}/accept`, {});
    assert.equal(first.res.status, 409);
    assert.equal(first.data.needs_account_choice, true);
    const made = await robin.post('/api/profile', family('Robin Reyes', 'robin.reyes@example.com'));
    assert.equal(made.data.needs_email_code, true);
    const blocked = await robin.post(`/api/join/${token}/accept`, {});
    assert.equal(blocked.res.status, 403, 'the saved invite waits for the code');
    assert.equal(blocked.data.needs_email_code, true);
    assert.equal((await robin.get(`/api/hubs/${hubId}`)).res.status, 403);
    const code = note(srv.codeFor('robin.reyes@example.com'));
    assert.equal((await robin.post('/api/profile/verify-email', { code })).data.verified, true);
    const joined = await robin.post(`/api/join/${token}/accept`, {});
    assert.equal(joined.res.status, 200, joined.text.slice(0, 300));
    assert.equal(joined.data.membership, 'member');
  });

  await t.test('sends are rate-limited per address', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const r = await srv.client('10.9.9.' + i).post('/api/profile', family('Limit Lee ' + i, 'limit.lee@example.com'));
      assert.equal(r.res.status, 200, 'send ' + i + ': ' + r.text.slice(0, 200));
    }
    const sixth = await srv.client('10.9.9.6').post('/api/profile', family('Limit Lee 6', 'limit.lee@example.com'));
    assert.equal(sixth.res.status, 429);
    assert.equal(sixth.data.rate_limited, true);
    const sixthStatus = (await srv.client('10.9.9.6').get('/api/onboarding/status')).data;
    assert.ok(!sixthStatus.hasActiveProfile || sixthStatus.isDemo, 'no family was made');
    for (const code of srv.mails().filter((m) => m.to === 'limit.lee@example.com').map((m) => m.subject.match(/(\d{6})/)[1])) note(code);
  });

  await t.test('sends are rate-limited per client address too', async () => {
    const one = srv.client('10.9.10.1');
    let status = 0;
    for (let i = 1; i <= 11 && status !== 429; i += 1) {
      status = (await one.post('/api/profile', family('Ip Ivy ' + i, `ip.ivy${i}@example.com`))).res.status;
    }
    assert.equal(status, 429, 'one address can’t send without limit');
    for (const m of srv.mails().filter((x) => /^ip\.ivy/.test(x.to))) note(m.subject.match(/(\d{6})/)[1]);
  });

  await t.test('a Google-proven address skips the code', async () => {
    const gus = srv.client('10.9.11.1');
    const signed = await gus.post('/api/auth/test-complete', { sub: 'sub-google-gus', email: 'google.gus@example.com', email_verified: true });
    assert.equal(signed.res.status, 200, signed.text.slice(0, 200));
    const made = await gus.post('/api/profile', family('Google Gus', 'Google.Gus@example.com'));
    assert.equal(made.res.status, 200, made.text.slice(0, 300));
    assert.ok(!made.data.needs_email_code, 'Google already proved this address');
    assert.equal(made.data.profile.email_pending, false);
    assert.equal((await gus.post('/api/hubs', { name: 'Gus Hub', kind: 'other' })).res.status, 200);
    // A Google email that Google did not mark verified proves nothing.
    const una = srv.client('10.9.11.2');
    await una.post('/api/auth/test-complete', { sub: 'sub-google-una', email: 'unverified.una@example.com' });
    const unaMade = await una.post('/api/profile', family('Unverified Una', 'unverified.una@example.com'));
    assert.equal(unaMade.data.needs_email_code, true);
    note(srv.codeFor('unverified.una@example.com'));
  });

  await t.test('a pending signup is never offered to a Google sign-in as "your family"', async () => {
    const sly = srv.client('10.9.15.1');
    assert.equal((await sly.post('/api/profile', family('Squat Sly', 'offer.owner@example.com'))).data.needs_email_code, true);
    note(srv.codeFor('offer.owner@example.com'));
    const owner = srv.client('10.9.15.2');
    await owner.post('/api/auth/test-complete', { sub: 'sub-offer-owner', email: 'offer.owner@example.com', email_verified: true });
    const status = await owner.get('/api/onboarding/status');
    assert.ok(!(status.data.link_offer && status.data.link_offer.families && status.data.link_offer.families.length),
      'the squatter’s pending family is not offered');
  });

  await t.test('older families and the demo are unaffected', async () => {
    const withCookie = makeClient(srv.base, '10.9.12.1');
    // The seeded older family's own session.
    const res = await fetch(`${srv.base}/api/onboarding/status`, { headers: { Cookie: 'parentloop_session=' + oldFamilySession, 'X-Forwarded-For': '10.9.12.1' } });
    const status = await res.json();
    assert.equal(status.hasActiveProfile, true);
    assert.equal(status.emailPending, false, 'grandfathered as verified');
    const made = await fetch(`${srv.base}/api/hubs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'parentloop_session=' + oldFamilySession, 'X-Forwarded-For': '10.9.12.1' },
      body: JSON.stringify({ name: 'Older Oak Hub', kind: 'other' }),
    });
    assert.equal(made.status, 200, 'an older family keeps full use');
    const demo = await withCookie.get('/api/onboarding/status');
    assert.equal(demo.data.emailPending, false);
    const hubs = await withCookie.get('/api/hubs');
    assert.equal(hubs.res.status, 200);
    assert.ok((hubs.data.hubs || []).some((h) => h.is_demo), 'the demo family still sees its hubs');
  });

  await t.test('recovery never mails a pending signup', async () => {
    const before = srv.mails().length;
    const r = await srv.client('10.9.13.1').post('/api/recovery/request', { email: 'pending.pat@example.com' });
    assert.equal(r.res.status, 200);
    assert.equal(srv.mails().length, before, 'no recovery link for an unconfirmed address');
  });

  await t.test('the agent guide says a code step is expected, not an error', async () => {
    const guide = await srv.client('10.9.14.1').get('/api/agent');
    assert.match(guide.text, /6-digit code to confirm their address \(needs_email_code\) — that is an expected step, not an error/);
  });

  await t.test('no code ever appears in the server log', async () => {
    assert.ok(sentCodes.length >= 10, 'codes were sent');
    const log = srv.output();
    for (const code of sentCodes) assert.ok(!log.includes(code), 'code not logged');
  });
});

test('signup codes expire, and too many wrong tries need a new code', { timeout: 60000 }, async (t) => {
  const srv = await startServer(t, SHORT_PORT, { PARENTLOOP_TEST_SIGNUP_CODE_TTL_MS: '1500', PARENTLOOP_TEST_SIGNUP_RESEND_COOLDOWN_MS: '0' });

  await t.test('an expired code is refused with a way to send a new one', async () => {
    const eli = srv.client('10.8.1.1');
    await eli.post('/api/profile', family('Expired Eli', 'expired.eli@example.com'));
    const code = srv.codeFor('expired.eli@example.com');
    await new Promise((r) => setTimeout(r, 1700));
    const late = await eli.post('/api/profile/verify-email', { code });
    assert.equal(late.res.status, 410);
    assert.equal(late.data.expired, true);
    assert.equal(late.data.can_resend, true);
    assert.equal(late.data.error, 'That code has expired — codes last 15 minutes. Send a new code.');
    const again = await eli.post('/api/profile/resend-code', {});
    assert.equal(again.res.status, 200, again.text.slice(0, 300));
    const fresh = srv.codeFor('expired.eli@example.com');
    const ok = await eli.post('/api/profile/verify-email', { code: fresh });
    assert.equal(ok.res.status, 200, ok.text.slice(0, 300));
  });

  await t.test('five wrong tries end that code; a new code works', async () => {
    const max = srv.client('10.8.2.1');
    await max.post('/api/profile', family('Many Max', 'many.max@example.com'));
    const code = srv.codeFor('many.max@example.com');
    const lefts = [];
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await max.post('/api/profile/verify-email', { code: otherCode(code) });
      lefts.push(last.data.tries_left);
    }
    assert.deepEqual(lefts.slice(0, 4), [4, 3, 2, 1]);
    assert.equal(last.res.status, 429);
    assert.equal(last.data.too_many, true);
    assert.equal(last.data.can_resend, true);
    assert.equal(last.data.error, 'Too many wrong tries for that code. Send a new code and try again.');
    const dead = await max.post('/api/profile/verify-email', { code });
    assert.equal(dead.res.status, 429, 'even the right code is spent');
    assert.equal((await max.post('/api/profile/resend-code', {})).res.status, 200);
    const ok = await max.post('/api/profile/verify-email', { code: srv.codeFor('many.max@example.com') });
    assert.equal(ok.res.status, 200, ok.text.slice(0, 300));
  });
});
