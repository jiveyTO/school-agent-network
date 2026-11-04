// Evening check as home: each run is saved per family, GET /api/parent/latest
// returns the saved check instantly with stale:true once the family's facts,
// placements, actions, or day change, and real families run at real local
// time while the demo keeps its simulated moment (its prompt is unchanged).
// Fictional fixtures; the store is seeded in-process, then a server child
// serves the same file with a stub model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39400 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function client(cookie) {
  let jar = cookie || '';
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
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

test('the evening check is saved, served instantly, and goes stale on change', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-evening-home-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();
  const family = db.createProfile({ parent_name: 'Home Parent', children: [{ name: 'Robin Fictional' }] });
  const hub = db.createHub(family.id, 'Willow Creek Public — Willow Creek', 'school', {
    school_name: 'Willow Creek Public', city: 'Willow Creek', province: 'Ontario', country: 'Canada',
  });
  const material = db.createMaterial(hub.id, family.id, 'paste', 'Willow Creek weekly (mock)', 'Bake sale on Friday in the gym.', 'extracted');
  db.insertFacts(hub.id, material.id, [{
    id: 'wc-bake', type: 'event', title: 'Bake sale', detail: 'Bake sale in the gym.', date: '2026-11-20', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '', source_document: 'mock',
    source_text: 'Bake sale on Friday in the gym.', published_at: '', extracted_at: '', confidence: 1,
    supersedes: '', scope: 'school', scope_value: '', group_label: '', group_summary: '',
  }], false);
  const s = db.createSession();
  db.setSessionProfile(s.id, family.id);
  const kid = db.getChildren(family.id)[0];

  const prompts = [];
  const fakeModel = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let facts = [];
      try {
        const body = JSON.parse(raw);
        prompts.push(body.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const parent = client('parentloop_session=' + s.id);
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await parent.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  await t.test('no saved check yet: latest says so and is stale', async () => {
    const latest = await parent.get('/api/parent/latest');
    assert.equal(latest.res.status, 200);
    assert.equal(latest.data.check, null);
    assert.equal(latest.data.stale, true);
  });

  await t.test('a real family runs at real local time, not the demo moment', async () => {
    prompts.length = 0;
    const run = await parent.post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    const prompt = prompts[0] || '';
    assert.ok(/Current moment: \w+day, \w+ \d+, \d{4}.*America\/Toronto time\)\. Tomorrow is \w+day/.test(prompt), 'real moment in the prompt');
    assert.ok(!prompt.includes('Simulated current moment') && !prompt.includes('November 5, 2026, 7:30 PM'), 'no demo moment');
    assert.ok(!prompt.includes('Maple Grove Elementary newsletter'), 'no demo source line');
    assert.equal(run.data.simulated_now, '', 'not a simulated run');
    assert.ok(run.data.logs.some((l) => /^current time: /.test(l.message)));
  });

  await t.test('the run is saved and served instantly, current until something changes', async () => {
    const latest = await parent.get('/api/parent/latest');
    assert.equal(latest.data.stale, false);
    assert.deepEqual((latest.data.check.relevant_facts || []).map((f) => f.id), ['wc-bake']);
    assert.ok(latest.data.ran_at && latest.data.moment_label);
    // A placement change alters what applies to the family: stale.
    const placed = await parent.post(`/api/hubs/${hub.id}/placements`, { placements: [{ child_id: kid.id, grade: '2', class: '' }] });
    assert.equal(placed.res.status, 200, placed.text.slice(0, 200));
    const after = await parent.get('/api/parent/latest');
    assert.equal(after.data.stale, true, 'placements changed since the saved check');
    assert.ok(after.data.check, 'the last check is still served while stale');
  });

  await t.test('a what-if run with simulated_now is not saved', async () => {
    await parent.post('/api/parent/run', {});
    const before = (await parent.get('/api/parent/latest')).data;
    assert.equal(before.stale, false);
    const whatIf = await parent.post('/api/parent/run', { simulated_now: 'Monday, December 7, 2026, 7:00 PM' });
    assert.equal(whatIf.res.status, 200);
    const after = (await parent.get('/api/parent/latest')).data;
    assert.equal(after.ran_at, before.ran_at, 'saved check unchanged');
  });

  await t.test('the demo keeps its simulated moment, prompt unchanged', async () => {
    prompts.length = 0;
    const demo = client();
    await demo.post('/api/profile/demo', {});
    const run = await demo.post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.ok(prompts[0].includes('Simulated current moment: Thursday, November 5, 2026, 7:30 PM. Tomorrow is Friday, November 6, 2026.'));
    assert.ok(prompts[0].includes('(source: School Agent facts from the Maple Grove Elementary newsletter)'));
    assert.equal(run.data.simulated_now, 'Thursday, November 5, 2026, 7:30 PM');
    const latest = await demo.get('/api/parent/latest');
    assert.equal(latest.data.stale, false, 'the demo check stays current: no day change for the demo');
  });

  await t.test('the page opens on the evening check for a family with a hub', () => {
    assert.ok(PAGE.includes('if (currentHubs.length) {\n      showView(\'evening\');\n      loadEveningHome();'), 'home is the evening check');
    assert.ok(PAGE.includes("withTimeout(fetch('/api/parent/latest')"), 'saved check loads first');
    assert.ok(PAGE.includes('if ((data.stale || !data.check) && visible) await runEveningCheck({ background: Boolean(data.check) });'),
      'stale or missing checks refresh while Tonight is open');
    assert.ok(PAGE.indexOf('id="tabEvening"') < PAGE.indexOf('id="tabHubs"'), 'Tonight tab first');
  });
});
