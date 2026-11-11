// Brief 032: a family's agent computes the evening check on its side and
// submits it back with POST /api/agent/evening-check. The check is stored in
// the same saved-check row the Tonight page, GET /api/parent/latest and the
// evening email read, with provenance (source agent, token name, time). Only
// facts the family can see are accepted. An app-side run the parent did not
// start (a token's POST /api/parent/run) does not replace it; the parent's
// own run in the app does. All fixtures are fictional; the store is seeded
// in-process, then a server child serves it with a stub model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 44000 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

function fact(id, extra) {
  return {
    id, type: 'event', title: id, detail: '', date: '2026-11-20', time: '', applies_to: 'all students',
    action_required: false, action: '', link: '', source_document: 'Fernhill weekly (mock)',
    source_text: `Quote for ${id}.`, published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    scope: 'school', scope_value: '', group_label: 'Events', group_summary: '',
    ...extra,
  };
}

async function call(urlPath, { token, cookie, body, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${BASE}${urlPath}`, { method: payload === undefined ? 'GET' : 'POST', headers, body: payload });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data, text };
}

const submit = (token, body, raw) => call('/api/agent/evening-check', { token, body, raw });

test('agent-submitted evening checks', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-submit-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  process.env.APP_DB_GCS_BUCKET = '';
  process.env.APP_DB_GCS_OBJECT = '';
  const db = require('../db');
  await db.initDb();

  const fern = db.createProfile({ parent_name: 'Fern Parent', children: [{ name: 'Juniper Fictional' }] });
  const fernHub = db.createHub(fern.id, 'Fernhill Public — Fernhill', 'school', {
    school_name: 'Fernhill Public', city: 'Fernhill', province: 'Ontario', country: 'Canada',
  });
  const fernMat = db.createMaterial(fernHub.id, fern.id, 'paste', 'Fernhill weekly (mock)', 'Fernhill notes (mock).', 'extracted');
  db.insertFacts(fernHub.id, fernMat.id, [
    fact('fh-concert', { title: 'Fernhill winter concert', time: '6:00 PM - 7:30 PM' }),
    fact('fh-form', { title: 'Field trip form', action_required: true, action: 'Sign the field trip form', type: 'deadline', date: '2026-11-19' }),
    fact('fh-practice', { title: 'Fernhill choir practice', time: '6:30 PM - 7:00 PM' }),
    fact('fh-grade7', { title: 'Grade 7 vaccination day', scope: 'grade', scope_value: 'Grade 7' }),
  ], false);

  const oak = db.createProfile({ parent_name: 'Oak Parent', children: [{ name: 'Rowan Fictional' }] });
  const oakHub = db.createHub(oak.id, 'Oakdale Public — Oakdale', 'school', {
    school_name: 'Oakdale Public', city: 'Oakdale', province: 'Ontario', country: 'Canada',
  });
  const oakMat = db.createMaterial(oakHub.id, oak.id, 'paste', 'Oakdale weekly (mock)', 'Oakdale notes (mock).', 'extracted');
  db.insertFacts(oakHub.id, oakMat.id, [fact('oak-skate', { title: 'Oakdale skating day' })], false);

  // A real family that wandered into a demo hub: demo facts never count.
  const demo = db.getDemoProfile();
  const demoHub = db.listHubsForProfile(demo.id)[0];
  db.addMember(demoHub.id, fern.id, 'member', 'invite');
  const demoFactId = db.listFacts(demoHub.id)[0].id;
  assert.equal(db.createAgentToken(demo.id, 'Demo agent'), null, 'the demo family cannot hold an agent token');

  const fernToken = db.createAgentToken(fern.id, 'Jivey test').token;
  const oakToken = db.createAgentToken(oak.id, 'Oak agent').token;
  const fernSession = db.createSession();
  db.setSessionProfile(fernSession.id, fern.id);
  const fernCookie = 'parentloop_session=' + fernSession.id;

  // Stub model: keeps every fact, no nudges.
  let modelCalls = 0;
  const fakeModel = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      modelCalls += 1;
      let facts = [];
      try {
        const body = JSON.parse(raw);
        const user = body.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
        facts = JSON.parse(user.split('School Agent facts:\n')[1] || '[]');
      } catch { facts = []; }
      const content = JSON.stringify({
        relevant_facts: facts.map((f) => ({ id: f.id, title: f.title })),
        nudges: [], calendar_hold: null, filtering_summary: 'App-side run (stub).',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  let serverOut = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath,
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '',
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { serverOut += c; });
  child.stderr.on('data', (c) => { serverOut += c; });
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

  const GOOD = {
    relevant_facts: [{ id: 'fh-concert' }, 'fh-form', { id: 'fh-practice' }],
    nudges: [{ fact_id: 'fh-form', title: 'Field trip form', action: 'Sign the field trip form tonight', deadline: '2026-11-19' }],
    conflicts: [{ fact_ids: ['fh-concert', 'fh-practice'], message: 'Choir practice overlaps the winter concert on Thu, Nov 20' }],
    filtered_out_count: 1,
    filtering_summary: 'Set aside the Grade 7 vaccination day (not Juniper\'s grade).',
  };

  await t.test('no token, a bad token, or an empty Authorization header gets 401', async () => {
    const none = await submit(undefined, GOOD);
    assert.equal(none.res.status, 401, none.text);
    const bad = await submit('pl_agent_not-a-real-token', GOOD);
    assert.equal(bad.res.status, 401);
    const empty = await fetch(`${BASE}/api/agent/evening-check`, { method: 'POST', headers: { Authorization: 'Bearer', 'Content-Type': 'application/json' }, body: JSON.stringify(GOOD) });
    assert.equal(empty.status, 401);
    const latest = await call('/api/parent/latest', { token: fernToken });
    assert.equal(latest.data.check, null, 'nothing was saved');
  });

  await t.test('malformed payloads are refused with a clear 400', async () => {
    const cases = [
      ['not json', undefined, '{nope'],
      ['an array', [], undefined],
      ['missing nudges', { relevant_facts: [] }, undefined],
      ['missing relevant_facts', { nudges: [] }, undefined],
      ['nudges not an array', { relevant_facts: [], nudges: 'fh-form' }, undefined],
      ['nudge without fact id', { relevant_facts: [], nudges: [{ action: 'Do it' }] }, undefined],
      ['nudge action not a string', { relevant_facts: [], nudges: [{ fact_id: 'fh-form', action: 7 }] }, undefined],
      ['relevant item without id', { relevant_facts: [{ title: 'x' }], nudges: [] }, undefined],
      ['negative filtered_out_count', { relevant_facts: [], nudges: [], filtered_out_count: -1 }, undefined],
      ['fractional filtered_out_count', { relevant_facts: [], nudges: [], filtered_out_count: 1.5 }, undefined],
      ['conflict with one fact', { relevant_facts: [], nudges: [], conflicts: [{ fact_ids: ['fh-concert'] }] }, undefined],
      ['conflict naming one fact twice', { relevant_facts: [], nudges: [], conflicts: [{ fact_ids: ['fh-concert', 'fh-concert'] }] }, undefined],
    ];
    for (const [label, body, raw] of cases) {
      const r = await submit(fernToken, body, raw);
      assert.equal(r.res.status, 400, `${label}: ${r.text.slice(0, 200)}`);
      assert.equal(r.data.ok, false, label);
      assert.ok(typeof r.data.error === 'string' && r.data.error.length > 10, `${label} explains itself`);
    }
    const latest = await call('/api/parent/latest', { token: fernToken });
    assert.equal(latest.data.check, null, 'nothing was saved');
  });

  await t.test('facts outside the family\'s visible hubs are refused', async () => {
    const otherHub = await submit(fernToken, { ...GOOD, relevant_facts: ['fh-concert', 'oak-skate'] });
    assert.equal(otherHub.res.status, 400);
    assert.match(otherHub.data.error, /oak-skate/, 'names the foreign fact id');
    const inNudge = await submit(fernToken, { ...GOOD, nudges: [{ fact_id: 'oak-skate', action: 'Skate' }] });
    assert.equal(inNudge.res.status, 400);
    const inConflict = await submit(fernToken, { ...GOOD, conflicts: [{ fact_ids: ['fh-concert', 'oak-skate'] }] });
    assert.equal(inConflict.res.status, 400);
    const outOfScope = await submit(fernToken, { ...GOOD, relevant_facts: ['fh-grade7'] });
    assert.equal(outOfScope.res.status, 400, 'a grade-scoped fact for another grade is not visible to this family');
    assert.match(outOfScope.data.error, /fh-grade7/);
    const demoFact = await submit(fernToken, { ...GOOD, relevant_facts: [demoFactId] });
    assert.equal(demoFact.res.status, 400, 'demo hub facts never count for a real family');
    const unknown = await submit(fernToken, { ...GOOD, relevant_facts: ['no-such-fact'] });
    assert.equal(unknown.res.status, 400);
    const latest = await call('/api/parent/latest', { token: fernToken });
    assert.equal(latest.data.check, null, 'nothing was saved');
  });

  await t.test('a token submits only for its own family', async () => {
    const oakTriesFern = await submit(oakToken, GOOD);
    assert.equal(oakTriesFern.res.status, 400, 'another family\'s fact ids are refused');
    const oakOwn = await submit(oakToken, { relevant_facts: ['oak-skate'], nudges: [] });
    assert.equal(oakOwn.res.status, 200, oakOwn.text.slice(0, 300));
    const fernLatest = await call('/api/parent/latest', { token: fernToken });
    assert.equal(fernLatest.data.check, null, 'Oak\'s submission never lands on Fern');
    const oakLatest = await call('/api/parent/latest', { token: oakToken });
    assert.deepEqual(oakLatest.data.check.relevant_facts.map((f) => f.id), ['oak-skate']);
    assert.equal(oakLatest.data.provenance.token_name, 'Oak agent');
  });

  await t.test('round trip: submit, then GET /api/parent/latest returns it with agent provenance', async () => {
    const before = Date.now();
    const sent = await submit(fernToken, GOOD);
    assert.equal(sent.res.status, 200, sent.text.slice(0, 400));
    assert.equal(sent.data.saved, true);
    for (const viewer of [{ token: fernToken }, { cookie: fernCookie }]) {
      const latest = await call('/api/parent/latest', viewer);
      assert.equal(latest.res.status, 200, latest.text.slice(0, 300));
      const { check, provenance } = latest.data;
      assert.equal(provenance.source, 'agent');
      assert.equal(provenance.token_name, 'Jivey test');
      assert.ok(Date.parse(provenance.submitted_at) >= before - 1000, 'submission time recorded');
      assert.equal(latest.data.ran_at, provenance.submitted_at);
      assert.equal(latest.data.stale, false, 'current against the facts it was checked on');
      assert.deepEqual(check.relevant_facts.map((f) => f.id), ['fh-concert', 'fh-form', 'fh-practice']);
      const concert = check.relevant_facts.find((f) => f.id === 'fh-concert');
      assert.equal(concert.title, 'Fernhill winter concert', 'fact details come from ParentLoop\'s copy');
      assert.equal(concert.hub_id, fernHub.id);
      assert.equal(check.nudges.length, 1);
      assert.equal(check.nudges[0].fact_id, 'fh-form');
      assert.equal(check.nudges[0].action, 'Sign the field trip form tonight');
      assert.equal(check.conflicts.length, 1);
      assert.equal(check.conflicts[0].fact_a.id, 'fh-concert');
      assert.equal(check.conflicts[0].fact_b.id, 'fh-practice');
      assert.equal(check.conflicts[0].message, GOOD.conflicts[0].message);
      assert.equal(check.filtered_out_count, 1);
      assert.equal(check.relevant_count, 3);
      assert.equal(check.summary, GOOD.filtering_summary);
      assert.equal(check.groups.length, 1, 'grouped by hub like an app check');
      assert.equal(check.groups[0].nudges.length, 1);
    }
    assert.match(serverOut, new RegExp(`agent-submitted check saved for family ${fern.id}`));
  });

  await t.test('a token-triggered app run does not replace the agent check; the parent\'s own run does', async () => {
    modelCalls = 0;
    const tokenRun = await call('/api/parent/run', { token: fernToken, body: {} });
    assert.equal(tokenRun.res.status, 200, tokenRun.text.slice(0, 300));
    assert.ok(modelCalls >= 1, 'the app-side run still ran and returned its result');
    assert.ok(tokenRun.data.logs.some((l) => /not saved: this family's saved check came from its agent/.test(l.message)), 'the run says it was not saved');
    assert.match(serverOut, new RegExp(`app-side refresh skipped for family ${fern.id}`), 'the skip is logged with the family id');
    const kept = await call('/api/parent/latest', { token: fernToken });
    assert.equal(kept.data.provenance.source, 'agent', 'the agent check is still the saved one');
    assert.equal(kept.data.check.nudges[0].action, 'Sign the field trip form tonight');

    const parentRun = await call('/api/parent/run', { cookie: fernCookie, body: {} });
    assert.equal(parentRun.res.status, 200, parentRun.text.slice(0, 300));
    const replaced = await call('/api/parent/latest', { cookie: fernCookie });
    assert.equal(replaced.data.provenance.source, 'app', 'the parent\'s run in the app takes over');
    assert.equal(replaced.data.check.summary, 'App-side run (stub).');

    // Back on app-side checks, a token run saves again as before.
    const again = await call('/api/parent/run', { token: fernToken, body: {} });
    assert.equal(again.res.status, 200);
    assert.ok(!again.data.logs.some((l) => /not saved/.test(l.message)));
  });
});
