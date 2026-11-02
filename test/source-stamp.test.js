// Brief 016: extracted facts must carry their real source, and the evening
// check summary must name the whole family.
//
// Regression test with a stubbed Meta Model API (pointed at via
// SCHOOL_AGENT_API_URL): the stub returns facts whose source_document is the
// extraction prompt's Maple Grove example string. Facts saved from a
// parent-added paste material must carry the material-derived source instead.
//
// Fixtures are fictional (Cedar Valley). Nothing here comes from a real
// school newsletter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 36300 + (process.pid % 800);
const BASE = `http://127.0.0.1:${PORT}`;

const MATERIAL_TITLE = 'Cedar Valley Weekly Update — Nov 9 to 13';

const LONG_TEXT =
  'Cedar Valley Weekly Update, week of November 9-13, 2026. ' +
  'The school book fair runs Friday, November 13, 2026 in the library. ' +
  'Bring a reusable bag for every child taking books home. ' +
  'Library volunteers meet Thursday at 3pm in the front hall to set up tables.';

// The stub mimics the old defect: the model echoes the prompt's Maple Grove
// example into source_document regardless of the actual material.
const MODEL_FACTS = JSON.stringify([
  {
    id: 'stamp-fact-1',
    type: 'event',
    title: 'Book fair',
    detail: 'Book fair in the library.',
    date: '2026-11-13',
    time: '',
    applies_to: 'all students',
    action_required: false,
    action: '',
    link: '',
    source_document: 'Maple Grove Elementary newsletter (mock)',
    source_text: 'The school book fair runs Friday, November 13, 2026 in the library.',
    published_at: '',
    extracted_at: '',
    confidence: 1,
    supersedes: '',
    group_label: 'Library',
    group_summary: 'News from the school library.',
  },
]);

let child = null;
let tmpDir = null;
let fakeModel = null;
let hubId = null;

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

test('Brief 016: extraction stamps the real material source; summary names the whole family', async (t) => {
  await t.test('Parent Agent prompt guidance names every child or your family, never just the first', async () => {
    // server.js boots a listener on require, so assert on its source like the
    // existing prompt-pinning tests do (see hubs.test.js).
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(
      serverSrc.includes('Name every child the kept facts apply to'),
      'parent prompt names every child the kept facts apply to'
    );
    assert.ok(
      serverSrc.includes('"your family" when they apply across the children'),
      'parent prompt falls back to "your family"'
    );
    assert.ok(
      serverSrc.includes('never just the first child'),
      'parent prompt forbids first-child-only summaries'
    );
  });

  await t.test('paste extraction replaces the model Maple Grove source with the material title', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-stamp-test-'));
    const dbPath = path.join(tmpDir, 'app.db');

    fakeModel = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: MODEL_FACTS }, finish_reason: 'stop' }],
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

    const added = await post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste',
      title: MATERIAL_TITLE,
      text: LONG_TEXT,
    });
    assert.equal(added.res.status, 200, added.text.slice(0, 400));
    assert.ok(added.data.facts_added >= 1, 'stubbed facts saved');
    for (const f of added.data.facts) {
      assert.equal(
        f.source_document,
        MATERIAL_TITLE,
        `saved fact carries the material-derived source, got: ${f.source_document}`
      );
    }

    const detail = await jf(`/api/hubs/${hubId}`);
    const stored = detail.data.facts.filter((f) => f.material_id === added.data.material.id);
    assert.ok(stored.length >= 1, 'stamped facts persisted against the material');
    assert.ok(
      stored.every((f) => f.source_document === MATERIAL_TITLE),
      'persisted facts carry the material-derived source'
    );
  });
});
