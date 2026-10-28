const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 34000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;
const PORTAL_SECRET = 'TEST_PORTAL_SECRET_123';
const FAKE_ACCESS = 'FAKE_ACCESS_TOKEN_XYZ';
const FAKE_REFRESH = 'FAKE_REFRESH_TOKEN_XYZ';

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

async function jsonFetch(urlPath, options) {
  const res = await fetch(`${BASE}${urlPath}`, options || {});
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { res, data, text };
}

test('onboarding, sources, Gmail safety, and demo flow', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-agent-test-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;

  // Seed stored Gmail tokens before the server starts, to prove they never leak.
  const db = require('../db');
  await db.initDb();
  const seeded = db.createProfile({
    parent_name: 'Token Parent',
    child_name: 'Token Child',
    grade: 'Grade 3',
    class_name: '3B',
    school_name: 'Maple Grove Elementary',
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  db.saveGmailTokens(seeded.id, {
    email: 'parent@example.test',
    access_token: FAKE_ACCESS,
    refresh_token: FAKE_REFRESH,
    expires_at: Date.now() + 3600 * 1000,
  });

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: dbPath,
      PUBLIC_BASE_URL: 'http://example.test',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await t.test('profile create → read-back round trip', async () => {
    const created = await jsonFetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_name: 'Jordan Lee',
        child_name: 'Sam Lee',
        grade: 'Grade 3',
        class_name: '3A',
        school_name: 'Maple Grove Elementary',
        priorities: ['never miss a food-order deadline'],
        nudge_style: 'one short message in the evening',
      }),
    });
    assert.equal(created.res.status, 200);
    assert.equal(created.data.profile.parent.name, 'Jordan Lee');
    const readBack = await jsonFetch('/api/family-profile');
    assert.equal(readBack.data.profile.parent.name, 'Jordan Lee');
    assert.equal(readBack.data.profile.child.name, 'Sam Lee');
    assert.equal(readBack.data.profile.child.grade, 'Grade 3');
    const status = await jsonFetch('/api/onboarding/status');
    assert.equal(status.data.hasActiveProfile, true);
    assert.equal(status.data.isDemo, false);
  });

  await t.test("a saved source's secret never appears in any API response", async () => {
    const saved = await jsonFetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'schoolmessenger',
        label: 'SchoolMessenger',
        url: 'https://example.test/messenger',
        username: 'jordan',
        password: PORTAL_SECRET,
      }),
    });
    assert.equal(saved.res.status, 200);
    assert.ok(!saved.text.includes(PORTAL_SECRET));
    assert.equal(saved.data.source.username, 'jordan');
    assert.ok(!('secret' in saved.data.source));
    assert.ok(!('password' in saved.data.source));
    const list = await jsonFetch('/api/sources');
    assert.ok(!list.text.includes(PORTAL_SECRET));
    const status = await jsonFetch('/api/onboarding/status');
    assert.ok(!status.text.includes(PORTAL_SECRET));
  });

  await t.test('OAuth auth URL requests exactly the gmail.readonly scope', async () => {
    const res = await fetch(`${BASE}/api/email/auth`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(location.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(location.searchParams.get('access_type'), 'offline');
    assert.equal(location.searchParams.get('prompt'), 'consent');
    assert.equal(location.searchParams.get('redirect_uri'), 'http://example.test/api/email/callback');
  });

  await t.test('stored tokens never appear in any API response', async () => {
    // Token Parent was active at seed time; creating Jordan changed the active
    // profile, so check the status/source/profile surfaces for token leakage.
    for (const urlPath of ['/api/email/status', '/api/sources', '/api/family-profile', '/api/onboarding/status']) {
      const out = await jsonFetch(urlPath);
      assert.ok(!out.text.includes(FAKE_ACCESS), urlPath);
      assert.ok(!out.text.includes(FAKE_REFRESH), urlPath);
    }
    const status = await jsonFetch('/api/email/status');
    assert.deepEqual(Object.keys(status.data).sort(), [
      'configured',
      'connected',
      'email',
      'setupNeeded',
      'setup_needed',
    ]);
  });

  await t.test('demo profile seeds and the demo evening check still works', async () => {
    const demo = await jsonFetch('/api/profile/demo', { method: 'POST' });
    assert.equal(demo.res.status, 200);
    assert.equal(demo.data.profile.parent.name, 'Alex Rivera');
    assert.equal(demo.data.profile.child.name, 'Maya Rivera');
    assert.equal(demo.data.profile.is_demo, true);
    const run = await jsonFetch('/api/parent/run', { method: 'POST' });
    assert.equal(run.res.status, 200, run.text.slice(0, 500));
    const titles = (run.data.nudges || []).map((n) => n.title.toLowerCase());
    assert.ok(titles.some((x) => x.includes('pizza')), titles.join(', '));
    assert.ok(titles.some((x) => x.includes('uniform')), titles.join(', '));
    assert.equal(run.data.calendar_hold.date, '2026-11-06');
    assert.match(run.data.calendar_hold.title.toLowerCase(), /pizza/);
    const lastLog = run.data.logs[run.data.logs.length - 1].message;
    assert.ok(lastLog.startsWith('PRIVACY CHECK: family profile data used only inside this Parent Agent run'));
  });
});

test('privacy and deploy files carry the required entries', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^data\/app\.db$/m);
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(envExample, /^GOOGLE_CLIENT_ID=$/m);
  assert.match(envExample, /^GOOGLE_CLIENT_SECRET=$/m);
  assert.match(envExample, /^PUBLIC_BASE_URL=$/m);
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^data\/sample-newsletter\.txt$/m);
});
