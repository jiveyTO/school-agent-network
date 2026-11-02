const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 36700 + (process.pid % 100);
const AUX_PORT = PORT + 700;
const BASE = `http://127.0.0.1:${PORT}`;
const AUX = `http://127.0.0.1:${AUX_PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Living-case shape: the real school page carries its address in the footer,
// far past the first screen of text. The filler pushes the footer beyond the
// old head-only slice so the test proves the footer survives to the model.
const FILLER = ('<p>Finding the right secondary school is important for a ' +
  'student\u2019s academic success and well-being this fall.</p>').repeat(140);
const SJA_HTML =
  '<html><head>' +
  '<title>St. Joseph Catholic Elementary School \u2013 Home of the Jaguars!</title>' +
  '</head><body>' +
  '<nav>York Catholic District School Board schools</nav>' +
  '<h1>St. Joseph Catholic Elementary School</h1>' +
  FILLER +
  '<footer>School Information 2 Glass Dr., Aurora L4G 2E8 Phone: 905-727-5782</footer>' +
  '</body></html>';

function metaReply(content) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

const BLANK_LOCATION = JSON.stringify({
  school_name: 'St. Joseph Catholic Elementary School',
  city: '',
  province: '',
  country: '',
});

const TORONTO_MODEL = JSON.stringify({
  school_name: 'St. Joseph Catholic Elementary School',
  city: 'Toronto',
  province: '',
  country: '',
});

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

test('school autofill prefers the page address over the remembered location', async (t) => {
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
      const next = metaQueue.length ? metaQueue.shift() : metaReply(BLANK_LOCATION);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(next);
      return;
    }
    if (req.url === '/sja') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SJA_HTML);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => aux.listen(AUX_PORT, '127.0.0.1', resolve));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-autofill-'));
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

  await t.test('footer postal address yields Aurora, Ontario, Canada when the model leaves location blank', async () => {
    metaRequests = [];
    metaQueue = [metaReply(BLANK_LOCATION)];
    const parsed = await postParseLink('/sja');
    assert.equal(parsed.res.status, 200, parsed.text.slice(0, 400));
    assert.equal(parsed.data.fields.school_name, 'St. Joseph Catholic Elementary School');
    assert.equal(parsed.data.fields.city, 'Aurora');
    assert.equal(parsed.data.fields.province, 'Ontario');
    assert.equal(parsed.data.fields.country, 'Canada');
    const sent = metaRequests[metaRequests.length - 1];
    const userText = String((sent.messages || []).map((m) => m.content).join('\n'));
    assert.ok(userText.includes('Aurora'), 'model sees the footer address, not just the head');
    assert.ok(
      String((sent.messages || [])[0].content || '').includes('postal'),
      'model is told to take the city from the postal address'
    );
  });

  await t.test('the postal fallback only fills blanks and never overrides the model', async () => {
    metaRequests = [];
    metaQueue = [metaReply(TORONTO_MODEL)];
    const parsed = await postParseLink('/sja');
    assert.equal(parsed.res.status, 200, parsed.text.slice(0, 400));
    assert.equal(parsed.data.fields.city, 'Toronto', 'model city wins over the address city');
    assert.equal(parsed.data.fields.province, 'Ontario');
    assert.equal(parsed.data.fields.country, 'Canada');
  });
});

test('client merge prefers parse-link fields and falls back to memory only for blanks', () => {
  const m = PAGE.match(/function mergeParsedSchoolLocation\(parsed, remembered\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'merge helper ships in the page');
  const merge = new Function(`${m[0]}; return mergeParsedSchoolLocation;`)();
  const memory = { city: 'Scarborough', province: 'Ontario', country: 'Canada' };

  const won = merge(
    { city: 'Aurora', province: 'Ontario', country: 'Canada' },
    memory
  );
  assert.deepEqual(won, { city: 'Aurora', province: 'Ontario', country: 'Canada' });

  const blanks = merge({ city: '', province: '', country: '' }, memory);
  assert.deepEqual(blanks, memory, 'blank parse falls back to the remembered location');

  const partial = merge({ city: 'Aurora', province: '', country: '' }, memory);
  assert.equal(partial.city, 'Aurora');
  assert.equal(partial.province, 'Ontario', 'blank province still falls back to memory');
  assert.equal(merge({ city: '  Aurora  ', province: '', country: '' }, memory).city, 'Aurora');
  assert.deepEqual(
    merge({ city: '', province: '', country: '' }, null),
    { city: '', province: '', country: '' }
  );

  // The fill handler only assigns page-provided fields, so manual edits and
  // the remembered-location prefill survive a parse that left blanks.
  const useAt = PAGE.indexOf('mergeParsedSchoolLocation(f, readSavedSchoolLocation())');
  assert.ok(useAt !== -1, 'fill handler uses the merge');
  const handler = PAGE.slice(useAt, useAt + 600);
  assert.ok(handler.includes("if (f.city)"), 'blank page city never overwrites the form');
  assert.ok(handler.includes('hubSchoolCity'), 'merged city lands in the form');
  assert.ok(PAGE.includes('prefillSchoolLocation'), 'typed flow keeps the remembered prefill');
});
