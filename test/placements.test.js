const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Part A: in-process db — names-only profiles, placement filtering, legacy migration.
test('placements: names-only profile, per-hub filtering, legacy migration', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-place-db-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  const db = require('../db');
  await db.initDb();
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function scopedFact(id, title, scope, scopeValue) {
    return {
      id, type: 'announcement', title, detail: title, date: '', time: '',
      applies_to: scopeValue || 'all students', action_required: false, action: '',
      link: '', source_document: 'test', source_text: 'quote ' + id,
      published_at: '', extracted_at: '', confidence: 1, supersedes: '',
      scope, scope_value: scopeValue, group_label: 'T', group_summary: '',
    };
  }

  await t.test('family profile is parent name + children names only', async () => {
    const profile = db.createProfile({
      parent_name: 'Multi Mom',
      children: [{ name: 'Ann' }, { name: 'Beth' }],
    });
    assert.equal(profile.parent.name, 'Multi Mom');
    assert.deepEqual(profile.children.map((c) => c.name), ['Ann', 'Beth']);
    for (const c of profile.children) {
      assert.deepEqual(Object.keys(c).sort(), ['id', 'name']);
    }
    assert.deepEqual(Object.keys(profile.child), ['name']);
    assert.equal(profile.school, '');
  });

  await t.test('two children in different grades see different grade-scoped facts', async () => {
    const profile = db.createProfile({
      parent_name: 'Filter Fam',
      children: [{ name: 'Ann' }, { name: 'Beth' }],
    });
    const hub = db.createHub(profile.id, 'Filter School — Filtertown', 'school', {
      school_name: 'Filter School', city: 'Filtertown', province: 'Ontario', country: 'Canada',
    });
    const mat = db.createMaterial(hub.id, profile.id, 'paste', 'notice', 'text', 'stored');
    db.insertFacts(hub.id, mat.id, [
      scopedFact('pf-s', 'School assembly', 'school', ''),
      scopedFact('pf-g2', 'Grade 2 trip', 'grade', 'Grade 2'),
      scopedFact('pf-g5', 'Grade 5 trip', 'grade', 'Grade 5'),
      scopedFact('pf-g9', 'Grade 9 trip', 'grade', 'Grade 9'),
      scopedFact('pf-c', 'Class 2B list', 'class', '2B'),
    ], false);

    const kids = db.getChildren(profile.id);
    const ann = kids.find((k) => k.name === 'Ann');
    const beth = kids.find((k) => k.name === 'Beth');
    db.setPlacements(hub.id, profile.id, [
      { child_id: ann.id, grade: 'Grade 2', class: '' },
      { child_id: beth.id, grade: 'Grade 5', class: '5C' },
    ]);
    let titles = db.listFacts(hub.id, profile.id).map((f) => f.id).sort();
    assert.deepEqual(titles, ['pf-g2', 'pf-g5', 'pf-s']);

    // Beth's placement removed: her grade's facts disappear, Ann's stay.
    db.setPlacements(hub.id, profile.id, [{ child_id: ann.id, grade: 'Grade 2', class: '' }]);
    titles = db.listFacts(hub.id, profile.id).map((f) => f.id).sort();
    assert.deepEqual(titles, ['pf-g2', 'pf-s']);
  });

  await t.test('legacy grade/class migrates into placements on first hub touch', async () => {
    const profile = db.createProfile({ parent_name: 'Legacy Lou', children: [{ name: 'Lou Jr' }] });
    const kid = db.getChildren(profile.id)[0];
    // Simulate a pre-redesign row that still carries grade/class.
    db.__testSetChildLegacy(kid.id, 'Grade 3', '3B');
    const hub = db.createHub(profile.id, 'Legacy School — Legacytown', 'school', {
      school_name: 'Legacy School', city: 'Legacytown', province: 'Ontario', country: 'Canada',
    });
    const mat = db.createMaterial(hub.id, profile.id, 'paste', 'notice', 'text', 'stored');
    db.insertFacts(hub.id, mat.id, [
      scopedFact('lg-s', 'School assembly', 'school', ''),
      scopedFact('lg-g3', 'Grade 3 trip', 'grade', 'Grade 3'),
      scopedFact('lg-g4', 'Grade 4 trip', 'grade', 'Grade 4'),
      scopedFact('lg-c', 'Class 3B list', 'class', '3B'),
    ], false);
    db.ensurePlacements(hub.id, profile.id);
    const rows = db.listPlacements(hub.id, profile.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grade, 'Grade 3');
    assert.equal(rows[0].class, '3B');
    const titles = db.listFacts(hub.id, profile.id).map((f) => f.id).sort();
    assert.deepEqual(titles, ['lg-c', 'lg-g3', 'lg-s']);
  });

  await t.test('grade spellings canonicalize to the closed vocabulary', async () => {
    assert.deepEqual(db.GRADE_OPTIONS, ['Kindergarten'].concat(
      Array.from({ length: 12 }, (_, i) => 'Grade ' + (i + 1))
    ));
    for (const [raw, want] of [
      ['Gr 3', 'Grade 3'],
      ['grade three', 'Grade 3'],
      ['3', 'Grade 3'],
      ['Grade Three', 'Grade 3'],
      ['Grade 03', 'Grade 3'],
      ['  grade 3  ', 'Grade 3'],
      ['Kinder', 'Kindergarten'],
      ['Kindergarten', 'Kindergarten'],
      ['', ''],
    ]) {
      assert.equal(db.canonicalGrade(raw), want, JSON.stringify(raw));
    }
  });

  await t.test('legacy-spelled placements still match grade-scoped facts on read', async () => {
    // A placement row stored before the dropdown (free text) keeps working
    // even before it is re-saved: matching canonicalizes both sides.
    assert.equal(db.gradeMatchesScope('Grade 3', 'Gr 3'), true);
    assert.equal(db.gradeMatchesScope('Grade 3', 'grade three'), true);
    assert.equal(db.gradeMatchesScope('Grade 3', '3'), true);
    assert.equal(db.gradeMatchesScope('Grades 3-5', 'grade three'), true);
    assert.equal(db.gradeMatchesScope('Grade 4', 'Gr 3'), false);
    assert.equal(db.gradeMatchesScope('Grade 3', 'Gr 4'), false);
    assert.equal(db.gradeMatchesScope('Grade 3', 'Kindergarten'), false);
    assert.equal(db.gradeMatchesScope('Kindergarten', 'kinder'), true);
  });

  await t.test('legacy spelling "Gr 3" saves canonical and sees Grade 3 facts only', async () => {
    const profile = db.createProfile({
      parent_name: 'Spelling Sam',
      children: [{ name: 'Sam Jr' }],
    });
    const hub = db.createHub(profile.id, 'Spelling School — Spellingtown', 'school', {
      school_name: 'Spelling School', city: 'Spellingtown', province: 'Ontario', country: 'Canada',
    });
    const mat = db.createMaterial(hub.id, profile.id, 'paste', 'notice', 'text', 'stored');
    db.insertFacts(hub.id, mat.id, [
      scopedFact('sp-s', 'School assembly', 'school', ''),
      scopedFact('sp-g3', 'Grade 3 trip', 'grade', 'Grade 3'),
      scopedFact('sp-g4', 'Grade 4 trip', 'grade', 'Grade 4'),
    ], false);
    const kid = db.getChildren(profile.id)[0];
    db.setPlacements(hub.id, profile.id, [{ child_id: kid.id, grade: 'Gr 3', class: '' }]);
    const rows = db.listPlacements(hub.id, profile.id);
    assert.equal(rows[0].grade, 'Grade 3', 'saved spelling is canonical');
    const titles = db.listFacts(hub.id, profile.id).map((f) => f.id).sort();
    assert.deepEqual(titles, ['sp-g3', 'sp-s']);
  });

  await t.test('team hubs take no placements', async () => {
    const profile = db.createProfile({ parent_name: 'Team Tam', children: [{ name: 'Tam Jr' }] });
    const hub = db.createHub(profile.id, 'U9 Team', 'team', { sport: 'Hockey', level: 'House League' });
    const kid = db.getChildren(profile.id)[0];
    assert.throws(() => db.setPlacements(hub.id, profile.id, [{ child_id: kid.id, grade: 'Grade 3', class: '' }]));
  });
});

// Part B: API — multi-child onboarding, placement endpoints, join flow, rename.
const PORT = 36300 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
let tmpDir2 = null;

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
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { res, data, text };
  }
  return {
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    get: (p) => req(p),
  };
}

async function waitForServer(client) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const probed = await client.get('/api/onboarding/status');
      if (probed.res.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

test('onboarding and placements API', async (t) => {
  tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-place-api-'));
  const dbPath = path.join(tmpDir2, 'app.db');
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (tmpDir2) fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
  const me = makeClient();
  await waitForServer(me);

  let annId = '';
  let bethId = '';
  let schoolHubId = '';

  await t.test('multi-child onboarding: names only, no grade/class/school', async () => {
    const created = await me.post('/api/profile', {
      parent_name: 'Multi Mom',
      children: [{ name: 'Ann' }, { name: 'Beth' }],
    });
    assert.equal(created.res.status, 200);
    assert.equal(created.data.profile.parent.name, 'Multi Mom');
    assert.deepEqual(created.data.profile.children.map((c) => c.name), ['Ann', 'Beth']);
    for (const c of created.data.profile.children) {
      assert.deepEqual(Object.keys(c).sort(), ['id', 'name']);
    }
    assert.equal(created.data.profile.school, '');
    annId = created.data.profile.children[0].id;
    bethId = created.data.profile.children[1].id;

    const bad = await me.post('/api/profile', { parent_name: 'No Kid', children: [{ name: '' }] });
    assert.equal(bad.res.status, 400);
    const bad2 = await me.post('/api/profile', { parent_name: '', children: [{ name: 'Kid' }] });
    assert.equal(bad2.res.status, 400);

    // Legacy single-child payloads keep working.
    const other = makeClient();
    const legacy = await other.post('/api/profile', { parent_name: 'Solo Sam', child_name: 'Sam Jr' });
    assert.equal(legacy.res.status, 200);
    assert.equal(legacy.data.profile.children[0].name, 'Sam Jr');
  });

  await t.test('new school hub needs placement; saving clears it; team rejects', async () => {
    const made = await me.post('/api/hubs', {
      school_name: 'Filter School', city: 'Filtertown', province: 'Ontario', country: 'Canada', kind: 'school',
    });
    assert.equal(made.res.status, 200);
    schoolHubId = made.data.hub.id;
    let detail = await me.get(`/api/hubs/${schoolHubId}`);
    assert.equal(detail.data.needs_placement, true);

    const saved = await me.post(`/api/hubs/${schoolHubId}/placements`, {
      placements: [
        { child_id: annId, grade: 'Grade 2', class: '' },
        { child_id: bethId, grade: 'Grade 5', class: '5C' },
      ],
    });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.data.needs_placement, false);
    detail = await me.get(`/api/hubs/${schoolHubId}`);
    assert.equal(detail.data.needs_placement, false);
    assert.equal(detail.data.placements.length, 2);

    const team = await me.post('/api/hubs', { name: 'U9 Filtertown', kind: 'team', sport: 'Hockey', level: 'Rep' });
    assert.equal(team.res.status, 200);
    const rejected = await me.post(`/api/hubs/${team.data.hub.id}/placements`, {
      placements: [{ child_id: annId, grade: 'Grade 2', class: '' }],
    });
    assert.equal(rejected.res.status, 400);
  });

  await t.test('joiner is asked for placement on first entry; prompt data present', async () => {
    const joiner = makeClient();
    await joiner.post('/api/profile', { parent_name: 'Joiner Jo', children: [{ name: 'Jo Kid' }] });
    const invite = await me.post(`/api/hubs/${schoolHubId}/invites`, {});
    assert.equal(invite.res.status, 200);
    const accepted = await joiner.post(`/api/join/${invite.data.token}/accept`, {});
    assert.equal(accepted.res.status, 200);
    const detail = await joiner.get(`/api/hubs/${schoolHubId}`);
    assert.equal(detail.data.needs_placement, true);
    const joKid = (await joiner.get('/api/family-profile')).data.profile.children[0].id;
    const saved = await joiner.post(`/api/hubs/${schoolHubId}/placements`, {
      placements: [{ child_id: joKid, grade: 'Grade 4', class: '' }],
    });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.data.needs_placement, false);
  });

  await t.test('family names are editable; removing a child drops its placements', async () => {
    const updated = await me.post('/api/profile/update', {
      parent_name: 'Multi Mom Renamed',
      children: [{ id: annId, name: 'Ann' }, { name: 'Cal' }],
    });
    assert.equal(updated.res.status, 200);
    assert.equal(updated.data.profile.parent.name, 'Multi Mom Renamed');
    assert.deepEqual(updated.data.profile.children.map((c) => c.name), ['Ann', 'Cal']);
    const detail = await me.get(`/api/hubs/${schoolHubId}`);
    assert.equal(detail.data.needs_placement, true, 'new child Cal has no grade yet');
    assert.ok(detail.data.placements.every((p) => p.child_name !== 'Beth'));

    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    const denied = await demo.post('/api/profile/update', { parent_name: 'X', children: [{ name: 'Y' }] });
    assert.equal(denied.res.status, 400);
  });
});
