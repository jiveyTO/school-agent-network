// Brief 068, glitch 3: a material card never contradicts itself. A paste
// that becomes one dated note shows that note (with its date) when the card
// opens. A card with no notes for this family says which of four things is
// true: still being read (and looks again shortly), every note is for other
// grades/classes, it couldn't be read, or it hasn't been broken into notes
// (offering the original). The page's real render code runs in a sandbox
// on the server's real hub payload. Fictional data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 42400 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const PASTE = 'Road Safety by YRP - Nov 4';

// The page's card rendering (esc … renderHubSources) with a fake DOM.
function renderCards(facts, materials) {
  const from = PAGE.indexOf('function esc(s)');
  const to = PAGE.indexOf('function friendlyTime(');
  assert.ok(from !== -1 && to > from, 'render code found');
  const listEl = { innerHTML: '', children: [], querySelectorAll: () => [], querySelector: () => null };
  const els = { hubFacts: listEl, hubGroupsToggle: { hidden: true, textContent: '' }, viewHub: { hidden: false } };
  const timers = [];
  const sandbox = {
    document: { getElementById: (id) => els[id] || { hidden: true, textContent: '', innerHTML: '' } },
    currentHubId: 'hub-1',
    setTimeout: (cb, ms) => { timers.push(ms); return timers.length; },
    clearTimeout: () => {},
    Date, JSON, Math, Number, String, Array, Object, encodeURIComponent,
  };
  vm.runInNewContext(PAGE.slice(from, to) + '\nrenderHubSources(FACTS, MATERIALS);',
    Object.assign(sandbox, { FACTS: facts, MATERIALS: materials }));
  return { html: listEl.innerHTML, timers };
}

const mat = (over) => Object.assign({
  id: 'm-' + Math.random().toString(36).slice(2), kind: 'paste', title: 'Notice', created_at: new Date(Date.now() - 3600e3).toISOString(),
  status: 'extracted', fact_count: 0, has_file: false, can_remove: false, can_rename: false, unverified_count: 0,
}, over || {});

test('a paste that becomes one dated note shows it, with its date, when opened', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-card-empty-'));
  const fakeModel = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // One dated item whose group is the material itself — the shape the
      // live "Road Safety by YRP - Nov 4" paste produced.
      const content = JSON.stringify([{
        id: 'fact-road-safety', type: 'event', title: 'Road Safety by YRP', detail: 'Road Safety session by YRP on Nov 4.',
        date: '2026-11-04', time: '', applies_to: 'all students', action_required: false, action: '', link: '',
        source_document: PASTE, source_text: PASTE, published_at: '', extracted_at: '', confidence: 1, supersedes: '',
        group_label: PASTE, group_summary: '',
      }]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), APP_DB_GCS_BUCKET: '',
      SCHOOL_AGENT_API_KEY: 'test-key', SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  let jar = '';
  const call = async (method, p, body) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, jar ? { Cookie: jar } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set && /parentloop_session=/.test(set)) jar = set.split(';')[0];
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  };
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await call('GET', '/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal((await call('POST', '/api/profile', { parent_name: 'Card Carmen', parent_email: 'card.carmen@example.com', children: [{ name: 'Carmen Kid' }] })).res.status, 200);
  const hub = await call('POST', '/api/hubs', { name: 'Card Test Hub', kind: 'other' });
  const hubId = hub.data.hub.id;
  const added = await call('POST', `/api/hubs/${hubId}/materials`, { kind: 'paste', text: PASTE });
  assert.equal(added.res.status, 200, added.text.slice(0, 300));

  const detail = await call('GET', `/api/hubs/${hubId}`);
  const material = detail.data.materials.find((m) => m.id === added.data.material.id);
  assert.equal(material.fact_count, 1, 'the payload says how many notes the material produced');
  const { html } = renderCards(detail.data.facts, detail.data.materials);
  assert.ok(html.includes('Road Safety session by YRP on Nov 4.'), 'the note shows');
  assert.ok(/Due [A-Z][a-z]{2}/.test(html), 'with its date');
  assert.ok(!/Nothing shared|hasn’t been broken|Still reading/.test(html), 'never an empty-state line');
});

test('a card with no notes for this family says which of the four cases it is', () => {
  const reading = renderCards([], [mat({ status: 'stored', created_at: new Date().toISOString() })]);
  assert.ok(reading.html.includes('Still reading this one'));
  assert.ok(reading.html.includes('reading…'));
  assert.deepEqual(reading.timers, [6000], 'and looks again shortly');

  const scoped = renderCards([], [mat({ fact_count: 3 })]);
  assert.ok(scoped.html.includes('for other grades or classes'));
  assert.ok(scoped.html.includes('nothing for your family in this one'));
  assert.deepEqual(scoped.timers, []);

  const failed = renderCards([], [mat({ status: 'failed' })]);
  assert.ok(failed.html.includes('couldn\'t pull any notes out of that one'));

  const none = renderCards([], [mat({ id: 'm-plain' })]);
  assert.ok(none.html.includes('This one hasn’t been broken into notes yet. The original full text is in the ⋯ menu above.'), 'offers the original text');
  assert.ok(none.html.includes('data-material-action="text" data-material="m-plain">View full text</button>'), 'which the ⋯ menu carries');
  assert.ok(none.html.includes('no notes yet'));

  const pdf = renderCards([], [mat({ id: 'm-pdf', kind: 'pdf', has_file: true })]);
  assert.ok(pdf.html.includes('The original PDF is in the ⋯ menu above.'), 'a kept file is offered as the original');
  assert.ok(pdf.html.includes('>View original PDF</a>'), 'and the menu links to it');

  const old = renderCards([], [mat({ status: 'stored', created_at: new Date(Date.now() - 86400e3).toISOString() })]);
  assert.ok(old.html.includes('hasn’t been broken into notes yet'), 'an old unread material is not "still reading"');

  for (const r of [reading, scoped, failed, none, pdf, old]) assert.ok(!r.html.includes('Nothing shared from this one yet'));
});
