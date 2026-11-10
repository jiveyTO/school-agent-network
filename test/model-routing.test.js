// Brief 022: Ember-first model routing. Material extraction and the evening
// check's relevance filtering run on muse-ember-1.0 first and escalate to
// muse-spark-1.3 only on a concrete failure signal:
//   extraction — the call fails or the reply does not parse, zero facts from
//     a non-trivial source, or fewer than half of its facts pass quote
//     verification;
//   evening check — the call fails or the reply does not parse, or more than
//     half of the relevant items it lists match no checked fact.
// SCHOOL_AGENT_MODEL_ROUTING=spark-only puts every call back on Spark with
// the pre-022 behavior. Every call logs a "model usage:" line with its
// model and token counts; every extraction/check logs a "model route:" line
// naming the accepted model. Fictional fixtures only; a stub model answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EMBER = 'muse-ember-1.0';
const SPARK = 'muse-spark-1.3';

function fact(id, title, quote, date) {
  return {
    id, type: 'event', title, detail: title + '.', date: date || '2026-11-20', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'notice', source_text: quote,
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  };
}

function makeClient(base) {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (cookie) opts.headers.Cookie = cookie;
    const res = await fetch(`${base}${urlPath}`, opts);
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
  return {
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    get: (p) => req(p),
  };
}

// A stub Meta Model API. `answer({ model, purpose })` returns
// { status, content } for each call; every call is recorded.
async function startFakeModel() {
  const fake = { calls: [], answer: () => ({ content: '[]' }) };
  fake.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
      const system = String((body.messages && body.messages[0] && body.messages[0].content) || '');
      const purpose = /Parent Agent|family profile/i.test(system) && !/extract every discrete fact/i.test(system)
        ? 'evening_check'
        : 'extraction';
      const call = { model: body.model, purpose };
      fake.calls.push(call);
      const out = fake.answer(call) || {};
      const status = out.status || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (status !== 200) {
        res.end(JSON.stringify({ error: { message: 'stub failure' } }));
        return;
      }
      res.end(JSON.stringify({
        model: body.model,
        choices: [{ message: { content: out.content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000, completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 100 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      }));
    });
  });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  return fake;
}

async function startServer(t, port, fake, extraEnv) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-routing-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(port),
      APP_DB_PATH: path.join(tmpDir, 'app.db'),
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fake.server.address().port}/chat`,
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '',
      SCHOOL_AGENT_MODEL: '', SCHOOL_AGENT_FAST_MODEL: '', SCHOOL_AGENT_MODEL_ROUTING: '',
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = { stdout: '' };
  child.stdout.on('data', (c) => { server.stdout += c; });
  child.stderr.on('data', (c) => { server.stdout += c; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const client = makeClient(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await client.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const prof = await client.post('/api/profile', {
    parent_name: 'Routing Founder', parent_email: 'routing.founder@example.com', children: [{ name: 'Routing Kid' }],
  });
  assert.equal(prof.res.status, 200, prof.text.slice(0, 300));
  const hub = await client.post('/api/hubs', { name: 'Routing Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200, hub.text.slice(0, 300));
  server.client = client;
  server.hubId = hub.data.hub.id;
  // Lines logged since `mark` that start with `prefix`, parsed.
  server.mark = () => server.stdout.length;
  server.lines = (prefix, mark) => server.stdout.slice(mark || 0).split('\n')
    .filter((l) => l.startsWith(prefix))
    .map((l) => JSON.parse(l.slice(prefix.length)));
  // stdout is piped; give the child a beat to flush after a response.
  server.settle = () => new Promise((r) => setTimeout(r, 150));
  return server;
}

// Each scenario gets its own text (brief 062 folds same-text duplicates).
let noticeN = 0;
function notice() {
  noticeN += 1;
  return `Cedar Valley notice ${noticeN}: The Fall Fun Fair is on Friday, November 20, 2026 in the gym. ` +
    'Reply forms are due Wednesday, November 18, 2026. Photo day is Thursday, November 12, 2026 for all students.';
}
const Q_FAIR = 'The Fall Fun Fair is on Friday, November 20, 2026 in the gym.';
const Q_FORMS = 'Reply forms are due Wednesday, November 18, 2026.';
const Q_PHOTO = 'Photo day is Thursday, November 12, 2026 for all students.';
const goodFacts = (p) => [
  fact(`${p}-fair`, 'Fall Fun Fair', Q_FAIR),
  fact(`${p}-forms`, 'Reply forms due', Q_FORMS, '2026-11-18'),
  fact(`${p}-photo`, 'Photo day', Q_PHOTO, '2026-11-12'),
];
const mostlyInvented = (p) => [
  fact(`${p}-fair`, 'Fall Fun Fair', Q_FAIR),
  fact(`${p}-bake`, 'Bake sale', 'A bake sale runs all week in the lobby.', '2026-11-23'),
  fact(`${p}-trip`, 'Field trip', 'Grade 4 visits the science centre on Monday.', '2026-11-16'),
];

test('Ember-first routing (the default)', async (t) => {
  const fake = await startFakeModel();
  t.after(() => fake.server.close());
  const srv = await startServer(t, 43400 + (process.pid % 90), fake);
  const add = (text) => srv.client.post(`/api/hubs/${srv.hubId}/materials`, { kind: 'paste', text });

  await t.test('boot names the routing', () => {
    assert.match(srv.stdout, /Model routing: ember-first \(extraction \+ evening check on muse-ember-1\.0 first, escalating to muse-spark-1\.3/);
  });

  await t.test('a clean Ember extraction is accepted with one call, and usage is logged', async () => {
    fake.calls = [];
    fake.answer = () => ({ content: JSON.stringify(goodFacts('ok')) });
    const mark = srv.mark();
    const up = await add(notice());
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER]);
    assert.equal(up.data.facts_added, 3);
    assert.equal(up.data.material.unverified_count, 0);
    assert.ok(up.data.logs.some((l) => l.message === `extraction accepted from ${EMBER}`), 'run log names the accepted model');
    await srv.settle();
    const [usage] = srv.lines('model usage: ', mark);
    assert.equal(usage.purpose, 'extraction');
    assert.equal(usage.model, EMBER);
    assert.equal(usage.prompt_tokens, 1000);
    assert.equal(usage.cached_tokens, 100);
    assert.equal(usage.completion_tokens, 200);
    assert.equal(usage.reasoning_tokens, 50);
    // 900 x $0.10 + 100 x $0.004 + 200 x $0.50 per 1M tokens.
    assert.equal(usage.est_usd, 0.00019);
    // Same tokens on Spark: 1000 x $1.25 + 200 x $4.25 per 1M.
    assert.equal(usage.spark_equiv_usd, 0.0021);
    const [route] = srv.lines('model route: ', mark);
    assert.equal(route.purpose, 'extraction');
    assert.equal(route.accepted_model, EMBER);
    assert.equal(route.escalated, false);
    assert.equal(route.calls, 1);
    assert.equal(route.facts, 3);
    assert.equal(route.quotes_verified, 3);
    assert.ok(!/Fall Fun Fair|Cedar Valley/.test(srv.stdout), 'usage/route lines carry no material text');
  });

  await t.test('fewer than half the quotes verify: escalates to Spark, Spark read is kept', async () => {
    fake.calls = [];
    fake.answer = ({ model }) => ({ content: JSON.stringify(model === EMBER ? mostlyInvented('lo') : goodFacts('lo')) });
    const mark = srv.mark();
    const up = await add(notice());
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER, SPARK]);
    assert.equal(up.data.facts_added, 3);
    assert.equal(up.data.material.unverified_count, 0, 'the escalated-past Ember read leaves no rejections behind');
    assert.ok(up.data.logs.some((l) => /escalating to muse-spark-1\.3/.test(l.message)));
    assert.ok(up.data.logs.some((l) => l.message === `extraction accepted from ${SPARK}`));
    await srv.settle();
    const [route] = srv.lines('model route: ', mark);
    assert.equal(route.accepted_model, SPARK);
    assert.equal(route.escalated, true);
    assert.equal(route.reason, 'quote verification kept 1 of 3');
    assert.equal(route.calls, 2);
    assert.deepEqual(srv.lines('model usage: ', mark).map((u) => u.model), [EMBER, SPARK]);
  });

  await t.test('exactly half the quotes verify: no escalation', async () => {
    fake.calls = [];
    fake.answer = () => ({ content: JSON.stringify([
      fact('half-fair', 'Fall Fun Fair', Q_FAIR),
      fact('half-forms', 'Reply forms due', Q_FORMS, '2026-11-18'),
      fact('half-bake', 'Bake sale', 'A bake sale runs all week in the lobby.', '2026-11-23'),
      fact('half-trip', 'Field trip', 'Grade 4 visits the science centre on Monday.', '2026-11-16'),
    ]) });
    const up = await add(notice());
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER]);
    assert.equal(up.data.facts_added, 2);
    assert.equal(up.data.material.unverified_count, 2);
  });

  await t.test('Spark keeps fewer notes than Ember: the Ember read stays', async () => {
    fake.calls = [];
    fake.answer = ({ model }) => ({ content: JSON.stringify(model === EMBER ? mostlyInvented('kf') : []) });
    const up = await add(notice());
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER, SPARK]);
    assert.equal(up.data.facts_added, 1, 'the one verified Ember note is not thrown away');
    assert.ok(up.data.logs.some((l) => l.message === `extraction accepted from ${EMBER}`));
  });

  await t.test('an Ember API error escalates to Spark', async () => {
    fake.calls = [];
    fake.answer = ({ model }) => (model === EMBER ? { status: 500 } : { content: JSON.stringify(goodFacts('err')) });
    const mark = srv.mark();
    const up = await add(notice());
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER, SPARK]);
    assert.equal(up.data.facts_added, 3);
    await srv.settle();
    const [route] = srv.lines('model route: ', mark);
    assert.equal(route.reason, 'reply failed: Meta Model API error 500');
    const usage = srv.lines('model usage: ', mark);
    assert.equal(usage[0].status, 500, 'a failed call still logs a usage line');
  });

  await t.test('an unparseable Ember reply escalates to Spark', async () => {
    fake.calls = [];
    fake.answer = ({ model }) => ({ content: model === EMBER ? 'Sorry, here are the facts: none' : JSON.stringify(goodFacts('np')) });
    const up = await add(notice());
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER, SPARK]);
    assert.equal(up.data.facts_added, 3);
  });

  // The hub now holds the ok-/lo-/half-/kf-/err-/np- facts.
  // One id per distinct event: the check folds same-event facts from
  // different materials (the Fall Fun Fair appears in most of them).
  const hubFactIds = async () => {
    const seen = new Set();
    return (await srv.client.get(`/api/hubs/${srv.hubId}`)).data.facts
      .filter((f) => !seen.has(f.title) && seen.add(f.title))
      .map((f) => f.id);
  };
  const eveningReply = (ids) => JSON.stringify({
    relevant_facts: ids,
    nudges: [{ fact_id: ids[0], title: 'Stub nudge', action: 'Do the thing', deadline: '2026-11-18' }],
    calendar_hold: null,
    filtering_summary: 'stub',
  });

  await t.test('evening check: a valid Ember reply is accepted with one call', async () => {
    const ids = await hubFactIds();
    fake.calls = [];
    assert.equal(ids.length, 3, 'three distinct verified events in the hub (Fair, Forms, Photo day)');
    fake.answer = () => ({ content: eveningReply(ids) });
    const mark = srv.mark();
    const run = await srv.client.post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER]);
    assert.equal(run.data.relevant_count, 3);
    assert.ok(run.data.logs.some((l) => l.message === `API called: POST http://127.0.0.1:${fake.server.address().port}/chat (model: ${EMBER})`));
    await srv.settle();
    const [route] = srv.lines('model route: ', mark);
    assert.equal(route.purpose, 'evening_check');
    assert.equal(route.accepted_model, EMBER);
    assert.equal(route.escalated, false);
    const [usage] = srv.lines('model usage: ', mark);
    assert.equal(usage.purpose, 'evening_check');
    assert.equal(usage.model, EMBER);
  });

  await t.test('evening check: mostly invented ids escalate to Spark', async () => {
    const ids = await hubFactIds();
    fake.calls = [];
    fake.answer = ({ model }) => ({ content: eveningReply(model === EMBER ? [ids[0], 'made-up-1', 'made-up-2'] : ids.slice(0, 3)) });
    const mark = srv.mark();
    const run = await srv.client.post('/api/parent/run', { simulated_now: 'Thursday, December 3, 2026, 6:00 PM' });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER, SPARK]);
    assert.equal(run.data.relevant_count, 3);
    await srv.settle();
    const [route] = srv.lines('model route: ', mark);
    assert.equal(route.accepted_model, SPARK);
    assert.equal(route.reason, '2 of 3 relevant items match no checked fact');
  });

  await t.test('evening check: an unparseable Ember reply escalates to Spark', async () => {
    const ids = await hubFactIds();
    fake.calls = [];
    fake.answer = ({ model }) => ({ content: model === EMBER ? 'not json at all' : eveningReply(ids.slice(0, 2)) });
    const run = await srv.client.post('/api/parent/run', { simulated_now: 'Friday, December 4, 2026, 6:00 PM' });
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.deepEqual(fake.calls.map((c) => c.model), [EMBER, SPARK]);
    assert.equal(run.data.relevant_count, 2);
  });
});

test('SCHOOL_AGENT_MODEL_ROUTING=spark-only flips every call back to Spark', async (t) => {
  const fake = await startFakeModel();
  t.after(() => fake.server.close());
  const srv = await startServer(t, 43600 + (process.pid % 90), fake, { SCHOOL_AGENT_MODEL_ROUTING: 'spark-only' });

  await t.test('boot names the routing', () => {
    assert.match(srv.stdout, /Model routing: spark-only \(all calls on muse-spark-1\.3/);
  });

  await t.test('extraction runs on Spark only; a low quote pass rate does not re-run it', async () => {
    fake.calls = [];
    fake.answer = () => ({ content: JSON.stringify(mostlyInvented('so')) });
    const mark = srv.mark();
    const up = await srv.client.post(`/api/hubs/${srv.hubId}/materials`, { kind: 'paste', text: notice() });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [SPARK]);
    assert.equal(up.data.facts_added, 1);
    assert.equal(up.data.material.unverified_count, 2);
    await srv.settle();
    const [route] = srv.lines('model route: ', mark);
    assert.equal(route.routing, 'spark-only');
    assert.equal(route.accepted_model, SPARK);
    assert.equal(route.escalated, false);
    const [usage] = srv.lines('model usage: ', mark);
    assert.equal(usage.model, SPARK);
    assert.equal(usage.spark_equiv_usd, undefined);
  });

  await t.test('an empty read still retries once on Spark', async () => {
    fake.calls = [];
    let n = 0;
    fake.answer = () => ({ content: JSON.stringify((n += 1) === 1 ? [] : goodFacts('sr')) });
    const up = await srv.client.post(`/api/hubs/${srv.hubId}/materials`, { kind: 'paste', text: notice() });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual(fake.calls.map((c) => c.model), [SPARK, SPARK]);
    assert.equal(up.data.facts_added, 3);
  });

  await t.test('the evening check runs on Spark with one call', async () => {
    const ids = (await srv.client.get(`/api/hubs/${srv.hubId}`)).data.facts.map((f) => f.id);
    fake.calls = [];
    fake.answer = () => ({ content: JSON.stringify({ relevant_facts: [ids[0], 'made-up-1', 'made-up-2'], nudges: [], calendar_hold: null }) });
    const run = await srv.client.post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.deepEqual(fake.calls.map((c) => c.model), [SPARK], 'no escalation logic in spark-only');
    assert.equal(run.data.relevant_count, 1);
  });
});
