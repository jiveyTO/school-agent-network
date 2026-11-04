// The evening check's two modes. Mode 1, app check: a just-joined member's
// Tonight check runs (or shows a real empty state at once when their hubs
// have no notes) and is saved; the page never leaves "Loading tonight's
// check…" up. Mode 2, agent check: a multi-hub family's token runs the
// prepared check across all its hubs (style a), and GET /api/agent/context
// returns the bundle to write it yourself (style b) — own placements, every
// member hub's materials and facts with quotes and cautions, ?since=, and
// nothing from a hub the family is not in (or a demo hub). Fictional
// fixtures only (Cedar Valley); the store is seeded in-process, then a
// server child serves the same file with a stub model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 41800 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function fact(id, title, quote, extra) {
  return {
    id, type: 'event', title, detail: title + '.', date: '2026-11-12', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'Cedar Valley notes (mock)', source_text: quote,
    published_at: '', extracted_at: '', confidence: 1, supersedes: '', scope: 'school', scope_value: '',
    group_label: 'Events', group_summary: '', ...(extra || {}),
  };
}

async function call(urlPath, { token, cookie, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${urlPath}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data, text };
}

test('evening check: app mode and agent mode', { timeout: 120000 }, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-evening-modes-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();

  // A founder family and its school hub with notes.
  const founder = db.createProfile({ parent_name: 'Cedar Founder', parent_email: 'cedar.founder@example.com', children: [{ name: 'Founder Kid Fictional' }] });
  const school = db.createHub(founder.id, 'Cedar Valley Public — Cedar Valley', 'school', {
    school_name: 'Cedar Valley Public', city: 'Cedar Valley', province: 'Ontario', country: 'Canada',
  });
  const m1 = db.createMaterial(school.id, founder.id, 'paste', 'Cedar Valley weekly (mock)', 'Pumpkin walk on Thursday.', 'extracted');
  db.insertFacts(school.id, m1.id, [fact('cv-pumpkin', 'Cedar Valley pumpkin walk', 'Pumpkin walk on Thursday.', { date: '2026-11-12' })], false);
  await new Promise((r) => setTimeout(r, 30));
  const midpoint = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 30));
  const m2 = db.createMaterial(school.id, founder.id, 'paste', 'Cedar Valley picture day (mock)', 'Picture day forms are due Friday.', 'extracted');
  db.insertFacts(school.id, m2.id, [fact('cv-picture', 'Cedar Valley picture day forms', 'Picture day forms are due Friday.', { date: '2026-11-13', action_required: true, action: 'Return the picture day form', confidence: 0.5 })], false);
  db.setPlacements(school.id, founder.id, [{ child_id: db.getChildren(founder.id)[0].id, grade: 'Grade 6', class: '6C' }]);

  // A team hub with notes, and a hub the multi-hub family is NOT in.
  const team = db.createHub(founder.id, 'Cedar Valley Hawks', 'team', {});
  const m3 = db.createMaterial(team.id, founder.id, 'paste', 'Hawks schedule (mock)', 'Hawks practice moves to Wednesday.', 'extracted');
  db.insertFacts(team.id, m3.id, [fact('cv-hawks', 'Hawks practice moves', 'Hawks practice moves to Wednesday.', { date: '2026-11-11' })], false);
  const outsider = db.createProfile({ parent_name: 'Pine Outsider', parent_email: 'pine.outsider@example.com', children: [{ name: 'Pine Kid Fictional' }] });
  const other = db.createHub(outsider.id, 'Pine Hollow Elementary — Pine Hollow', 'school', {
    school_name: 'Pine Hollow Elementary', city: 'Pine Hollow', province: 'Ontario', country: 'Canada',
  });
  const m4 = db.createMaterial(other.id, outsider.id, 'paste', 'Pine Hollow notes (mock)', 'Pine Hollow skating on Monday.', 'extracted');
  db.insertFacts(other.id, m4.id, [fact('ph-skate', 'Pine Hollow skating', 'Pine Hollow skating on Monday.', { date: '2026-11-09' })], false);

  // Mode 1 families: just joined the school hub; just joined an empty hub.
  const joined = db.createProfile({ parent_name: 'Juniper Joined', children: [{ name: 'Juniper Kid Fictional' }] });
  db.addMember(school.id, joined.id, 'member', 'invite');
  const emptyHub = db.createHub(founder.id, 'Cedar Valley Chess Club', 'team', {});
  const newcomer = db.createProfile({ parent_name: 'Nova Newcomer', children: [{ name: 'Nova Kid Fictional' }] });
  db.addMember(emptyHub.id, newcomer.id, 'member', 'invite');
  const sessionFor = (profile) => {
    const s = db.createSession();
    db.setSessionProfile(s.id, profile.id);
    return 'parentloop_session=' + s.id;
  };
  const joinedCookie = sessionFor(joined);
  const newcomerCookie = sessionFor(newcomer);

  // Mode 2 family: in the school hub and the team hub (and, through a demo
  // visitor's invite, the demo hub — which must never reach its check).
  const multi = db.createProfile({ parent_name: 'Maple Multi', parent_email: 'maple.multi@example.com', children: [{ name: 'Rowan Multi Fictional' }] });
  db.addMember(school.id, multi.id, 'member', 'invite');
  db.addMember(team.id, multi.id, 'member', 'invite');
  db.setPlacements(school.id, multi.id, [{ child_id: db.getChildren(multi.id)[0].id, grade: 'Grade 4', class: '4A' }]);
  const demoHub = db.getDemoHub();
  assert.ok(demoHub, 'the seeded demo hub exists');
  db.addMember(demoHub.id, multi.id, 'member', 'invite');
  const multiToken = db.createAgentToken(multi.id, 'Evening agent').token;

  const prompts = [];
  const fakeModel = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let facts = [];
      try {
        const body = JSON.parse(raw);
        const user = body.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
        prompts.push(user);
        facts = JSON.parse(user.split('School Agent facts:\n')[1] || '[]');
      } catch { facts = []; }
      const content = JSON.stringify({
        relevant_facts: facts.map((f) => ({ id: f.id, title: f.title })),
        nudges: [], calendar_hold: null, filtered_out_count: 0,
        filtering_summary: 'Everything here applies to this family.',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath,
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await call('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  const DEMO_OR_OUTSIDE = /Maya|Rivera|Maple Grove|pizza|Pine Hollow|Pine Kid|Founder Kid/i;

  await t.test('app check: a just-joined member gets a check, saved for Tonight', async () => {
    const before = await call('/api/parent/latest', { cookie: joinedCookie });
    assert.equal(before.res.status, 200, before.text.slice(0, 300));
    assert.equal(before.data.check, null, 'no check yet right after joining');
    assert.equal(before.data.stale, true, 'so Tonight runs one');
    prompts.length = 0;
    const run = await call('/api/parent/run', { cookie: joinedCookie, body: {} });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.deepEqual((run.data.relevant_facts || []).map((f) => f.id).sort(), ['cv-picture', 'cv-pumpkin']);
    assert.ok(run.data.logs.some((l) => /Juniper Kid Fictional/.test(l.message)), 'ran for the joined family');
    assert.ok(!DEMO_OR_OUTSIDE.test(run.text), 'no demo, outside-hub, or other-family data');
    assert.equal(prompts.length, 1, 'one model call');
    const after = await call('/api/parent/latest', { cookie: joinedCookie });
    assert.equal(after.data.stale, false, 'the saved check is current');
    assert.equal(after.data.check.relevant_count, 2);
  });

  await t.test('app check: a member whose hubs have no notes gets a real empty state at once', async () => {
    const before = await call('/api/parent/latest', { cookie: newcomerCookie });
    assert.equal(before.data.check, null);
    prompts.length = 0;
    const run = await call('/api/parent/run', { cookie: newcomerCookie, body: {} });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.equal(run.data.empty, true);
    assert.equal(run.data.empty_reason, 'no_notes_yet');
    assert.equal(run.data.checked_count, 0);
    assert.deepEqual(run.data.nudges, []);
    assert.match(run.data.filtering_summary, /no school notes yet/i);
    assert.ok(run.data.logs.some((l) => /^PRIVACY CHECK/.test(l.message)), 'privacy line still logged');
    assert.equal(prompts.length, 0, 'no model call for an empty check');
    const after = await call('/api/parent/latest', { cookie: newcomerCookie });
    assert.equal(after.data.stale, false);
    assert.equal(after.data.check.empty, true, 'Tonight shows the saved empty state');
  });

  await t.test('app check: the Tonight page never leaves the loading line up', () => {
    const home = PAGE.slice(PAGE.indexOf('async function loadEveningHome'), PAGE.indexOf('function showEveningPlaceholder'));
    assert.ok(home.length > 0, 'loadEveningHome found');
    assert.equal((home.match(/showEveningPlaceholder\(/g) || []).length, 3, 'failed load, no check, and a thrown error each show a real state');
    assert.match(PAGE, /result\.empty \|\| result\.checked_count === 0/, 'an empty check renders its own empty state');
    const run = PAGE.slice(PAGE.indexOf('async function runEveningCheck'), PAGE.indexOf("parentRunBtn.addEventListener('click'"));
    assert.equal((run.match(/No summary yet — that check didn’t finish/g) || []).length, 2, 'both failure paths replace the loading line');
  });

  await t.test('agent check (a): a multi-hub family\'s token runs the prepared check across its hubs', async () => {
    prompts.length = 0;
    const run = await call('/api/parent/run', { token: multiToken, body: {} });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    const ids = (run.data.relevant_facts || []).map((f) => f.id).sort();
    assert.deepEqual(ids, ['cv-hawks', 'cv-picture', 'cv-pumpkin'], 'facts from both member hubs, nothing else');
    assert.ok(!DEMO_OR_OUTSIDE.test(run.text), 'no demo-hub, outside-hub, or other-family data');
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('Hawks practice moves') && prompts[0].includes('Cedar Valley pumpkin walk'));
    assert.ok(!DEMO_OR_OUTSIDE.test(prompts[0]), 'the model never saw demo or outside data');
    const latest = await call('/api/parent/latest', { token: multiToken });
    assert.equal(latest.data.stale, false);
    assert.equal(latest.data.check.relevant_count, 3);
  });

  await t.test('agent check (b): the context bundle needs a token', async () => {
    assert.equal((await call('/api/agent/context')).res.status, 401, 'no token');
    assert.equal((await call('/api/agent/context', { cookie: joinedCookie })).res.status, 401, 'a browser session is not enough');
    assert.equal((await call('/api/agent/context', { token: 'pl_agent_not-a-real-token' })).res.status, 401, 'bad token');
    assert.equal((await call('/api/agent/context?since=not-a-date', { token: multiToken })).res.status, 400, 'bad since');
  });

  await t.test('agent check (b): the bundle covers member hubs only, with quotes and cautions', async () => {
    const { res, data, text } = await call('/api/agent/context', { token: multiToken });
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.deepEqual(data.hubs.map((h) => h.id).sort(), [school.id, team.id].sort(), 'exactly the family\'s non-demo hubs');
    for (const id of [other.id, demoHub.id, emptyHub.id]) assert.ok(!text.includes(id), 'non-member and demo hub ids absent');
    assert.ok(!DEMO_OR_OUTSIDE.test(text), 'no demo, outside-hub, or other-family content anywhere');
    assert.ok(!/@/.test(text), 'no email addresses');
    assert.ok(!/uploaded_by|created_by|members|email_from/.test(text), 'no contributor or roster fields');
    assert.ok(!text.includes(founder.id) && !text.includes(outsider.id), 'no other family ids');
    assert.deepEqual(data.family.children.map((c) => c.name), ['Rowan Multi Fictional']);
    const schoolHub = data.hubs.find((h) => h.id === school.id);
    assert.deepEqual(schoolHub.placements.map((p) => [p.child_name, p.grade, p.class]), [['Rowan Multi Fictional', 'Grade 4', '4A']], 'own placements only');
    assert.deepEqual(data.hubs.find((h) => h.id === team.id).placements, [], 'team hubs carry no placement');
    assert.deepEqual(schoolHub.facts.map((f) => f.id).sort(), ['cv-picture', 'cv-pumpkin']);
    const picture = schoolHub.facts.find((f) => f.id === 'cv-picture');
    assert.equal(picture.source_quote, 'Picture day forms are due Friday.');
    assert.equal(picture.action_required, true);
    assert.ok(picture.cautions.includes('quote_not_verified'), 'unverified quote is flagged');
    assert.ok(picture.cautions.includes('low_confidence'), 'low confidence is flagged');
    assert.ok(data.caution_flags.quote_not_verified && data.caution_flags.low_confidence, 'every flag is explained');
    assert.deepEqual(schoolHub.materials.map((m) => m.title).sort(), ['Cedar Valley picture day (mock)', 'Cedar Valley weekly (mock)']);
    assert.deepEqual(data.counts, { hubs: 2, materials: 3, facts: 3 });
  });

  await t.test('agent check (b): ?since= keeps only what was added after it', async () => {
    const { res, data } = await call('/api/agent/context?since=' + encodeURIComponent(midpoint), { token: multiToken });
    assert.equal(res.status, 200);
    assert.equal(data.since, midpoint);
    const schoolHub = data.hubs.find((h) => h.id === school.id);
    assert.deepEqual(schoolHub.facts.map((f) => f.id), ['cv-picture'], 'only the later material\'s fact');
    assert.deepEqual(schoolHub.materials.map((m) => m.title), ['Cedar Valley picture day (mock)']);
    assert.equal(schoolHub.placements.length, 1, 'placements still come with every bundle');
    const future = await call('/api/agent/context?since=2099-01-01T00:00:00Z', { token: multiToken });
    assert.deepEqual(future.data.counts, { hubs: 2, materials: 0, facts: 0 });
  });

  await t.test('demo regression: the demo session still gets the demo check', async () => {
    const demo = await call('/api/profile/demo', { body: {} });
    const cookie = String(demo.res.headers.get('set-cookie') || '').split(';')[0];
    const run = await call('/api/parent/run', { cookie, body: {} });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.ok(run.data.relevant_count > 1, 'demo facts were checked');
    assert.ok(!(run.data.relevant_facts || []).some((f) => /^cv-|^ph-/.test(f.id)), 'no real-family facts in the demo run');
  });
});
