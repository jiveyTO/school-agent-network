// Brief 072: a pasted material gets a short title from its content (Brief
// 053's read), never the pasted text. No usable title -> a short first-line
// title (a heading glued to its body keeps its first sentence). A parent's
// rename always wins. Fixtures are fictional.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 42800 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TITLE_CAP = 90; // cleanMaterialTitle's cap for a content title

const QUOTE = 'Photo Day is Thursday, November 12, 2026.';
const FACT = {
  id: 'photo-day-1', type: 'event', title: 'Photo Day',
  detail: 'School photo day.', date: '2026-11-12', time: '',
  applies_to: 'all students', action_required: false, action: '', link: '',
  source_document: 'notice', source_text: QUOTE,
  published_at: '', extracted_at: '', confidence: 1, supersedes: '',
  group_label: '', group_summary: '',
};

// Each paste is new text (the same text twice is a duplicate).
const paste = (n) => [
  `Maple Grove Elementary — November Newsletter. Dear families, here is our news for week ${n}. ${QUOTE} ` +
    'Students should wear their uniform and bring a smile. Order forms come home in backpacks.',
  '',
  'Pizza Lunch is every Friday this month. Please send exact change in a labelled envelope.',
  '',
  'Library books are due back before the long weekend. Thank you for reading at home!',
].join('\n');

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
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  }
  const json = (method) => (p, body) => req(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { post: json('POST'), patch: json('PATCH'), get: (p) => req(p) };
}

async function waitForServer(client) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      if ((await client.get('/api/onboarding/status')).res.ok) return;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

test('pasted materials are titled from their content, never the pasted text', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-paste-title-'));
  // nextTitle: what the stub proposes as material_title; null = a plain
  // facts array (no title at all). failNext: answer HTTP 500 (a failed read).
  let nextTitle = null;
  let failNext = 0;
  const prompts = [];
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      prompts.push(String((((body && body.messages) || [])[0] || {}).content || ''));
      if (failNext > 0) {
        failNext -= 1;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      const content = nextTitle === null
        ? JSON.stringify([FACT])
        : JSON.stringify({ material_title: nextTitle, facts: [FACT] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: path.join(tmpDir, 'app.db'),
      APP_DB_GCS_BUCKET: '',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
      SCHOOL_AGENT_API_KEY: 'test-key',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const client = makeClient();
  await waitForServer(client);
  assert.equal((await client.post('/api/profile', {
    parent_name: 'Paste Founder', parent_email: 'paste.founder@example.com', children: [{ name: 'Paste Kid' }],
  })).res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Paste Title Hub', kind: 'other' });
  const hubId = hub.data.hub.id;
  const listed = async (id) => (await client.get(`/api/hubs/${hubId}`)).data.materials.find((m) => m.id === id);
  const add = (text) => client.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text });

  await t.test('a multi-paragraph paste takes a short content title', async () => {
    nextTitle = 'November newsletter';
    prompts.length = 0;
    const text = paste(1);
    const up = await add(text);
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.ok(prompts.some((p) => /material_title/.test(p)), 'the paste read is asked for a title');
    const mat = await listed(up.data.material.id);
    assert.equal(mat.title, 'November newsletter');
    assert.notEqual(mat.title, text);
    assert.ok(!mat.title.includes('\n') && mat.title.length <= TITLE_CAP);
    assert.ok((up.data.facts || []).every((f) => f.source_document === 'November newsletter'), 'notes carry the title');
  });

  await t.test('no title in the read -> a short first-line title, never the paste', async () => {
    nextTitle = null;
    const text = paste(2);
    const up = await add(text);
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    const mat = await listed(up.data.material.id);
    assert.equal(mat.title, 'Maple Grove Elementary — November Newsletter', 'the heading glued to the body');
    assert.ok(mat.title.length <= 61);
  });

  await t.test('an ungrounded or blank title falls back the same way', async () => {
    nextTitle = 'Photo Day — December 30'; // "30" is not in the text: invented
    const up = await add(paste(3));
    assert.equal((await listed(up.data.material.id)).title, 'Maple Grove Elementary — November Newsletter');
    nextTitle = '   ';
    const blank = await add(paste(4));
    assert.equal((await listed(blank.data.material.id)).title, 'Maple Grove Elementary — November Newsletter');
  });

  await t.test('an over-long content title is cut on a word', async () => {
    nextTitle = 'Maple Grove Elementary November Newsletter with Photo Day and Pizza Lunch and Library books and uniform notes for families';
    const up = await add(paste(5));
    const title = (await listed(up.data.material.id)).title;
    assert.ok(title.length <= TITLE_CAP + 1 && title.endsWith('…'), title);
  });

  await t.test('a supplied title wins and is not replaced by the read', async () => {
    nextTitle = 'Should not be used';
    const up = await client.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text: paste(6), title: 'Our own name' });
    assert.equal((await listed(up.data.material.id)).title, 'Our own name');
  });

  await t.test('a parent’s rename survives a later re-read of the same paste', async () => {
    const text = paste(7);
    failNext = 2; // the first read fails (with its retry): the paste is kept, notes pending
    const first = await add(text);
    const id = first.data.material && first.data.material.id;
    assert.ok(id, first.text.slice(0, 400));
    assert.equal((await listed(id)).status, 'stored', 'notes pending');
    const renamed = await client.patch(`/api/hubs/${hubId}/materials/${id}`, { title: 'Week 7 from Ms. Lee' });
    assert.equal(renamed.res.status, 200, renamed.text.slice(0, 300));
    failNext = 0;
    nextTitle = 'November newsletter';
    const again = await add(text);
    assert.equal(again.res.status, 200, again.text.slice(0, 400));
    assert.equal(again.data.material.id, id, 'read again in place');
    assert.equal((await listed(id)).title, 'Week 7 from Ms. Lee', 'the rename wins');
  });

  await t.test('a re-read of an un-renamed paste still takes the content title', async () => {
    const text = paste(8);
    failNext = 2;
    const first = await add(text);
    const id = first.data.material.id;
    assert.equal((await listed(id)).title, 'Maple Grove Elementary — November Newsletter');
    failNext = 0;
    nextTitle = 'Week 8 newsletter';
    await add(text);
    assert.equal((await listed(id)).title, 'Week 8 newsletter');
  });
});
