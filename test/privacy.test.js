const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 076: the public privacy policy page (OAuth branding requirement).
// GET /privacy serves the policy with no sign-in; the app footer links it.

const ROOT = path.join(__dirname, '..');
const PORT = 34400 + (process.pid % 800);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

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

test('privacy page is public and carries the policy heading', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-privacy-'));
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

  await t.test('GET /privacy returns 200 without sign-in', async () => {
    const res = await fetch(`${BASE}/privacy`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('ParentLoop Privacy Policy'), 'policy heading present');
    assert.ok(html.includes('Last updated: November 4, 2026'), 'policy date present');
  });
});

test('app footer links the privacy page', () => {
  assert.ok(PAGE.includes('<a href="/privacy">Privacy</a>'), 'footer links /privacy');
  assert.ok(PAGE.includes('ParentLoop — you’re always in the loop.'), 'footer tagline unchanged');
});
