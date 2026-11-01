// Brief 014: extraction must never silently save zero facts.
//
// A stubbed Meta Model API (pointed at via SCHOOL_AGENT_API_URL) returns a
// valid-but-empty fact list first. The material extraction path must retry
// the model call ONCE for a non-trivial source before giving up, and a
// second empty reply must fail visibly: HTTP 500 with a plain-language
// error plus a 'failed' material in the hub's material list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 36100 + (process.pid % 800);
const BASE = `http://127.0.0.1:${PORT}`;

const LONG_TEXT =
  'Maple Grove Elementary newsletter, week of November 2-6, 2026. ' +
  'The school picnic is on Friday, November 20, 2026 at Riverside Park. ' +
  'Please bring a water bottle and a packed lunch for every child. ' +
  'Reply forms are due Wednesday, November 18, 2026 in the front office. ' +
  'Volunteers meet Thursday at 3pm in the gym to plan the games.';

const GOOD_FACTS = JSON.stringify([
  {
    id: 'retry-fact-1',
    type: 'event',
    title: 'School picnic',
    detail: 'School picnic at Riverside Park.',
    date: '2026-11-20',
    time: '',
    applies_to: 'all students',
    action_required: false,
    action: '',
    link: '',
    source_document: 'Maple Grove Elementary newsletter (mock)',
    source_text: 'The school picnic is on Friday, November 20, 2026 at Riverside Park.',
    published_at: '',
    extracted_at: '',
    confidence: 1,
    supersedes: '',
    group_label: 'Picnic',
    group_summary: 'Details for the annual school picnic.',
  },
]);

let child = null;
let tmpDir = null;
let fakeModel = null;
let hubId = null;

// FIFO queue of model reply contents; each Meta API call consumes one.
let modelQueue = [];
let modelCalls = 0;

async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const probed = await jf('/api/onboarding/status');
      if (probed.res.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

let jarCookie = '';
async function jf(urlPath, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, (options && options.headers) || {});
  if (jarCookie) opts.headers.Cookie = jarCookie;
  const res = await fetch(`${BASE}${urlPath}`, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/parentloop_session=([^;]+)/);
    if (m) jarCookie = 'parentloop_session=' + m[1];
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

function post(urlPath, body) {
  return jf(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

test('empty extraction retries once, then fails visibly', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-retry-test-'));
  const dbPath = path.join(tmpDir, 'app.db');

  fakeModel = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      modelCalls += 1;
      const content = modelQueue.length ? modelQueue.shift() : '[]';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
        })
      );
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const fakePort = fakeModel.address().port;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: dbPath,
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakePort}/v1/chat/completions`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (fakeModel) fakeModel.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await post('/api/profile/demo', {});
  const hubs = await jf('/api/hubs');
  assert.ok(hubs.data.hubs.length > 0, 'demo profile has hubs');
  hubId = hubs.data.hubs[0].id;

  await t.test('empty first, valid retry → facts saved, status extracted', async () => {
    modelQueue = ['[]', GOOD_FACTS];
    modelCalls = 0;
    const added = await post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste',
      title: 'Retry notice',
      text: LONG_TEXT,
    });
    assert.equal(added.res.status, 200, added.text.slice(0, 400));
    assert.ok(added.data.facts_added >= 1);
    assert.equal(added.data.material.status, 'extracted');
    assert.equal(modelCalls, 2, 'model was called exactly twice');
    const detail = await jf(`/api/hubs/${hubId}`);
    const material = detail.data.materials.find((m) => m.id === added.data.material.id);
    assert.ok(material, 'material is listed in the hub');
    assert.equal(material.status, 'extracted');
    assert.ok(
      detail.data.facts.some((f) => f.material_id === added.data.material.id),
      'retried facts are stored against the material'
    );
  });

  await t.test('empty twice → 500 plus a failed material in the hub list', async () => {
    modelQueue = ['[]', '[]'];
    modelCalls = 0;
    const failed = await post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste',
      title: 'Unlucky notice',
      text: LONG_TEXT,
    });
    assert.equal(failed.res.status, 500, failed.text.slice(0, 400));
    assert.match(failed.data.error, /couldn't pull any notes/i);
    assert.equal(modelCalls, 2, 'model was retried exactly once');
    const detail = await jf(`/api/hubs/${hubId}`);
    const material = detail.data.materials.find((m) => m.title === 'Unlucky notice');
    assert.ok(material, 'failed material stays in the hub material list');
    assert.equal(material.status, 'failed');
    assert.ok(
      !detail.data.facts.some((f) => f.material_id === material.id),
      'zero facts stored for the failed material'
    );
  });

  await t.test('tiny paste keeps today’s behavior: no retry, success', async () => {
    modelQueue = ['[]'];
    modelCalls = 0;
    const tiny = await post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste',
      title: 'Tiny note',
      text: 'Hi.',
    });
    assert.equal(tiny.res.status, 200, tiny.text.slice(0, 400));
    assert.equal(tiny.data.facts_added, 0);
    assert.equal(tiny.data.material.status, 'extracted');
    assert.equal(modelCalls, 1, 'no retry for a trivially small paste');
  });
});
