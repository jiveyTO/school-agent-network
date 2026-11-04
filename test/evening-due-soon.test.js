// "Needs your attention tonight": besides the actions a family tracks (the
// model's nudges), any relevant fact that needs an action and is due today
// through two days ahead is nudged too, and a parent can mark a nudge done
// (and undo it). The demo keeps its pinned nudges and cannot be changed.
// Fictional fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39600 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
// db.js reads APP_DB_PATH when first required, so one database serves the
// whole file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-due-soon-'));
const dbPath = path.join(tmpDir, 'app.db');
process.env.APP_DB_PATH = dbPath;
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function plusDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function client(cookie, extraHeaders) {
  let jar = cookie || '';
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, extraHeaders || {}, (options && options.headers) || {});
    if (jar) opts.headers.Cookie = jar;
    const res = await fetch(`${BASE}${urlPath}`, opts);
    const set = res.headers.get('set-cookie');
    if (set && /parentloop_session=/.test(set)) jar = set.split(';')[0];
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  }
  return {
    get: (p) => req(p),
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
  };
}

function fact(id, title, date, actionRequired, action) {
  return {
    id, type: actionRequired ? 'deadline' : 'event', title, detail: title, date, time: '',
    applies_to: 'all students', action_required: actionRequired, action: action || '', link: '',
    source_document: 'Willow Creek weekly (mock)', source_text: title, published_at: '', extracted_at: '',
    confidence: 1, supersedes: '', scope: 'school', scope_value: '', group_label: '', group_summary: '',
  };
}

test('due-soon rule and done marks (pure helpers)', async (t) => {
  const { addDueSoonNudges, withDoneApplied, eveningMoment } = require('../server');

  await t.test('the demo moment has a fixed day, real families get today', () => {
    assert.equal(eveningMoment({ is_demo: true }).today, '2026-11-05');
    assert.match(eveningMoment({ is_demo: false }).today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(eveningMoment({ is_demo: false }, 'What if').today, undefined, 'a what-if run has no day');
  });

  const moment = { today: '2026-11-05' };
  const relevant = [
    { ...fact('pizza', 'Pizza orders due', '2026-11-06', true, 'Submit pizza order'), hub_id: 'h1' },
    { ...fact('survey', 'Uniform Survey due', '2026-11-06', true, 'Submit Uniform Survey'), hub_id: 'h1' },
    { ...fact('skates', 'Skate fitting', '2026-11-04', true, 'Bring skates'), hub_id: 'h2' },
    { ...fact('form', 'Team number form due', '2026-11-07', true, 'Submit team number form'), hub_id: 'h2' },
    { ...fact('photo', 'Team photo day', '2026-11-08', true, 'Wear full uniform'), hub_id: 'h2' },
    { ...fact('pizza-day', 'Pizza day', '2026-11-06', false, ''), hub_id: 'h1' },
  ].map((f) => ({ ...f, source: f.source_document }));
  const base = () => ({
    relevant_facts: relevant,
    nudges: [{ fact_id: 'pizza', title: 'Pizza orders due', action: 'Submit pizza order', deadline: '2026-11-06', source: 'mock' }],
    groups: [{ hub_id: 'h1', facts: [], nudges: [] }, { hub_id: 'h2', facts: [], nudges: [] }],
    open_action_count: 1,
  });
  const profile = { actions: { pizza_order: 'not_ordered', uniform_survey: 'done' } };

  await t.test('only untracked actions due in the window are added', () => {
    const out = addDueSoonNudges(base(), profile, moment);
    assert.deepEqual(out.nudges.map((n) => n.fact_id), ['pizza', 'form']);
    assert.equal(out.open_action_count, 2);
    const added = out.nudges[1];
    assert.equal(added.due_soon, true);
    assert.equal(added.deadline, '2026-11-07');
    assert.equal(added.action, 'Submit team number form');
    assert.deepEqual(out.groups[1].nudges.map((n) => n.fact_id), ['form'], 'filed under its hub');
  });

  await t.test('a fact already nudged by the model is not added twice', () => {
    const r = base();
    r.nudges.push({ fact_id: 'form', title: 'Team number form due' });
    const out = addDueSoonNudges(r, profile, moment);
    assert.equal(out.nudges.filter((n) => n.fact_id === 'form').length, 1);
  });

  await t.test('no day (a what-if run) adds nothing', () => {
    const out = addDueSoonNudges(base(), profile, { today: undefined });
    assert.deepEqual(out.nudges.map((n) => n.fact_id), ['pizza']);
  });

  await t.test('done marks hide a nudge everywhere it is served', () => {
    const full = addDueSoonNudges(base(), profile, moment);
    const served = withDoneApplied(full, { ...profile.actions, 'fact:form': 'done' });
    assert.deepEqual(served.nudges.map((n) => n.fact_id), ['pizza']);
    assert.equal(served.open_action_count, 1);
    assert.deepEqual(served.groups[1].nudges, []);
    assert.equal(full.nudges.length, 2, 'the saved check keeps it for Undo');
  });
});

test('a real family is nudged for a form due tomorrow and can tick it off', async (t) => {
  const db = require('../db');
  await db.initDb();
  const { eveningMoment } = require('../server');
  const today = eveningMoment({ is_demo: false }).today;

  const family = db.createProfile({ parent_name: 'Due Parent', children: [{ name: 'Robin Fictional' }] });
  const hub = db.createHub(family.id, 'Willow Creek Public — Willow Creek', 'school', {
    school_name: 'Willow Creek Public', city: 'Willow Creek', province: 'Ontario', country: 'Canada',
  });
  const material = db.createMaterial(hub.id, family.id, 'paste', 'Willow Creek weekly (mock)', 'Fictional weekly.', 'extracted');
  db.insertFacts(hub.id, material.id, [
    fact('ds-form', 'Team number form due', plusDays(today, 1), true, 'Submit team number form'),
    fact('ds-later', 'Field trip form due', plusDays(today, 5), true, 'Return field trip form'),
    fact('ds-event', 'Pajama day', plusDays(today, 1), false, ''),
  ], false);
  const s = db.createSession();
  db.setSessionProfile(s.id, family.id);
  const token = db.createAgentToken(family.id, 'Homework helper').token;

  const fakeModel = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let facts = [];
      try {
        const body = JSON.parse(raw);
        const user = body.messages.find((m) => m.role === 'user').content;
        facts = JSON.parse(user.split('School Agent facts:\n')[1] || '[]');
      } catch { facts = []; }
      const content = JSON.stringify({
        relevant_facts: facts.map((f) => ({ id: f.id, title: f.title })),
        nudges: [], calendar_hold: null, filtered_out_count: 0, filtering_summary: 'All of it applies.',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath, SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
  });
  const parent = client('parentloop_session=' + s.id);
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await parent.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  await t.test('the run nudges only the action due tomorrow', async () => {
    const run = await parent.post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.deepEqual(run.data.nudges.map((n) => n.fact_id), ['ds-form']);
    assert.equal(run.data.nudges[0].deadline, plusDays(today, 1));
    assert.equal(run.data.open_action_count, 1);
    assert.equal(run.data.can_mark_done, true);
  });

  await t.test('Done hides it, keeps the check current, and Undo brings it back', async () => {
    const done = await parent.post('/api/parent/done', { fact_id: 'ds-form' });
    assert.equal(done.res.status, 200, done.text.slice(0, 300));
    assert.deepEqual(done.data.check.nudges, []);
    assert.equal(done.data.stale, false, 'ticking off does not force a new run');
    const latest = await parent.get('/api/parent/latest');
    assert.deepEqual(latest.data.check.nudges, []);
    assert.equal(latest.data.can_mark_done, true);
    const again = await parent.post('/api/parent/run', {});
    assert.deepEqual(again.data.nudges, [], 'a fresh run keeps it done');

    const undo = await parent.post('/api/parent/done', { fact_id: 'ds-form', done: false });
    assert.equal(undo.res.status, 200);
    assert.deepEqual(undo.data.check.nudges.map((n) => n.fact_id), ['ds-form']);
  });

  await t.test('an item outside the family, an agent token, or the demo is refused', async () => {
    const missing = await parent.post('/api/parent/done', { fact_id: 'not-a-fact' });
    assert.equal(missing.res.status, 404);
    const agent = client('', { Authorization: `Bearer ${token}` });
    const viaToken = await agent.post('/api/parent/done', { fact_id: 'ds-form' });
    assert.equal(viaToken.res.status, 403);
    const visitor = client('');
    await visitor.post('/api/profile/demo', {});
    const demoLatest = await visitor.get('/api/parent/latest');
    assert.equal(demoLatest.data.can_mark_done, false);
    const demoFact = db.listFactsForProfile(db.getDemoProfile().id)[0];
    const demoDone = await visitor.post('/api/parent/done', { fact_id: demoFact.id });
    assert.equal(demoDone.res.status, 403);
  });
});
