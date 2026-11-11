// Brief 024: one fact for an event and its own cost. A material that yields
// an event and a separate fact for that event's cost/payment stores ONE
// fact: the event, carrying the payment as its action. A fee with no event
// stays its own fact. Boot folds pairs stored before this, keeping family
// done marks on the surviving event. Fictional fixtures only; a stub model
// answers every extraction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { planEventCostFolds, foldEventCosts, isCostFact } = require('../event-dedupe');

const ROOT = path.join(__dirname, '..');
const PORT = 43300 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

const base = { hub_id: 'hub-a', material_id: 'mat-a', scope: 'class', scope_value: 'Lindqvist' };
function workshopFacts() {
  return [
    { ...base, id: 'w-event', type: 'event', title: 'Science Centre Workshop', date: '2026-12-01', action_required: true,
      action: 'Pay by December 1, 2026.', detail: 'Ms. Lindqvist’s class takes part in a Science Centre workshop.', source_text: 'quote one' },
    { ...base, id: 'w-theme', type: 'announcement', title: 'Workshop theme', date: '', action_required: false, action: '' },
    { ...base, id: 'w-two', type: 'event', title: 'Two workshops of 90 minutes each', date: '2026-12-01', action_required: false, action: '' },
    { ...base, id: 'w-cost', type: 'requirement', title: 'Workshop cost', date: '', action_required: true,
      action: 'Pay $12.00 per student on SchoolDay.', detail: 'The cost is $12.00 per student, paid on SchoolDay.', source_text: 'quote two' },
  ];
}

test('planEventCostFolds: the workshop and its cost become one event fact', () => {
  const { facts, folds } = planEventCostFolds(workshopFacts());
  assert.equal(folds.length, 1);
  assert.equal(folds[0].event_id, 'w-event');
  assert.equal(folds[0].cost_id, 'w-cost');
  assert.deepEqual(facts.map((f) => f.id), ['w-event', 'w-theme', 'w-two']);
  const event = facts[0];
  assert.equal(event.type, 'event');
  assert.equal(event.action_required, true);
  assert.equal(event.action, 'Pay $12.00 per student on SchoolDay.', 'the more specific action wins');
  assert.match(event.detail, /\$12\.00 per student/);
  assert.equal(event.source_text, 'quote one\n\nquote two');
  assert.equal(facts[2].action_required, false, 'the other workshop event is untouched');
});

test('planEventCostFolds: an event with no action takes the cost as its action', () => {
  const facts = foldEventCosts([
    { ...base, id: 'e', type: 'event', title: 'Grade 2 Farm Trip', date: '2026-11-20', action_required: false, action: '' },
    { ...base, id: 'c', type: 'deadline', title: 'Farm trip fee', date: '2026-11-20', action_required: true, action: 'Send $8 cash by Nov 20.' },
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, 'e');
  assert.equal(facts[0].action_required, true);
  assert.equal(facts[0].action, 'Send $8 cash by Nov 20.');
});

test('planEventCostFolds: standalone fees and unclear pairs are left alone', () => {
  // A fee with no event in the material.
  const fee = [{ ...base, id: 'fee', type: 'requirement', title: 'Yearbook fee', date: '', action_required: true, action: 'Pay $20 on SchoolDay.' }];
  assert.equal(isCostFact(fee[0]), true);
  assert.deepEqual(planEventCostFolds(fee).folds, []);
  // Different dates: not the same event.
  const dated = [
    { ...base, id: 'e', type: 'event', title: 'Science Centre Workshop', date: '2026-12-01', action_required: false },
    { ...base, id: 'c', type: 'requirement', title: 'Workshop cost', date: '2026-12-09', action_required: true, action: 'Pay $12.' },
  ];
  assert.deepEqual(planEventCostFolds(dated).folds, []);
  // A cost naming something the event title does not.
  const unrelated = [
    { ...base, id: 'e', type: 'event', title: 'Science Centre Workshop', date: '2026-12-01', action_required: false },
    { ...base, id: 'c', type: 'requirement', title: 'Pizza lunch cost', date: '', action_required: true, action: 'Pay $5.' },
  ];
  assert.deepEqual(planEventCostFolds(unrelated).folds, []);
  // A cost in a different material.
  const elsewhere = [
    { ...base, id: 'e', type: 'event', title: 'Science Centre Workshop', date: '2026-12-01', action_required: false },
    { ...base, material_id: 'mat-b', id: 'c', type: 'requirement', title: 'Workshop cost', date: '', action_required: true, action: 'Pay $12.' },
  ];
  assert.deepEqual(planEventCostFolds(elsewhere).folds, []);
  // Two matching events, neither already asking for payment: ambiguous.
  const twoEvents = [
    { ...base, id: 'e1', type: 'event', title: 'Morning workshop', date: '2026-12-01', action_required: false },
    { ...base, id: 'e2', type: 'event', title: 'Afternoon workshop', date: '2026-12-01', action_required: false },
    { ...base, id: 'c', type: 'requirement', title: 'Workshop cost', date: '', action_required: true, action: 'Pay $12.' },
  ];
  assert.deepEqual(planEventCostFolds(twoEvents).folds, []);
  // A requirement that is not a payment.
  const form = [
    { ...base, id: 'e', type: 'event', title: 'Science Centre Workshop', date: '2026-12-01', action_required: false },
    { ...base, id: 'c', type: 'requirement', title: 'Workshop permission form', date: '', action_required: true, action: 'Sign and return the form.' },
  ];
  assert.deepEqual(planEventCostFolds(form).folds, []);
});

test('boot fold: a stored event + cost pair folds once and keeps done marks', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-cost-fold-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  process.env.APP_DB_GCS_BUCKET = '';
  process.env.APP_DB_GCS_OBJECT = '';
  const db = require('../db');
  await db.initDb();

  const hub = db.createHub('fold-owner', 'Birchwood Public School', 'school');
  const material = db.createMaterial(hub.id, 'fold-owner', 'paste', 'Science Centre Workshop letter', 'letter text', 'extracted');
  db.insertFacts(hub.id, material.id, workshopFacts().map((f) => ({ ...f, id: 'bf-' + f.id, applies_to: 'Class Lindqvist' })));
  const lone = db.createMaterial(hub.id, 'fold-owner', 'paste', 'Yearbook', 'yearbook text', 'extracted');
  db.insertFacts(hub.id, lone.id, [
    { id: 'bf-yearbook', type: 'requirement', title: 'Yearbook fee', action_required: true, action: 'Pay $20 on SchoolDay.' },
  ]);
  const demoHub = db.getDemoHub();
  const demoMaterial = db.createMaterial(demoHub.id, '', 'paste', 'Demo workshop', 'demo text', 'extracted');
  db.insertFacts(demoHub.id, demoMaterial.id, workshopFacts().map((f) => ({ ...f, id: 'demo-' + f.id, hub_id: demoHub.id })));

  // One family marked the EVENT done (meaning "paid"); another marked the
  // COST fact done; a third marked nothing.
  const eventDone = db.createProfile({ parent_name: 'Event Done', children: [{ name: 'Kid A' }] });
  db.updateProfileActions(eventDone.id, { 'fact:bf-w-event': 'done' });
  const costDone = db.createProfile({ parent_name: 'Cost Done', children: [{ name: 'Kid B' }] });
  db.updateProfileActions(costDone.id, { 'fact:bf-w-cost': 'done', pizza_order: 'not_ordered' });
  const neither = db.createProfile({ parent_name: 'Neither', children: [{ name: 'Kid C' }] });
  db.saveEveningCheck(costDone.id, {
    result: { nudges: [{ fact_id: 'bf-w-cost', title: 'Workshop cost' }] }, ran_at: new Date().toISOString(), moment_label: '', fingerprint: 'x',
  });

  const actionsOf = (id) => JSON.parse(db.getProfileRowById(id).actions || '{}');
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  let folded;
  try {
    folded = db.foldEventCostFacts();
  } finally {
    console.log = origLog;
  }

  await t.test('the pair folds into the event, logged with hub, material and titles', () => {
    assert.equal(folded, 1);
    const facts = db.listFacts(hub.id).filter((f) => f.material_id === material.id);
    assert.deepEqual(facts.map((f) => f.id).sort(), ['bf-w-event', 'bf-w-theme', 'bf-w-two']);
    const event = facts.find((f) => f.id === 'bf-w-event');
    assert.equal(event.type, 'event');
    assert.equal(event.action_required, true);
    assert.equal(event.action, 'Pay $12.00 per student on SchoolDay.');
    const line = logs.find((l) => l.startsWith('event cost fold:'));
    assert.ok(line, logs.join('\n'));
    for (const part of ['Birchwood Public School', material.id, '"Workshop cost"', '"Science Centre Workshop"']) {
      assert.ok(line.includes(part), part + ' in: ' + line);
    }
  });

  await t.test('done marks land on the surviving event', () => {
    assert.equal(actionsOf(eventDone.id)['fact:bf-w-event'], 'done', 'event mark kept');
    const moved = actionsOf(costDone.id);
    assert.equal(moved['fact:bf-w-event'], 'done', 'cost mark carried to the event');
    assert.equal(moved.pizza_order, 'not_ordered', 'other actions untouched');
    assert.ok(!('fact:bf-w-event' in actionsOf(neither.id)), 'nothing invented');
    assert.equal(db.getEveningCheck(costDone.id), null, 'a saved check naming the removed fact is cleared');
  });

  await t.test('standalone fees and the demo hub are untouched', () => {
    assert.ok(db.listFacts(hub.id).some((f) => f.id === 'bf-yearbook'));
    assert.equal(db.listFacts(demoHub.id).filter((f) => f.material_id === demoMaterial.id).length, 4);
  });

  await t.test('a second run changes nothing', () => {
    assert.equal(db.foldEventCostFacts(), 0);
  });
});

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

const LETTER = 'ZZWorkshop letter. Our class will take part in a Science Centre Workshop on December 1, 2026. ' +
  'The cost is $12.00 per student, to be paid on SchoolDay by December 1.';
const FEE = 'ZZFee letter. The yearbook fee is $20, to be paid on SchoolDay.';

function fact(over) {
  return {
    id: 'x', type: 'event', title: '', detail: '', date: '', time: '', applies_to: 'all students', action_required: false,
    action: '', link: '', source_document: 'letter', source_text: '', published_at: '', extracted_at: '', confidence: 1,
    supersedes: '', group_label: '', group_summary: '', ...over,
  };
}

test('extraction stores one event fact for a workshop letter with a fee', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-cost-fold-x-'));
  // The stub answers as a model that split the event and its cost.
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let facts;
      if (raw.includes('ZZWorkshop letter')) {
        facts = [
          fact({ id: 'fact-1', title: 'Science Centre Workshop', date: '2026-12-01', detail: 'The class takes part in a Science Centre Workshop.',
            source_text: 'Our class will take part in a Science Centre Workshop on December 1, 2026.' }),
          fact({ id: 'fact-2', type: 'requirement', title: 'Workshop cost', action_required: true, action: 'Pay $12.00 per student on SchoolDay by December 1.',
            detail: 'The cost is $12.00 per student.', source_text: 'The cost is $12.00 per student, to be paid on SchoolDay by December 1.' }),
        ];
      } else {
        facts = [
          fact({ id: 'fact-1', type: 'requirement', title: 'Yearbook fee', action_required: true, action: 'Pay $20 on SchoolDay.',
            detail: 'The yearbook fee is $20.', source_text: 'The yearbook fee is $20, to be paid on SchoolDay.' }),
        ];
      }
      const content = JSON.stringify({ material_title: 'Letter', facts });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), PARENTLOOP_TEST_AUTH: '1',
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

  const parent = makeClient();
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await parent.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const prof = await parent.post('/api/profile', { parent_name: 'Fold Parent', parent_email: 'fold@example.com', children: [{ name: 'Fold Kid' }] });
  assert.equal(prof.res.status, 200, prof.text.slice(0, 300));
  assert.equal((await parent.post('/api/auth/test-complete', { sub: 'fold-parent', email: 'fold@example.com' })).res.status, 200);
  const made = await parent.post('/api/hubs', {
    school_name: 'Birchwood Public School', city: 'Fictionville', province: 'Ontario', country: 'Canada', kind: 'school',
  });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
  const hubId = made.data.hub.id;

  await t.test('the workshop letter yields exactly one event fact carrying the payment', async () => {
    const up = await parent.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text: LETTER });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    const facts = (await parent.get(`/api/hubs/${hubId}`)).data.facts.filter((f) => f.material_id === up.data.material.id);
    assert.equal(facts.length, 1, JSON.stringify(facts.map((f) => f.title)));
    assert.equal(facts[0].type, 'event');
    assert.equal(facts[0].title, 'Science Centre Workshop');
    assert.equal(facts[0].date, '2026-12-01');
    assert.equal(facts[0].action_required, true);
    assert.equal(facts[0].action, 'Pay $12.00 per student on SchoolDay by December 1.');
  });

  await t.test('a standalone fee still extracts as its own fact', async () => {
    const up = await parent.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text: FEE });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    const facts = (await parent.get(`/api/hubs/${hubId}`)).data.facts.filter((f) => f.material_id === up.data.material.id);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].title, 'Yearbook fee');
    assert.equal(facts[0].action_required, true);
  });
});

test('extraction prompts say an event and its own cost are one fact', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const rule = 'An event and its own cost are ONE fact';
  assert.equal(src.split(rule).length - 1, 2, 'text and image prompts both carry the rule');
  assert.ok(src.includes('A fee with no event of its own stays its own fact.'));
});
