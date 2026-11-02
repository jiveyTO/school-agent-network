const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 040: email is mandatory at family setup. Setup rejects a missing or
// invalid email with an inline error and creates no profile; a valid email
// is stored on the profile and editable on My family; pre-existing
// no-email families keep using the app and are prompted to add one; the
// demo family is exempt. Fixtures are fictional. No real data.

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PORT = 37200 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

test('setup form and My family carry the email fields; demo has none', () => {
  assert.ok(PAGE.includes('id="obParentEmail"'), 'setup gains a parent email field');
  assert.ok(PAGE.includes('id="obEmailError"'), 'setup has an inline email error line');
  assert.ok(PAGE.includes("parent_email: obEmail"), 'setup submits parent_email');
  assert.ok(PAGE.includes('id="familyEmailBox"'), 'My family shows the email editor');
  assert.ok(PAGE.includes('id="familyEmailInput"'), 'My family email input exists');
  assert.ok(PAGE.includes('id="familyEmailPrompt"'), 'My family add-email prompt exists');
  assert.ok(PAGE.includes('needsFamilyEmail'), 'prompt is driven by a missing email');
  assert.ok(PAGE.includes("profile.is_demo"), 'demo exemption is checked');
});

test('family email: mandatory at setup, editable, legacy families unblocked', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-family-email-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();
  // A pre-existing family from before this brief: no email on file.
  const legacy = db.createProfile({
    parent_name: 'Legacy Lou',
    children: [{ name: 'Lou Junior' }],
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  assert.equal(legacy.parent.email, '', 'legacy fixture starts with no email');
  db.setLegacyActiveProfile(legacy.id);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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

  // The legacy family is adopted by the first session the server mints, so
  // readiness polling goes through this client's cookie jar.
  const lou = makeClient();
  {
    const deadline = Date.now() + 20000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await lou.get('/api/onboarding/status');
        if (res.res.ok) { up = true; break; }
      } catch {
        // Server is still starting.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, 'Test server did not start.');
  }

  await t.test('pre-existing no-email family is not blocked and is prompted', async () => {
    const status = await lou.get('/api/onboarding/status');
    assert.equal(status.data.profile.parent.name, 'Legacy Lou', 'legacy session adopts its family');
    assert.equal(status.data.isDemo, false);
    assert.equal(status.data.needsOnboarding, false, 'not sent back to setup');
    assert.equal(status.data.needsEmail, true, 'add-email prompt applies');
    const fam = await lou.get('/api/family-profile');
    assert.equal(fam.data.profile.parent.email, '');
    // Still fully usable: hubs load, and adding the email works from My family.
    const hubs = await lou.get('/api/hubs');
    assert.equal(hubs.res.status, 200);
    const added = await lou.post('/api/profile/update', { parent_email: 'legacy.lou@example.com' });
    assert.equal(added.res.status, 200, added.text.slice(0, 300));
    assert.equal(added.data.profile.parent.email, 'legacy.lou@example.com');
    const after = await lou.get('/api/onboarding/status');
    assert.equal(after.data.needsEmail, false, 'prompt clears once an email is on file');
  });

  await t.test('setup with no email is rejected and creates no profile', async () => {
    const visitor = makeClient();
    const res = await visitor.post('/api/profile', {
      parent_name: 'No Email Ned',
      children: [{ name: 'Ned Junior' }],
    });
    assert.equal(res.res.status, 400);
    assert.match(res.data.error, /email/i);
    const status = await visitor.get('/api/onboarding/status');
    assert.equal(status.data.needsOnboarding, true, 'no family was created');
    assert.notEqual(status.data.profile && status.data.profile.parent.name, 'No Email Ned');
  });

  await t.test('setup with an invalid email is rejected and creates no profile', async () => {
    const visitor = makeClient();
    for (const bad of ['not-an-email', 'ned@', 'ned@example', 'ned @example.com', '']) {
      const res = await visitor.post('/api/profile', {
        parent_name: 'Bad Email Bea',
        parent_email: bad,
        children: [{ name: 'Bea Junior' }],
      });
      assert.equal(res.res.status, 400, `email ${JSON.stringify(bad)} rejected`);
      assert.match(res.data.error, /email/i);
    }
    const status = await visitor.get('/api/onboarding/status');
    assert.equal(status.data.needsOnboarding, true, 'still no family after invalid attempts');
  });

  await t.test('valid email is saved on the profile; duplicates are allowed', async () => {
    const first = makeClient();
    const created = await first.post('/api/profile', {
      parent_name: 'Valid Val',
      parent_email: 'valid.val@example.com',
      children: [{ name: 'Val Junior' }],
    });
    assert.equal(created.res.status, 200, created.text.slice(0, 300));
    assert.equal(created.data.profile.parent.email, 'valid.val@example.com');
    assert.equal(created.data.profile.parent_email, 'valid.val@example.com');
    const readBack = await first.get('/api/family-profile');
    assert.equal(readBack.data.profile.parent.email, 'valid.val@example.com');

    const second = makeClient();
    const dup = await second.post('/api/profile', {
      parent_name: 'Other Olga',
      parent_email: 'valid.val@example.com',
      children: [{ name: 'Olga Junior' }],
    });
    assert.equal(dup.res.status, 200, 'same email on another family is fine — not an identity key');
    assert.notEqual(dup.data.profile.id, created.data.profile.id);
  });

  await t.test('My family edit updates the email; a bad edit changes nothing', async () => {
    const fam = makeClient();
    const created = await fam.post('/api/profile', {
      parent_name: 'Edit Ed',
      parent_email: 'typo.ed@example.com',
      children: [{ name: 'Ed Junior' }],
    });
    assert.equal(created.res.status, 200);
    const fixed = await fam.post('/api/profile/update', {
      parent_name: 'Edit Ed',
      parent_email: 'edit.ed@example.com',
      children: created.data.profile.children.map((c) => ({ id: c.id, name: c.name })),
    });
    assert.equal(fixed.res.status, 200, fixed.text.slice(0, 300));
    assert.equal(fixed.data.profile.parent.email, 'edit.ed@example.com');
    const bad = await fam.post('/api/profile/update', { parent_email: 'still-not-an-email' });
    assert.equal(bad.res.status, 400);
    assert.match(bad.data.error, /email/i);
    const readBack = await fam.get('/api/family-profile');
    assert.equal(readBack.data.profile.parent.email, 'edit.ed@example.com', 'bad edit left the saved email alone');
  });

  await t.test('demo family is untouched: no email, evening check unchanged', async () => {
    const demo = makeClient();
    const joined = await demo.post('/api/profile/demo', {});
    assert.equal(joined.res.status, 200);
    assert.equal(joined.data.profile.is_demo, true);
    assert.equal(joined.data.profile.parent.email, '', 'demo carries no email');
    const status = await demo.get('/api/onboarding/status');
    assert.equal(status.data.needsEmail, false, 'demo is never prompted');
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
