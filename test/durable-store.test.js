const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 37200 + (process.pid % 60);
const STUB_PORT = PORT + 61;
const BASE = `http://127.0.0.1:${PORT}`;
const GCS_ENDPOINT = `http://127.0.0.1:${STUB_PORT}`;

// Fictional fixtures only (Cedar Valley). Nothing here comes from a real
// school newsletter.

// The durable store (db.js, env-gated by APP_DB_GCS_BUCKET) must survive an
// instance replacement: everything written through one server boot has to be
// there after the local database file is lost and a fresh server boots.
const NOTE_TEXT = 'Cedar Valley Elementary notice: the bake sale is Saturday, November 7.';
const FACT_JSON = JSON.stringify([
  {
    id: 'fact-durable-note-1',
    type: 'announcement',
    title: 'Cedar Valley bake sale',
    detail: 'The school bake sale is Saturday, November 7.',
    date: '2026-11-07',
    time: '',
    applies_to: 'all students',
    action_required: false,
    action: '',
    link: '',
    source_document: 'Cedar Valley notice (fictional)',
    source_text: NOTE_TEXT,
    published_at: '',
    extracted_at: '',
    confidence: 1,
    supersedes: '',
    group_label: 'Notices',
    group_summary: 'A note about the school bake sale.',
  },
]);

let stub = null;
let storedBytes = null;
let uploads = 0;
let downloads = 0;
let child = null;
let tmpDir = null;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
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
    cookie: () => cookie,
    setCookie: (c) => { cookie = c; },
  };
}

function spawnServer(dbPath) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: dbPath,
      APP_DB_GCS_BUCKET: 'durable-test-bucket',
      APP_DB_GCS_OBJECT: 'durable-test.db',
      APP_DB_GCS_ENDPOINT: GCS_ENDPOINT,
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `${GCS_ENDPOINT}/chat`,
    },
    stdio: 'ignore',
  });
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

test('hosted database survives instance replacement via the durable store', { timeout: 120000 }, async (t) => {
  stub = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.url === '/chat' || url.pathname === '/chat') {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: FACT_JSON }, finish_reason: 'stop' }],
        })
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/storage/v1/b/durable-test-bucket/o/durable-test.db') {
      downloads += 1;
      if (!storedBytes) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(storedBytes);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/upload/storage/v1/b/durable-test-bucket/o') {
      storedBytes = await readBody(req);
      uploads += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  t.after(async () => {
    await stopServer(child);
    if (stub) await new Promise((resolve) => stub.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-durable-'));
  const dbPath = path.join(tmpDir, 'app.db');

  let sessionCookie = '';
  let hubId = '';
  let materialId = '';

  await t.test('first boot writes family, hub, and note, then backs up to hosted storage', async () => {
    child = spawnServer(dbPath);
    await waitForServer();

    const visitor = makeClient();
    const profile = await visitor.post('/api/profile', {
      parent_name: 'Durable Dana',
      children: [{ name: 'Cedar' }],
    });
    assert.equal(profile.res.status, 200, profile.text.slice(0, 300));

    const hub = await visitor.post('/api/hubs', {
      kind: 'school',
      school_name: 'Cedar Valley Elementary',
      city: 'Cedar Valley',
      province: 'Ontario',
      country: 'Canada',
    });
    assert.equal(hub.res.status, 200, hub.text.slice(0, 300));
    hubId = hub.data.hub.id;

    const note = await visitor.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste',
      title: 'Bake sale note',
      text: NOTE_TEXT,
    });
    assert.equal(note.res.status, 200, note.text.slice(0, 500));
    assert.equal(note.data.facts_added, 1, 'the pasted note extracts one fact');
    materialId = note.data.material.id;
    sessionCookie = visitor.cookie();
    assert.ok(sessionCookie.startsWith('parentloop_session='), 'visitor holds a session');

    // Replacing the instance: SIGTERM must flush the database to hosted
    // storage (the debounced write-back covers it too).
    await stopServer(child);
    child = null;
    assert.ok(uploads >= 1, 'database was written back to hosted storage');
    assert.ok(storedBytes && storedBytes.length > 0, 'hosted copy holds database bytes');
  });

  await t.test('second boot restores family, hub, note, and session after local disk loss', async () => {
    fs.rmSync(dbPath, { force: true });
    assert.ok(!fs.existsSync(dbPath), 'the ephemeral local database is gone');
    const downloadsBefore = downloads;

    child = spawnServer(dbPath);
    await waitForServer();
    assert.ok(downloads > downloadsBefore, 'fresh boot downloads the database from hosted storage');
    assert.ok(fs.existsSync(dbPath), 'the database file exists again locally');

    const returning = makeClient();
    returning.setCookie(sessionCookie);
    const status = await returning.get('/api/onboarding/status');
    assert.equal(status.res.status, 200, status.text.slice(0, 300));
    assert.equal(status.data.profile.parent.name, 'Durable Dana', 'the creating session still resolves to its family');

    const hubs = await returning.get('/api/hubs');
    const hub = (hubs.data.hubs || []).find((h) => h.id === hubId);
    assert.ok(hub, 'the hub is still listed');
    assert.equal(hub.name, 'Cedar Valley Elementary — Cedar Valley');

    const detail = await returning.get(`/api/hubs/${hubId}`);
    assert.equal(detail.res.status, 200, detail.text.slice(0, 300));
    const titles = (detail.data.facts || []).map((f) => f.title);
    assert.ok(titles.includes('Cedar Valley bake sale'), 'the note fact survived, got: ' + titles.join(' | '));
    const materials = detail.data.materials || [];
    assert.ok(materials.some((m) => m.id === materialId && m.title === 'Bake sale note'), 'the note is still listed');
    const text = await returning.get(`/api/hubs/${hubId}/materials/${materialId}/text`);
    assert.equal(text.res.status, 200, text.text.slice(0, 300));
    assert.ok(String(text.data.text).includes('bake sale is Saturday'), 'the note text survived');

    const fresh = makeClient();
    const demoStatus = await fresh.get('/api/onboarding/status');
    assert.equal(demoStatus.data.profile.parent.name, 'Alex Rivera', 'a fresh visitor still gets the demo family');

    await stopServer(child);
    child = null;
  });
});
