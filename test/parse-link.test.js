const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 36800 + (process.pid % 100);
const AUX_PORT = PORT + 500;
const BASE = `http://127.0.0.1:${PORT}`;
const AUX = `http://127.0.0.1:${AUX_PORT}`;

// Sparse board-page fixture in the shape of the real failure page: the school
// name lives in the title, the city appears in nav/body text, and the
// province appears nowhere.
const BOARD_HTML =
  '<html><head>' +
  '<title>St. Richard Catholic School | Toronto Catholic District School Board</title>' +
  '<meta property="og:title" content="St. Richard Catholic School">' +
  '</head><body>' +
  '<nav>Toronto Catholic District School Board schools in Toronto</nav>' +
  '<h1>St. Richard Catholic School</h1>' +
  '<p>Welcome to St. Richard Catholic School, a faith community in Toronto.</p>' +
  '</body></html>';

const FULL_IDENTITY = JSON.stringify({
  school_name: 'St. Richard Catholic School',
  city: 'Toronto',
  province: 'Ontario',
  country: 'Canada',
});

function metaReply(content, finishReason) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason || 'stop',
      },
    ],
  });
}

// The truncation signature from the real failure: the model spends its token
// budget on reasoning, hits finish_reason "length", and returns null content.
const TRUNCATED = metaReply(null, 'length');

let aux = null;
let child = null;
let tmpDir = null;
let metaRequests = [];
let metaQueue = [];

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
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

function postParseLink(pagePath) {
  return fetch(`${BASE}/api/hubs/parse-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${AUX}${pagePath}`, kind: 'school' }),
  }).then(async (res) => {
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { res, data, text };
  });
}

test('parse-link survives model truncation via retry, inference, and title fallback', async (t) => {
  assert.ok(!/ontario/i.test(BOARD_HTML), 'fixture is sparse: no province anywhere');
  assert.ok(/St\. Richard/.test(BOARD_HTML), 'fixture names the school in the title');

  aux = http.createServer(async (req, res) => {
    if (req.url === '/chat') {
      const raw = await readBody(req);
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      metaRequests.push(parsed);
      const next = metaQueue.length ? metaQueue.shift() : metaReply(FULL_IDENTITY, 'stop');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(next);
      return;
    }
    if (req.url === '/board' || req.url === '/dead') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(BOARD_HTML);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => aux.listen(AUX_PORT, '127.0.0.1', resolve));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-parselink-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: path.join(tmpDir, 'app.db'),
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `${AUX}/chat`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (aux) aux.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await t.test('a truncated first reply is retried and succeeds', async () => {
    metaRequests = [];
    metaQueue = [TRUNCATED, metaReply(FULL_IDENTITY, 'stop')];
    const parsed = await postParseLink('/board');
    assert.equal(parsed.res.status, 200, parsed.text.slice(0, 400));
    assert.equal(parsed.data.fields.school_name, 'St. Richard Catholic School');
    assert.equal(metaRequests.length, 2, 'one retry after the truncated reply');
    assert.equal(metaRequests[0].max_tokens, 4096, 'identity budget raised past 1024');
  });

  await t.test('sparse board page fills city, province, and country', async () => {
    metaRequests = [];
    metaQueue = [metaReply(FULL_IDENTITY, 'stop')];
    const parsed = await postParseLink('/board');
    assert.equal(parsed.res.status, 200, parsed.text.slice(0, 400));
    assert.match(parsed.data.fields.school_name, /St\. Richard/);
    assert.equal(parsed.data.fields.city, 'Toronto');
    assert.equal(parsed.data.fields.province, 'Ontario');
    assert.equal(parsed.data.fields.country, 'Canada');
    const sent = metaRequests[metaRequests.length - 1];
    const userText = String(
      (sent.messages || []).map((m) => m.content).join('\n')
    );
    assert.ok(userText.includes('St. Richard Catholic School'), 'model sees the page title');
    assert.ok(userText.includes(`${AUX}/board`), 'model sees the page URL');
    const systemText = String((sent.messages || [])[0].content || '');
    assert.ok(
      systemText.includes('reasonably inferable') || systemText.includes('reasonably infer'),
      'model is told to infer province and country'
    );
  });

  await t.test('a dead model still returns 200 with the title fallback', async () => {
    metaRequests = [];
    metaQueue = [TRUNCATED, TRUNCATED];
    const parsed = await postParseLink('/dead');
    assert.equal(parsed.res.status, 200, parsed.text.slice(0, 400));
    assert.match(parsed.data.fields.school_name, /St\. Richard/);
    assert.equal(metaRequests.length, 2, 'retried once before falling back');
  });
});
