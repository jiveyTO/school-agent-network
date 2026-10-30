const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 36200 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let tmpDir = null;

async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/onboarding/status`);
      if (res.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

async function jf(urlPath, options) {
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

function post(urlPath, body) {
  return jf(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

test('school demo strip is hidden from real non-demo profiles', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-audience-test-'));
  const dbPath = path.join(tmpDir, 'app.db');

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

  // Anonymous visitors still get the demo feed.
  const anonNewsletter = await jf('/api/newsletter');
  const anonFacts = await jf('/api/facts');
  assert.ok(anonNewsletter.data.text.length > 0);
  assert.ok(anonFacts.data.facts.length > 0);

  // A real profile sees no demo feed and cannot rewrite it through /api/run.
  await post('/api/profile', {
    parent_name: 'Audience Parent',
    child_name: 'Audience Child',
    grade: 'Grade 3',
    class_name: '3A',
    school_name: 'Maple Grove Elementary',
    priorities: [],
    nudge_style: 'one short message in the evening',
  });
  const realNewsletter = await jf('/api/newsletter');
  const realFacts = await jf('/api/facts');
  assert.equal(realNewsletter.data.text, '');
  assert.deepEqual(realFacts.data.facts, []);
  const blockedRun = await post('/api/run', {});
  assert.equal(blockedRun.res.status, 500);
  assert.match(blockedRun.data.error, /demo family/i);

  // Returning to the demo family restores the demo feed.
  await post('/api/profile/demo', {});
  const demoNewsletter = await jf('/api/newsletter');
  const demoFacts = await jf('/api/facts');
  assert.ok(demoNewsletter.data.text.length > 0);
  assert.ok(demoFacts.data.facts.length > 0);
});
