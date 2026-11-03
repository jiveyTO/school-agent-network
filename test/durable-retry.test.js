// A failed durable-store upload retries with backoff instead of waiting for
// the next write, and an upload whose reply was lost but which had landed
// is recognised by its MD5 (so its retry's HTTP 412 does not disable
// write-back). A 412 caused by a different writer still disables it. A
// restored database that boot leaves unchanged is not uploaded at boot.
// Real server.js against a generation-aware GCS stub; the retry base delay
// is shortened through the test-only APP_DB_GCS_RETRY_BASE_MS.
// Fictional fixtures only (Cedar Valley). No real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 40300 + (process.pid % 90);
const STUB_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const OBJECT_PATH = '/storage/v1/b/retry-test-bucket/o/retry-test.db';
const UPLOAD_PATH = '/upload/storage/v1/b/retry-test-bucket/o';

// Stub state, reset per scenario. firstUpload decides what the first upload
// attempt does: 'fail' (HTTP 503), 'landed' (stores the bytes, then drops
// the connection), 'other-writer' (stores someone else's bytes, then drops
// the connection), or 'ok' (a normal upload).
let stored = null; // { bytes, generation }
let attempts = 0;
let firstUpload = 'fail';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function md5(bytes) {
  return crypto.createHash('md5').update(bytes).digest('base64');
}

function startStub() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === OBJECT_PATH) {
      if (!stored) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url.searchParams.get('alt') === 'media') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(stored.bytes);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        generation: String(stored.generation),
        size: String(stored.bytes.length),
        md5Hash: md5(stored.bytes),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === UPLOAD_PATH) {
      const bytes = await readBody(req);
      attempts += 1;
      if (attempts === 1 && firstUpload === 'fail') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (attempts === 1 && (firstUpload === 'landed' || firstUpload === 'other-writer')) {
        const landed = firstUpload === 'landed' ? bytes : Buffer.from('SQLite format 3\0other writer');
        stored = { bytes: landed, generation: (stored ? stored.generation : 0) + 1 };
        req.socket.destroy();
        return;
      }
      const match = url.searchParams.get('ifGenerationMatch');
      const current = stored ? stored.generation : 0;
      if (match != null && Number(match) !== current) {
        res.writeHead(412, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      stored = { bytes, generation: current + 1 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ generation: String(stored.generation) }));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

function spawnServer(dbPath) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: dbPath,
      APP_DB_GCS_BUCKET: 'retry-test-bucket',
      APP_DB_GCS_OBJECT: 'retry-test.db',
      APP_DB_GCS_ENDPOINT: `http://127.0.0.1:${STUB_PORT}`,
      APP_DB_GCS_RETRY_BASE_MS: '200',
    },
    stdio: 'ignore',
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 15000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function waitFor(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for ' + label);
}

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

// Waits for the port without an HTTP request: a request without a cookie
// creates a session, which is a real write and would trigger an upload.
async function waitForPort() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

async function addFamily(parentName) {
  const res = await fetch(`${BASE}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent_name: parentName,
      parent_email: 'cedar.family@example.com',
      children: [{ name: 'Cedar' }],
      priorities: [],
      nudge_style: 'one short message in the evening',
      actions: {},
    }),
  });
  assert.equal(res.status, 200);
}

async function scenario(t, mode, body) {
  stored = null;
  attempts = 0;
  firstUpload = mode;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-durable-retry-'));
  const child = spawnServer(path.join(tmpDir, 'app.db'));
  try {
    await body();
  } finally {
    await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('durable store retries failed uploads', { timeout: 120000 }, async (t) => {
  const stub = await startStub();
  t.after(() => new Promise((resolve) => stub.close(resolve)));

  await t.test('a failed boot upload is retried without another write', async () => {
    await scenario(t, 'fail', async () => {
      // No request is sent to the app: the only write is the boot's seed.
      await waitFor(() => stored !== null, 'the retried upload');
      assert.ok(attempts >= 2, 'first attempt failed, a retry landed');
      assert.equal(stored.bytes.slice(0, 15).toString(), 'SQLite format 3');
    });
  });

  await t.test('an upload that landed but lost its reply keeps write-back on', async () => {
    await scenario(t, 'landed', async () => {
      await waitFor(() => stored !== null && attempts >= 3, 'retry after the lost reply');
      await waitForServer();
      await addFamily('Retry Rowan');
      await waitFor(() => stored.bytes.includes('Retry Rowan'), 'the next write to upload');
    });
  });

  await t.test('a 412 from a different writer still disables write-back', async () => {
    await scenario(t, 'other-writer', async () => {
      await waitFor(() => stored !== null && attempts >= 2, 'retry after the lost reply');
      await waitForServer();
      const before = attempts;
      await addFamily('Refused Riley');
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(attempts, before, 'no further uploads once write-back is disabled');
      assert.ok(!stored.bytes.includes('Refused Riley'), "the other writer's object is untouched");
    });
  });

  await t.test('a restored, unchanged database is not uploaded at boot', async () => {
    // First boot seeds and uploads (no stored object yet).
    await scenario(t, 'ok', async () => {
      await waitFor(() => stored !== null, 'the seed upload');
    });
    const seeded = stored;
    const before = attempts;
    // Second boot on an empty local disk restores that object. Boot must
    // leave it unchanged (zero row changes), so nothing is uploaded and the
    // stored generation stays put for whichever instance writes next.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-durable-boot-'));
    const child = spawnServer(path.join(tmpDir, 'app.db'));
    try {
      await waitForPort();
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(attempts, before, 'no upload at boot');
      assert.equal(stored, seeded, 'stored object untouched by boot');
      await addFamily('Boot Bailey');
      await waitFor(() => stored.bytes.includes('Boot Bailey'), 'the first real write to upload');
      assert.equal(stored.generation, seeded.generation + 1, 'uploaded on the restored generation');
    } finally {
      await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
