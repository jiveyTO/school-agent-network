// Brief 031: what a child wears or brings on a given day (theme days, wear
// a poppy, a food-bank item) is tonight's preparation for the parent.
// Extraction marks such a fact action_required with a prep action; the
// evening check nudges a wear-or-bring fact dated tomorrow even when the
// stored fact still carries action_required false. A plain event the same
// day and past theme days do not nudge. Fictional fixtures only (Birchwood
// Public School, the Okafor family). The live subtests make real model
// calls through the same routed pipeline the app uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// db.js reads APP_DB_PATH when first required; the durable-store vars are
// blanked before server.js loads .env so nothing can reach a real bucket.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-prep-day-'));
process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_DB_GCS_BUCKET = '';
process.env.APP_DB_GCS_OBJECT = '';
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const server = require('../server');
const db = require('../db');

const HUB = 'Birchwood Public School';
const SOURCE = 'Birchwood Public School weekly (mock)';
// Tuesday evening; tomorrow (Wednesday Nov 11) is wear-a-poppy day.
const MOMENT = {
  label: 'Tuesday, November 10, 2026 at 7:00 PM',
  tomorrow: 'Wednesday, November 11, 2026',
  simulated: false,
  day: '2026-11-10',
  today: '2026-11-10',
};

function fact(over) {
  return {
    id: 'x', type: 'event', title: '', detail: '', date: '', time: '', applies_to: 'all students',
    action_required: false, action: '', link: '', source_document: SOURCE, source_text: '',
    published_at: '', extracted_at: '', confidence: 1, supersedes: '', scope: 'school', scope_value: '',
    group_label: 'Anti-Bullying Week', group_summary: '', hub_id: 'hub-birchwood', hub_name: HUB, ...over,
  };
}

const PROFILE = {
  id: 'okafor', is_demo: false, parent_name: 'Ada Okafor',
  children: [{ name: 'Tobi Okafor' }], child: { name: 'Tobi Okafor' },
  soul: { priorities: ['school prep'], nudge_style: 'one short message in the evening', wishes: [] },
  actions: {},
};

test('prompts carry the wear-or-bring rule (no model call)', async (t) => {
  await t.test('every extraction prompt with the fact rules marks wear/bring days as actions', () => {
    for (const system of [server.buildPrompt('x').system, server.buildImagePrompt('x').system]) {
      assert.match(system, /WEAR or BRING on a specific day/);
      assert.match(system, /set action_required true/);
      assert.match(system, /"Wear a poppy"/);
      assert.match(system, /Keep the fact's type and date as they are/);
    }
  });

  await t.test('the parent check nudges wear/bring facts dated tomorrow, narrowly', () => {
    const { system } = server.buildParentPrompt(PROFILE, [], MOMENT, []);
    assert.match(system, /Tonight-prep exception/);
    assert.match(system, /dated tomorrow \(2026-11-11\)/, 'tomorrow is pinned as an ISO date');
    assert.match(system, /even when its action_required is false/);
    assert.match(system, /a plain event with nothing to prepare \(a ceremony, an assembly/);
    const demo = server.buildParentPrompt({ ...PROFILE, is_demo: true }, [], server.eveningMoment({ is_demo: true }), []).system;
    assert.match(demo, /dated tomorrow \(2026-11-06\)/, 'the demo moment resolves to its own tomorrow');
  });

  await t.test('the agent manifest generate mode follows the same rule', () => {
    const steps = server.AGENT_MANIFEST.evening_check_modes.agent_check.styles.generate.steps.join('\n');
    assert.match(steps, /tonight-prep, a fact dated tomorrow that names something the child should wear or bring/);
    assert.match(steps, /even when action_required is false/);
    assert.match(steps, /A plain event with nothing to prepare/);
  });

  await t.test('a re-extracted (action_required) theme day nudges only when due, never past', () => {
    const relevant = [
      fact({ id: 'pajama', title: 'Mismatched pajama day', date: '2026-11-09', action_required: true, action: 'Wear mismatched pajamas' }),
      fact({ id: 'poppy', title: 'Wear a poppy day', date: '2026-11-11', action_required: true, action: 'Wear a poppy' }),
    ].map((f) => ({ ...f, source: f.source_document }));
    const result = server.addDueSoonNudges({ relevant_facts: relevant, nudges: [], groups: [] }, PROFILE, MOMENT);
    assert.deepEqual(result.nudges.map((n) => n.fact_id), ['poppy']);
    assert.equal(result.nudges[0].action, 'Wear a poppy');
  });
});

const NEWSLETTER = [
  'Birchwood Public School — Weekly Update, week of November 9-13, 2026',
  '',
  'Anti-Bullying Week theme days',
  'Join us all week to show that kindness wins!',
  'Monday, November 9: Mismatched Pajama Day — wear mismatched pajamas to school.',
  'Tuesday, November 10: Pink Shirt Day — wear a pink shirt.',
  'Wednesday, November 11: Wear a Poppy — students are asked to wear a poppy.',
  'Thursday, November 12: Jersey Day — wear your favourite sports jersey.',
  'Friday, November 13: Superhero Day — dress as your favourite superhero.',
  '',
  'Remembrance Day Assembly',
  'Our Remembrance Day assembly is Wednesday, November 11 at 10:45 AM in the gym.',
].join('\n');

const THEME_DAYS = [
  { re: /pajama/i, date: '2026-11-09' },
  { re: /pink/i, date: '2026-11-10' },
  { re: /poppy/i, date: '2026-11-11' },
  { re: /jersey/i, date: '2026-11-12' },
  { re: /superhero/i, date: '2026-11-13' },
];

test('live extraction: theme days come out as prep actions', { timeout: 420000 }, async () => {
  await db.initDb();
  const hub = db.createHub('prep-owner', HUB, 'school');
  const material = db.createMaterial(hub.id, 'prep-owner', 'paste', 'Weekly update', NEWSLETTER, 'stored');
  const logs = [];
  await server.extractAndSaveFacts(NEWSLETTER, logs, hub.id, material.id, null, true, undefined, null, true);
  const facts = db.listFacts(hub.id).filter((f) => f.material_id === material.id);
  const text = (f) => `${f.title} ${f.detail} ${f.action}`;
  for (const day of THEME_DAYS) {
    const f = facts.find((x) => day.re.test(text(x)) && String(x.date).slice(0, 10) === day.date && !/assembly/i.test(x.title));
    assert.ok(f, `theme day ${day.re} on ${day.date} extracted: ${JSON.stringify(facts.map((x) => [x.title, x.date]))}`);
    assert.equal(f.action_required, true, `${f.title} is a prep action`);
    assert.ok(f.action && f.action.length > 0, `${f.title} carries a prep action`);
    assert.match(f.action, /wear|dress|bring|put on|lay out|find/i, `${f.title} action says what to get ready: ${f.action}`);
  }
});

test('live evening check: tomorrow\'s wear-a-poppy day nudges even when stored false', { timeout: 420000 }, async () => {
  // Facts as stored before brief 031: every theme day has action_required
  // false. Tomorrow carries the poppy day and a no-prep assembly; Monday's
  // pajama day is already past.
  const facts = [
    fact({ id: 'birch-pajama', title: 'Mismatched Pajama Day', detail: 'Students wear mismatched pajamas to school.', date: '2026-11-09',
      source_text: 'Monday, November 9: Mismatched Pajama Day — wear mismatched pajamas to school.' }),
    fact({ id: 'birch-poppy', title: 'Wear a Poppy Day', detail: 'Students are asked to wear a poppy.', date: '2026-11-11',
      source_text: 'Wednesday, November 11: Wear a Poppy — students are asked to wear a poppy.' }),
    fact({ id: 'birch-assembly', title: 'Remembrance Day Assembly', detail: 'Remembrance Day assembly in the gym.', date: '2026-11-11', time: '10:45 AM',
      group_label: 'Remembrance Day Assembly', source_text: 'Our Remembrance Day assembly is Wednesday, November 11 at 10:45 AM in the gym.' }),
  ];
  const push = () => {};
  const raw = await server.routedEveningRead({ ...PROFILE, placements: [] }, facts, MOMENT, [], push);
  const result = server.addDueSoonNudges(server.normalizeParentResult(raw, facts), PROFILE, MOMENT);
  const ids = result.nudges.map((n) => n.fact_id);
  assert.ok(ids.includes('birch-poppy'), `poppy day nudged: ${JSON.stringify(result.nudges)}`);
  const poppy = result.nudges.find((n) => n.fact_id === 'birch-poppy');
  assert.match(poppy.action, /poppy/i, 'the nudge says to get the poppy ready');
  assert.ok(!ids.includes('birch-assembly'), 'the assembly has nothing to prepare');
  assert.ok(!ids.includes('birch-pajama'), 'a past theme day does not nudge');
  assert.ok(result.relevant_facts.some((f) => f.id === 'birch-assembly'), 'the assembly still shows as a relevant fact');
});
