const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  normalizeEventTitle,
  isSameEvent,
  mergeSameEventFacts,
  detectConflicts,
} = require('../event-dedupe');

// Fictional fixtures only (Cedar Valley / Birchwood). Nothing here comes from
// a real school newsletter.

function makeFact(overrides) {
  return Object.assign(
    {
      id: 'fact-test-1',
      hub_id: 'hub-cedar-1',
      hub_name: 'Cedar Valley Elementary',
      hub: 'Cedar Valley Elementary',
      material_id: 'mat-poster',
      type: 'event',
      title: 'Civvies Day',
      detail: '',
      date: '2026-11-27',
      time: '',
      applies_to: 'all students',
      action_required: false,
      action: '',
      link: '',
      source_document: 'Cedar Valley newsletter (mock)',
      source_text: 'Civvies Day is November 27. (poster section)',
      published_at: '',
      extracted_at: '2026-10-30T00:00:00.000Z',
      confidence: 0.9,
      supersedes: '',
      scope: 'school',
      scope_value: '',
      group_label: 'Poster',
      group_summary: '',
    },
    overrides || {}
  );
}

test('same event named in two sections of one material is one fact with no conflict', () => {
  const poster = makeFact({
    id: 'fact-civvies-poster',
    title: 'Civvies Day',
    group_label: 'Poster',
    source_text: 'CIVVIES DAY — Friday November 27! (poster section)',
  });
  const lookingAhead = makeFact({
    id: 'fact-civvies-ahead',
    material_id: 'mat-poster',
    title: 'Civvies Day November 27',
    group_label: 'Looking Ahead',
    source_text: 'Nov 27 — Civvies Day. (Looking Ahead list)',
  });
  assert.equal(isSameEvent(poster, lookingAhead), true);
  assert.deepEqual(detectConflicts([poster, lookingAhead]), []);
  const merged = mergeSameEventFacts([poster, lookingAhead]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'Civvies Day November 27');
  assert.ok(merged[0].source_text.includes('poster section'));
  assert.ok(merged[0].source_text.includes('Looking Ahead'));
  assert.ok(merged[0].group_label.includes('Poster'));
  assert.ok(merged[0].group_label.includes('Looking Ahead'));
});

test('duplicates arriving via two different materials in one hub produce no conflict', () => {
  const fromPoster = makeFact({
    id: 'fact-interviews-a',
    material_id: 'mat-poster',
    title: 'Parent/Teacher Interviews PM',
    date: '2026-11-19',
    time: '1:00 PM - 8:00 PM',
    group_label: 'Poster',
    source_document: 'Cedar Valley poster (mock)',
    source_text: 'Parent/Teacher Interviews PM — book a slot. (poster)',
  });
  const fromNotice = makeFact({
    id: 'fact-interviews-b',
    material_id: 'mat-office-notice',
    title: 'Parent/Teacher Interviews PM November 19',
    date: '2026-11-19',
    time: '',
    group_label: 'Dates to Remember',
    source_document: 'Cedar Valley office notice (mock)',
    source_text: 'November 19: Parent/Teacher Interviews PM. (office notice)',
  });
  assert.equal(isSameEvent(fromPoster, fromNotice), true);
  assert.deepEqual(detectConflicts([fromPoster, fromNotice]), []);
  const merged = mergeSameEventFacts([fromPoster, fromNotice]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'Parent/Teacher Interviews PM November 19');
  assert.ok(merged[0].source_text.includes('(poster)'));
  assert.ok(merged[0].source_text.includes('(office notice)'));
  assert.ok(merged[0].source_document.includes('poster'));
  assert.ok(merged[0].source_document.includes('office notice'));
  // The timed poster slot survives the merge.
  assert.equal(merged[0].time, '1:00 PM - 8:00 PM');
});

test('reported real-world duplicate pairs are same-event, not conflicts', () => {
  const pairs = [
    [
      makeFact({ id: 'a1', title: 'Anti-Bullying Week Nov 9-13', date: '2026-11-09' }),
      makeFact({ id: 'a2', title: 'Anti-Bullying Week November 9-11', date: '2026-11-09' }),
    ],
    [
      makeFact({ id: 'b1', title: 'Super Hero Day', date: '2026-10-30' }),
      makeFact({
        id: 'b2',
        type: 'requirement',
        title: 'No face-covering masks on Super Hero Day',
        date: '2026-10-30',
      }),
    ],
  ];
  for (const [a, b] of pairs) {
    assert.equal(isSameEvent(a, b), true, `${a.title} vs ${b.title}`);
    assert.deepEqual(detectConflicts([a, b]), [], `${a.title} vs ${b.title}`);
    assert.equal(mergeSameEventFacts([a, b]).length, 1);
  }
  // The containment merge keeps the shared core as the title.
  const hero = mergeSameEventFacts(pairs[1]);
  assert.equal(hero[0].title, 'Super Hero Day');
});

test('normalization handles case, punctuation, and spelled-or-numeric dates', () => {
  assert.equal(normalizeEventTitle('Civvies Day November 27'), 'civvies day');
  assert.equal(normalizeEventTitle('Civvies Day Nov 27'), 'civvies day');
  assert.equal(normalizeEventTitle('  CIVVIES DAY! '), 'civvies day');
  assert.equal(
    normalizeEventTitle('Anti-Bullying Week November 9-11'),
    normalizeEventTitle('anti bullying week nov 9-13')
  );
});

test('distinct events on the same day still conflict', () => {
  const dance = makeFact({
    id: 'fact-dance',
    title: 'Fall Festival Dance',
    date: '2026-11-06',
  });
  const cookies = makeFact({
    id: 'fact-cookies',
    title: 'Helping Hands Club selling Cookies and Popcorn',
    date: '2026-11-06',
  });
  const game = makeFact({
    id: 'fact-game',
    hub_id: 'hub-birchwood-1',
    hub_name: 'Birchwood Hockey',
    hub: 'Birchwood Hockey',
    title: 'U9 Hockey game',
    date: '2026-11-06',
    time: '6:30 PM-7:30 PM',
  });
  assert.equal(isSameEvent(dance, cookies), false);
  assert.equal(isSameEvent(dance, game), false);
  const conflicts = detectConflicts([dance, cookies, game]);
  assert.equal(conflicts.length, 3);
});

test('same title on the same date in different hubs still conflicts', () => {
  const a = makeFact({ id: 'x1', title: 'Civvies Day', date: '2026-11-27' });
  const b = makeFact({
    id: 'x2',
    hub_id: 'hub-other',
    hub_name: 'Birchwood Elementary',
    hub: 'Birchwood Elementary',
    title: 'Civvies Day',
    date: '2026-11-27',
  });
  assert.equal(isSameEvent(a, b), false);
  assert.equal(detectConflicts([a, b]).length, 1);
});

test('same title on different dates never conflicts', () => {
  const a = makeFact({ id: 'y1', title: 'Civvies Day', date: '2026-11-27' });
  const b = makeFact({ id: 'y2', title: 'Civvies Day November 27', date: '2026-12-11' });
  assert.equal(isSameEvent(a, b), false);
  assert.deepEqual(detectConflicts([a, b]), []);
});

test('facts scoped to different audiences are not merged', () => {
  const schoolWide = makeFact({ id: 's1', title: 'Author Visit', date: '2026-11-20' });
  const classOnly = makeFact({
    id: 's2',
    title: 'Author Visit',
    date: '2026-11-20',
    scope: 'class',
    scope_value: '3B',
  });
  assert.equal(isSameEvent(schoolWide, classOnly), true);
  assert.deepEqual(detectConflicts([schoolWide, classOnly]), []);
  // Same event, so no conflict — but the class-scoped copy must survive the merge.
  assert.equal(mergeSameEventFacts([schoolWide, classOnly]).length, 2);
});

test('evening check result merges duplicates but keeps real conflicts', () => {
  const server = require('../server.js');
  const poster = makeFact({
    id: 'fact-eve-a',
    title: 'Civvies Day',
    group_label: 'Poster',
    source_text: 'Civvies Day poster quote.',
  });
  const ahead = makeFact({
    id: 'fact-eve-b',
    title: 'Civvies Day November 27',
    group_label: 'Looking Ahead',
    source_text: 'Civvies Day notice quote.',
  });
  const concert = makeFact({
    id: 'fact-eve-c',
    title: 'Winter Concert',
    group_label: 'Looking Ahead',
    source_text: 'Winter Concert quote.',
  });
  const result = server.normalizeParentResult(
    {
      relevant_facts: [{ id: 'fact-eve-a' }, { id: 'fact-eve-b' }, { id: 'fact-eve-c' }],
      nudges: [],
      calendar_hold: null,
      filtering_summary: 'all apply',
    },
    [poster, ahead, concert]
  );
  assert.equal(result.relevant_facts.length, 2);
  assert.equal(result.relevant_facts[0].title, 'Civvies Day November 27');
  assert.equal(result.filtered_out_count, 1);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /Winter Concert/);
  assert.match(result.conflicts[0].message, /Civvies Day November 27/);
});

test('seeded demo facts still yield exactly the 3 real Fri Nov 6 conflicts', () => {
  const db = require('../db');
  const seedFacts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'facts.json'), 'utf8'));
  const hubA = seedFacts.map((f) =>
    Object.assign({}, f, {
      hub_id: 'hub-demo-a',
      hub_name: 'Maple Grove Elementary',
      hub: 'Maple Grove Elementary',
    })
  );
  const hubB = db.HOCKEY_FACTS.map((f) =>
    Object.assign({}, f, {
      hub_id: 'hub-demo-b',
      hub_name: 'U9 Hockey — Maple Grove',
      hub: 'U9 Hockey — Maple Grove',
    })
  );
  const conflicts = detectConflicts(hubA.concat(hubB));
  assert.equal(conflicts.length, 3);
  const text = conflicts.map((c) => c.message).join('\n');
  assert.match(text, /Fall Festival Dance/);
  assert.match(text, /Helping Hands Club selling Cookies and Popcorn/);
  assert.match(text, /U9 Hockey game/);
  assert.match(text, /Nov 6/);
  for (const c of conflicts) {
    assert.equal(isSameEvent(c.fact_a, c.fact_b), false);
  }
});

test('insertFacts merges cross-material duplicates inside one hub (db layer)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-dedupe-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  const db = require('../db');
  await db.initDb();
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const profile = db.createProfile({
    parent_name: 'Dedupe Dan',
    child_name: 'Dedupe Kid',
    grade: 'Grade 3',
    class_name: '3B',
    school_name: 'Cedar Valley Elementary',
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  const hub = db.createHub(profile.id, 'Cedar Valley Elementary — Cedar Valley', 'school', {
    school_name: 'Cedar Valley Elementary',
    city: 'Cedar Valley',
    province: 'Ontario',
    country: 'Canada',
  });
  db.addMember(hub.id, profile.id, 'admin', 'founder');
  const matA = db.createMaterial(hub.id, profile.id, 'paste', 'Cedar poster (mock)', 'poster text', 'stored');
  const matB = db.createMaterial(hub.id, profile.id, 'paste', 'Cedar notice (mock)', 'notice text', 'stored');

  db.insertFacts(
    hub.id,
    matA.id,
    [
      makeFact({
        id: 'fact-db-civvies-a',
        hub_id: hub.id,
        material_id: matA.id,
        title: 'Civvies Day',
        date: '2026-11-27',
        source_document: 'Cedar poster (mock)',
        source_text: 'Civvies Day poster quote.',
        group_label: 'Poster',
      }),
    ],
    false
  );
  db.insertFacts(
    hub.id,
    matB.id,
    [
      makeFact({
        id: 'fact-db-civvies-b',
        hub_id: hub.id,
        material_id: matB.id,
        title: 'Civvies Day November 27',
        date: '2026-11-27',
        source_document: 'Cedar notice (mock)',
        source_text: 'Civvies Day notice quote.',
        group_label: 'Looking Ahead',
      }),
    ],
    false
  );
  let rows = db.listFacts(hub.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Civvies Day November 27');
  assert.ok(rows[0].source_text.includes('poster quote'));
  assert.ok(rows[0].source_text.includes('notice quote'));

  // A genuinely different event on the same date is stored side by side.
  db.insertFacts(
    hub.id,
    matB.id,
    [
      makeFact({
        id: 'fact-db-concert',
        hub_id: hub.id,
        material_id: matB.id,
        title: 'Winter Concert',
        date: '2026-11-27',
        source_text: 'Winter Concert quote.',
        group_label: 'Looking Ahead',
      }),
    ],
    false
  );
  rows = db.listFacts(hub.id);
  assert.equal(rows.length, 2);
});
