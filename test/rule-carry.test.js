// Brief 061: a rule the source attaches to an item (a "no masks"
// parenthetical, "helmets required", "no rentals") must be carried into the
// note's detail or action, and the quote must then cover the rule too.
// Quote verification (057) is unchanged: a rule the source does not state
// cannot come with a quote that verifies, so that note is left out.
// Only quote-verified (parent-added) extractions get the rule; the demo
// school run keeps its prompt. Fictional fixtures only; a stub model answers
// per scenario and records the instructions it was sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 40600 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fact(id, fields) {
  return {
    id, type: 'event', title: '', detail: '', date: '', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'notice', source_text: '',
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
    ...fields,
  };
}

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
  return {
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    get: (p) => req(p),
  };
}

const RULE_MARKER = 'HARD RULE: when the source attaches a condition, restriction, prohibition, requirement, or exception';

test('rules and restrictions are carried into the note, not just the quote', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-rulecarry-'));
  const dbPath = path.join(tmpDir, 'app.db');
  let reply = () => '[]';
  let lastSystem = '';
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      const system = String(((body && body.messages) || [])[0] && body.messages[0].content || '');
      lastSystem = system;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply(system) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath,
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '',
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

  const client = makeClient();
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await client.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const prof = await client.post('/api/profile', {
    parent_name: 'Rule Founder', parent_email: 'rule.founder@example.com', children: [{ name: 'Rule Kid' }],
  });
  assert.equal(prof.res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Rule Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;
  const storedFacts = async (materialId) =>
    (await client.get(`/api/hubs/${hubId}`)).data.facts.filter((f) => f.material_id === materialId);

  await t.test('dress-up day: the "no masks" parenthetical lands in the detail and the fact verifies', async () => {
    const day = 'Wednesday, November 18 – SUPER HERO DAY: Dress as your favourite superhero to show your power to stop bullying! ' +
      '(PLEASE REMEMBER THAT YOU CANNOT COVER YOUR FACE WITH A MASK)';
    const poster = 'Cedar Valley Elementary – Anti-Bullying Week\n' +
      'Monday, November 16 – Pink Shirt Day: Wear pink to show kindness.\n' + day + '\n' +
      'Friday, November 20 – Spirit Day: Wear school colours.';
    reply = (system) => {
      assert.ok(system.includes(RULE_MARKER), 'parent extraction carries the rule instruction');
      assert.ok(system.includes('covers both the main claim and the rule'), 'quote must cover the rule too');
      return JSON.stringify([fact('rc-hero', {
        title: 'Super Hero Day', date: '2026-11-18',
        detail: 'Dress as your favourite superhero to show your power to stop bullying. No masks: faces must stay uncovered.',
        source_text: day,
      })]);
    };
    const up = await client.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text: poster });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual((up.data.facts || []).map((f) => f.id), ['rc-hero'], 'the fact is kept');
    assert.equal(up.data.material.unverified_count, 0);
    const [stored] = await storedFacts(up.data.material.id);
    assert.ok(stored.quote_verified, 'its whole-block quote verifies against the poster');
    assert.match(stored.detail, /mask/i, 'the restriction is in the note a parent reads');
    assert.match(stored.source_text, /CANNOT COVER YOUR FACE WITH A MASK/, 'the quote covers the rule as well as the headline');
  });

  await t.test('event poster image: "helmets required" and "no rentals" land in the detail or action', async () => {
    const transcript = 'Holiday Family Skate\nSaturday, December 19, 2026, 1:00 to 3:00 PM at Cedar Valley Arena.\n' +
      'Helmets required for all skaters under 10. No skate rentals on site.\nHot chocolate by donation.';
    const block = 'Saturday, December 19, 2026, 1:00 to 3:00 PM at Cedar Valley Arena.\n' +
      'Helmets required for all skaters under 10. No skate rentals on site.';
    reply = (system) => {
      assert.ok(system.includes(RULE_MARKER), 'image extraction carries the rule instruction too');
      return JSON.stringify({
        material_title: 'Holiday Family Skate poster',
        source_transcript: transcript,
        facts: [fact('rc-skate', {
          title: 'Holiday Family Skate', date: '2026-12-19', time: '1:00 PM',
          detail: 'Family skate at Cedar Valley Arena, 1 to 3 PM. Helmets are required for skaters under 10.',
          action_required: true, action: 'Bring your own skates (no rentals on site) and a helmet for kids under 10.',
          source_text: block,
        })],
      });
    };
    const up = await client.post(`/api/hubs/${hubId}/materials`, { kind: 'image', imageBase64: PNG_1X1, fileName: 'skate.png' });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual((up.data.facts || []).map((f) => f.id), ['rc-skate']);
    const [stored] = await storedFacts(up.data.material.id);
    assert.ok(stored.quote_verified, 'the multi-line block quote verifies against the transcript');
    const note = `${stored.detail} ${stored.action}`;
    assert.match(note, /helmet/i, 'helmet rule carried');
    assert.match(note, /no rentals|own skates/i, 'no-rentals rule carried');
  });

  await t.test('a restriction the source does not state fails verification as before', async () => {
    const text = 'Cedar Valley notice: Pyjama Day is Friday, November 20, 2026. Wear your favourite pyjamas.';
    reply = () => JSON.stringify([fact('rc-invented', {
      title: 'Pyjama Day', date: '2026-11-20',
      detail: 'Wear your favourite pyjamas. No slippers allowed.',
      source_text: 'Pyjama Day is Friday, November 20, 2026. Wear your favourite pyjamas. No slippers allowed.',
    })]);
    const up = await client.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts_added, 0, 'the note with an invented rule is left out');
    assert.equal(up.data.material.unverified_count, 1);
    assert.equal((await storedFacts(up.data.material.id)).length, 0);
  });

  await t.test('the demo school run keeps its prompt: no rule instruction there', async () => {
    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    reply = () => JSON.stringify([fact('rc-demo', {
      title: 'Demo run item', detail: 'A stub item for the demo run.', source_text: 'Maple Grove Elementary',
    })]);
    lastSystem = '';
    const run = await demo.post('/api/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 400));
    assert.ok(lastSystem.includes('Extract every discrete fact'), 'the demo run reached the model');
    assert.ok(!lastSystem.includes(RULE_MARKER), 'demo extraction prompt unchanged');
  });
});
