const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 37800 + (process.pid % 60);
const STUB_PORT = PORT + 61;
const BASE = `http://127.0.0.1:${PORT}`;
const GCS_ENDPOINT = `http://127.0.0.1:${STUB_PORT}`;

// Brief 036: a failed restore must never let a fresh seed overwrite the live
// database. These tests run the real server against a generation-aware GCS
// stub. Fictional fixtures only (Cedar Valley). Nothing here comes from a
// real family or newsletter.

let stub = null;
let tmpDir = null;
let child = null;

// Simulated live object: null when it does not exist yet.
let stored = null; // { bytes: Buffer, generation: string }
let genCounter = 0;
let downloadMode = 'ok'; // 'ok' | 'fail500'
let attempts = []; // { ifGenerationMatch: string|null, accepted: boolean }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function objectPathname() {
  return '/storage/v1/b/durable-guard-bucket/o/durable-guard.db';
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

function spawnServer(dbPath) {
  let stdout = '';
  let stderr = '';
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: dbPath,
      APP_DB_GCS_BUCKET: 'durable-guard-bucket',
      APP_DB_GCS_OBJECT: 'durable-guard.db',
      APP_DB_GCS_ENDPOINT: GCS_ENDPOINT,
      SCHOOL_AGENT_API_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => {
    stdout += String(c);
    if (stdout.length > 1048576) stdout = stdout.slice(-1048576);
  });
  proc.stderr.on('data', (c) => {
    stderr += String(c);
    if (stderr.length > 1048576) stderr = stderr.slice(-1048576);
  });
  proc.logs = () => stdout + '\n' + stderr;
  return proc;
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

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Timed out waiting for: ' + what);
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
    return { res, data, text };
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
  };
}

async function createFamily(client, parentName, childName) {
  const res = await client.post('/api/profile', {
    parent_name: parentName,
    children: [{ name: childName }],
  });
  assert.equal(res.res.status, 200, res.text.slice(0, 300));
}

test('durable restore guard: seed can never clobber the stored object', { timeout: 180000 }, async (t) => {
  stub = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === objectPathname()) {
      if (url.searchParams.get('alt') === 'media') {
        if (downloadMode === 'fail500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        if (!stored) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'x-goog-generation': stored.generation,
        });
        res.end(stored.bytes);
        return;
      }
      // Object metadata.
      if (downloadMode === 'fail500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (!stored) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ generation: stored.generation, size: stored.bytes.length }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/upload/storage/v1/b/durable-guard-bucket/o') {
      const body = await readBody(req);
      const want = url.searchParams.get('ifGenerationMatch');
      const current = stored ? stored.generation : null;
      const expected = current == null ? '0' : current;
      if (want !== null && want !== expected) {
        attempts.push({ ifGenerationMatch: want, accepted: false });
        res.writeHead(412, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'precondition failed' }));
        return;
      }
      genCounter += 1;
      stored = { bytes: body, generation: String(genCounter) };
      attempts.push({ ifGenerationMatch: want, accepted: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ generation: stored.generation }));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  t.after(async () => {
    await stopServer(child);
    child = null;
    if (stub) await new Promise((resolve) => stub.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-guard-'));

  await t.test('restore-failure boot never uploads (and says so loudly)', async () => {
    downloadMode = 'fail500';
    stored = null;
    attempts = [];
    const dbPath = path.join(tmpDir, 'fail-boot.db');
    child = spawnServer(dbPath);
    await waitForServer();

    const logs = child.logs();
    assert.match(logs, /DURABLE STORE RESTORE FAILED/, 'boot logs the restore failure');
    assert.match(logs, /WRITE-BACK DISABLED/, 'boot logs that write-back is disabled');

    // Writes happen locally (a fresh seed serves traffic) but must never
    // reach the (broken-from-here) durable object.
    await createFamily(makeClient(), 'Cedar Mom', 'Cedar Kid');
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(attempts.filter((a) => a.accepted).length, 0, 'no successful upload while restore failed');

    await stopServer(child);
    child = null;
    assert.equal(attempts.filter((a) => a.accepted).length, 0, 'shutdown flush does not upload either');
    assert.equal(stored, null, 'nothing was stored');
  });

  await t.test('seed-vs-nonempty-object write-back is refused, stored bytes untouched', async () => {
    // Phase 1: a healthy boot stores a REAL family database.
    downloadMode = 'ok';
    stored = null;
    attempts = [];
    const goodPath = path.join(tmpDir, 'good.db');
    child = spawnServer(goodPath);
    await waitForServer();
    await createFamily(makeClient(), 'Cedar Real', 'Real Kid');
    await waitFor(() => attempts.some((a) => a.accepted), 20000, 'healthy boot uploads');
    await stopServer(child);
    child = null;
    const realBytes = Buffer.from(stored.bytes);
    assert.ok(realBytes.length > 0, 'the stored object holds a real database');

    // Phase 2: the object still holds real data, but downloads now fail and
    // the local disk is gone — the boot falls back to a seed.
    downloadMode = 'fail500';
    attempts = [];
    const seedPath = path.join(tmpDir, 'seed.db');
    child = spawnServer(seedPath);
    await waitForServer();
    const logs = child.logs();
    assert.match(logs, /DURABLE STORE RESTORE FAILED/, 'boot logs the restore failure');

    const fresh = makeClient();
    const status = await fresh.get('/api/onboarding/status');
    assert.equal(status.data.profile.parent.name, 'Alex Rivera', 'the fallback serves the demo seed family');

    await createFamily(makeClient(), 'Cedar New', 'New Kid');
    await new Promise((r) => setTimeout(r, 3500));
    await stopServer(child);
    child = null;

    assert.equal(attempts.filter((a) => a.accepted).length, 0, 'the seed was never written back');
    assert.ok(stored && Buffer.from(stored.bytes).equals(realBytes), 'the stored real database is byte-identical');
  });

  await t.test('generation mismatch refuses a stale upload; clean restore still writes back', async () => {
    downloadMode = 'ok';
    stored = null;
    attempts = [];
    genCounter = 0;
    const dbPath = path.join(tmpDir, 'gen.db');
    child = spawnServer(dbPath);
    await waitForServer();

    // First boot seeds the object create-only (this upload happens during
    // initDb, before the server listens).
    await waitFor(() => attempts.some((a) => a.accepted), 20000, 'first upload creates the object');
    assert.equal(attempts[0].ifGenerationMatch, '0', 'first-boot upload is create-only');
    const genAfterBoot = stored.generation;

    // A normal write-back carries the known generation and succeeds.
    await createFamily(makeClient(), 'Cedar One', 'Kid One');
    await waitFor(() => attempts.filter((a) => a.accepted).length >= 2, 20000, 'restored upload succeeds');
    const afterOne = attempts.filter((a) => a.accepted);
    assert.equal(afterOne[1].ifGenerationMatch, genAfterBoot, 'restored upload carries the generation it restored');
    const genAfterOne = stored.generation;
    assert.notEqual(genAfterOne, genAfterBoot, 'the stored object moves to the next generation');

    await createFamily(makeClient(), 'Cedar Two', 'Kid Two');
    await waitFor(
      () => attempts.filter((a) => a.accepted).length >= 3,
      20000,
      'a further restored upload succeeds'
    );
    const bytesBeforeStale = Buffer.from(stored.bytes);
    const acceptedBeforeStale = attempts.filter((a) => a.accepted).length;

    // A newer writer replaces the object out from under this instance.
    stored = { bytes: bytesBeforeStale, generation: '999' };

    await createFamily(makeClient(), 'Cedar Stale', 'Stale Kid');
    await new Promise((r) => setTimeout(r, 3500));
    const refused = attempts.filter((a) => !a.accepted);
    assert.ok(refused.length >= 1, 'the stale upload attempt hits the precondition');
    assert.equal(
      attempts.filter((a) => a.accepted).length,
      acceptedBeforeStale,
      'no further upload succeeds after the 412'
    );
    assert.ok(Buffer.from(stored.bytes).equals(bytesBeforeStale), 'the newer stored bytes survive');
    assert.match(child.logs(), /WRITE-BACK REFUSED/, 'the refusal is logged loudly');

    await stopServer(child);
    child = null;
    assert.ok(Buffer.from(stored.bytes).equals(bytesBeforeStale), 'shutdown does not clobber the newer object');
  });
});
