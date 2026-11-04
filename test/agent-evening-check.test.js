// Brief 059: POST /api/parent/run honours the agent token. A valid token
// runs the evening check for ITS family (its hubs, children, facts) and never
// falls through to the demo family; a bad or revoked token gets 401; with no
// token a demo session still gets the demo check. All fixtures are fictional;
// the store is seeded in-process, then a server child serves the same file
// with a stub model that keeps every fact it is sent.
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

const FIXTURE_FACT = {
  id: 'br-skate-1', type: 'event', title: 'Birch Ridge skating afternoon',
  detail: 'Whole-school skating at Birch Ridge Arena.', date: '2026-11-06', time: '1:00 PM',
  applies_to: 'all students', action_required: false, action: '', link: '',
  source_document: 'Birch Ridge weekly (mock)', source_text: 'Skating afternoon at Birch Ridge Arena on Friday.',
  published_at: '', extracted_at: '', confidence: 1, supersedes: '', scope: 'school', scope_value: '',
  group_label: 'Events', group_summary: '',
};

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

test('evening check runs for the agent token\'s own family', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-evening-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();

  const family = db.createProfile({ parent_name: 'Birch Parent', children: [{ name: 'Wren Fictional' }] });
  const hub = db.createHub(family.id, 'Birch Ridge Public — Birch Ridge', 'school', {
    school_name: 'Birch Ridge Public', city: 'Birch Ridge', province: 'Ontario', country: 'Canada',
  });
  const material = db.createMaterial(hub.id, family.id, 'paste', 'Birch Ridge weekly (mock)', 'Skating afternoon at Birch Ridge Arena on Friday.', 'extracted');
  db.insertFacts(hub.id, material.id, [FIXTURE_FACT], false);
  const live = db.createAgentToken(family.id, 'Evening agent').token;
  const revoked = db.createAgentToken(family.id, 'Old agent');
  db.revokeAgentToken(family.id, revoked.record.id);

  // Stub model: for an evening-check prompt keep every input fact, no
  // nudges; record each prompt so the test can see whose data was sent.
  const prompts = [];
  const fakeModel = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let facts = [];
      try {
        const body = JSON.parse(raw);
        // The user message carries the family + facts; the system prompt has
        // fixed examples (e.g. "pizza_order") that are not family data.
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
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath,
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
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

  await t.test('a valid token gets its own family\'s check, never the demo', async () => {
    prompts.length = 0;
    const run = await call('/api/parent/run', { token: live, body: {} });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    const ids = (run.data.relevant_facts || []).map((f) => f.id);
    assert.deepEqual(ids, ['br-skate-1'], 'only the token family\'s fact is checked');
    assert.equal(run.data.relevant_count, 1);
    assert.equal(run.data.nudges.length, 0, 'no demo nudges');
    assert.equal(run.data.conflicts.length, 0, 'no demo conflicts');
    assert.ok(run.data.logs.some((l) => /Wren Fictional/.test(l.message)), 'run loaded the token family\'s child');
    assert.ok(!/Maya|Rivera|pizza/i.test(run.text), 'no demo family or demo newsletter content in the reply');
    assert.equal(prompts.length, 1, 'one evening-check model call');
    assert.ok(prompts[0].includes('Birch Ridge skating afternoon') && prompts[0].includes('Wren Fictional'), 'model saw this family\'s data');
    assert.ok(!/Maya|pizza/i.test(prompts[0]), 'model never saw demo data');
  });

  await t.test('the token reads its family\'s saved check instantly from /api/parent/latest', async () => {
    const latest = await call('/api/parent/latest', { token: live });
    assert.equal(latest.res.status, 200, latest.text.slice(0, 300));
    assert.equal(latest.data.stale, false, 'the run above is current');
    assert.deepEqual((latest.data.check.relevant_facts || []).map((f) => f.id), ['br-skate-1']);
    assert.ok(!/Maya|Rivera|pizza/i.test(latest.text), 'never the demo family');
    const bad = await call('/api/parent/latest', { token: 'pl_agent_not-a-real-token' });
    assert.equal(bad.res.status, 401, 'a bad token is refused here too');
  });

  await t.test('a garbage or revoked token gets 401, not the demo check', async () => {
    for (const bad of ['pl_agent_not-a-real-token', 'garbage', revoked.token]) {
      const run = await call('/api/parent/run', { token: bad, body: {} });
      assert.equal(run.res.status, 401, `token ${bad.slice(0, 12)}… refused`);
      assert.ok(!('nudges' in run.data), 'no evening-check payload on 401');
    }
  });

  await t.test('no token in a demo session still gets the demo check', async () => {
    prompts.length = 0;
    const demo = await call('/api/profile/demo', { body: {} });
    const cookie = String(demo.res.headers.get('set-cookie') || '').split(';')[0];
    const run = await call('/api/parent/run', { cookie, body: {} });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.ok(run.data.logs.some((l) => /Maya/.test(l.message)), 'demo family\'s child');
    assert.ok(!(run.data.relevant_facts || []).some((f) => f.id === 'br-skate-1'), 'no token-family fact in the demo run');
    assert.ok(run.data.relevant_count > 1, 'demo facts were checked');
  });
});
