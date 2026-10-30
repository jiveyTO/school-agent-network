const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = 35000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET_MARKER = 'HUB_TEST_SECRET_456';

let child = null;
let tmpDir = null;
let hubA = null;
let createdHub = null;

async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      // Probe through the jarred client: a bare probe would mint its own
      // session and burn the one-time legacy adoption before tests run.
      const probed = await jf('/api/onboarding/status');
      if (probed.res.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

let jarCookie = '';
async function jf(urlPath, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, (options && options.headers) || {});
  if (jarCookie) opts.headers.Cookie = jarCookie;
  const res = await fetch(`${BASE}${urlPath}`, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/parentloop_session=([^;]+)/);
    if (m) jarCookie = 'parentloop_session=' + m[1];
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

function post(urlPath, body) {
  return jf(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

test('ParentLoop hubs, migration, joining, and Parent Agent v2', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-test-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;

  // A profile that exists before the server boots must survive migration.
  // The legacy pointer recreates the pre-sessions database shape, where the
  // seeded profile was the global active one.
  const db = require('../db');
  await db.initDb();
  const preExisting = db.createProfile({
    parent_name: 'Pre Existing',
    child_name: 'Kid Existing',
    grade: 'Grade 3',
    class_name: '3A',
    school_name: 'Maple Grove Elementary',
    priorities: ['never miss a food-order deadline'],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  db.setLegacyActiveProfile(preExisting.id);

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await t.test('migration imports all facts.json facts into Hub A and preserves the profile', async () => {
    const factsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'facts.json'), 'utf8'));
    const profile = await jf('/api/family-profile');
    assert.equal(profile.data.profile.parent.name, 'Pre Existing');
    assert.equal(profile.data.profile.children[0].name, 'Kid Existing');
    const hubs = await jf('/api/hubs');
    hubA = hubs.data.hubs.find((h) => h.name === 'Grade 3 — Maple Grove Elementary');
    assert.ok(!hubA, 'Pre Existing is not auto-enrolled; demo hub is reached via the demo profile');
    const hiddenFeed = await jf('/api/facts');
    assert.deepEqual(hiddenFeed.data.facts, []);
    const demo = await post('/api/profile/demo', {});
    assert.equal(demo.data.profile.parent.name, 'Alex Rivera');
    const facts = await jf('/api/facts');
    assert.equal(facts.data.facts.length, factsJson.length);
    const demoHubs = await jf('/api/hubs');
    hubA = demoHubs.data.hubs.find((h) => h.name === 'Grade 3 — Maple Grove Elementary');
    assert.ok(hubA);
    const detail = await jf(`/api/hubs/${hubA.id}`);
    assert.equal(detail.data.facts.length, factsJson.length);
    assert.ok(detail.data.facts.every((f) => f.hub_id === hubA.id && f.source_text));
  });

  await t.test('extraction treats rules and dress codes as informational, not actions', async () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes('Rules, dress codes, and conduct guidelines are informational facts, not actions'));
  });

  await t.test('seed facts carry newsletter section labels', async () => {
    const seedFacts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'facts.json'), 'utf8'));
    assert.ok(seedFacts.length > 0);
    assert.ok(seedFacts.every((f) => typeof f.group_label === 'string' && f.group_label.length > 0), 'every seed fact has a group_label');
    await post('/api/profile/demo', {});
    const hubs = await jf('/api/hubs');
    const hockey = hubs.data.hubs.find((h) => h.name === 'U9 Hockey — Maple Grove');
    assert.ok(hockey, 'demo hockey hub exists');
    const detail = await jf(`/api/hubs/${hockey.id}`);
    assert.ok(detail.data.facts.length > 0);
    assert.ok(detail.data.facts.every((f) => typeof f.group_label === 'string' && f.group_label.length > 0), 'seeded hockey facts carry group labels');
    const fundraiser = seedFacts.find((f) => f.id === 'mg-08');
    assert.ok(fundraiser && fundraiser.group_summary.length > 0, 'informational seed groups carry one-line summaries');
    const snack = detail.data.facts.find((f) => f.title === 'Team snack schedule posted');
    assert.ok(snack && snack.group_summary.length > 0, 'seeded snack fact carries its summary');
  });

  await t.test('sources no longer store credentials', async () => {
    const saved = await post('/api/sources', {
      type: 'schoolmessenger',
      label: 'SchoolMessenger',
      url: 'https://example.test',
      username: 'someone',
      password: SECRET_MARKER,
    });
    assert.equal(saved.res.status, 200);
    assert.ok(!saved.text.includes(SECRET_MARKER));
    assert.ok(!('username' in saved.data.source));
    assert.ok(!('password' in saved.data.source));
    const list = await jf('/api/sources');
    assert.ok(!list.text.includes(SECRET_MARKER));
  });

  await t.test('create hub → founder is admin; invite accept adds a member; join info leaks nothing', async () => {
    await post('/api/profile', {
      parent_name: 'Founder Pat',
      child_name: 'Pat Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const created = await post('/api/hubs', { school_name: 'Test Hub Alpha', city: 'Maple Grove', province: 'Ontario', country: 'Canada', kind: 'school' });
    assert.equal(created.res.status, 200);
    createdHub = created.data.hub;
    assert.equal(createdHub.name, 'Test Hub Alpha — Maple Grove');
    const detail = await jf(`/api/hubs/${createdHub.id}`);
    assert.equal(detail.data.hub.role, 'admin');
    assert.equal(detail.data.member_count, 1);

    const invite = await post(`/api/hubs/${createdHub.id}/invites`, {});
    assert.match(invite.data.path, /^\/join\/.+/);
    const token = invite.data.token;
    const info = await jf(`/api/join/${token}`);
    assert.deepEqual(Object.keys(info.data).sort(), [
      'hub_name',
      'inviter_first_name',
      'kind',
      'member_count',
    ]);
    assert.equal(info.data.hub_name, 'Test Hub Alpha — Maple Grove');
    assert.equal(info.data.inviter_first_name, 'Founder');
    assert.ok(!info.text.includes('Pat Kid'));
    assert.ok(!info.text.toLowerCase().includes('fact'));

    await post('/api/profile', {
      parent_name: 'Joiner Jo',
      child_name: 'Jo Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'tell me right away',
    });
    const accepted = await post(`/api/join/${token}/accept`, {});
    assert.equal(accepted.res.status, 200);
    const joined = await jf('/api/hubs');
    assert.ok(joined.data.hubs.some((h) => h.id === createdHub.id));
  });

  await t.test('one hub per school: nickname variant returns exact 409, request path works, team unaffected', async () => {
    await post('/api/profile/demo', {});
    const first = await post('/api/hubs', { school_name: 'St. Nicholas', city: 'Willow Creek', province: 'Ontario', country: 'Canada', kind: 'school' });
    assert.equal(first.res.status, 200);
    assert.equal(first.data.hub.name, 'St. Nicholas — Willow Creek');
    const hubsBefore = await jf('/api/hubs');
    const countBefore = hubsBefore.data.hubs.length;
    const dup = await post('/api/hubs', { school_name: "Saint Nick's", city: 'Willow Creek', province: 'Ontario', country: 'Canada', kind: 'school' });
    assert.equal(dup.res.status, 409);
    assert.equal(dup.data.match_type, 'exact');
    assert.equal(dup.data.existing_hub.id, first.data.hub.id);
    assert.equal(dup.data.existing_hub.name, 'St. Nicholas — Willow Creek');
    assert.equal(dup.data.existing_hub.province, 'Ontario');
    assert.equal(dup.data.existing_hub.country, 'Canada');
    assert.equal(dup.data.existing_hub.founder_first_name, 'Alex');
    assert.equal(dup.data.existing_hub.member_count, 1);
    const aliasDup = await post('/api/hubs', { school_name: 'St. Nicholas', city: 'Willow Creek', province: 'ON', country: 'CA', kind: 'school' });
    assert.equal(aliasDup.res.status, 409, 'province/country aliases resolve to an exact match');
    assert.equal(aliasDup.data.match_type, 'exact');
    assert.equal(aliasDup.data.existing_hub.id, first.data.hub.id);
    const quebecTwin = await post('/api/hubs', { school_name: 'St. Nicholas', city: 'Willow Creek', province: 'Quebec', country: 'Canada', kind: 'school' });
    assert.equal(quebecTwin.res.status, 200, 'same school/city in a different province is a different school');
    assert.equal(quebecTwin.data.hub.name, 'St. Nicholas — Willow Creek');
    const legacyMatch = await post('/api/hubs', { school_name: 'Grade 3', city: 'Maple Grove Elementary', province: 'Ontario', country: 'Canada', kind: 'school' });
    assert.equal(legacyMatch.res.status, 409, 'a stored row with empty province/country still exact-matches');
    assert.equal(legacyMatch.data.match_type, 'exact');
    assert.equal(legacyMatch.data.existing_hub.name, 'Grade 3 — Maple Grove Elementary');
    const forcedExact = await post('/api/hubs', { school_name: "Saint Nick's", city: 'Willow Creek', province: 'Ontario', country: 'Canada', kind: 'school', force: true });
    assert.equal(forcedExact.res.status, 409, 'force does not bypass an exact match');
    assert.equal(forcedExact.data.match_type, 'exact');
    const hubsAfter = await jf('/api/hubs');
    assert.equal(hubsAfter.data.hubs.length, countBefore + 1, 'only the Quebec twin was created');
    const teamTwin = await post('/api/hubs', { name: 'St. Nicholas — Willow Creek', kind: 'team' });
    assert.equal(teamTwin.res.status, 200, 'team hubs are unaffected by school uniqueness');

    await post('/api/profile', {
      parent_name: 'Requester Ron',
      child_name: 'Ron Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'St. Nicholas',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const reqMade = await post(`/api/hubs/${first.data.hub.id}/join-requests`, {});
    assert.equal(reqMade.res.status, 200);
    await post('/api/profile/demo', {});
    const pending = await jf(`/api/hubs/${first.data.hub.id}/join-requests`);
    const ron = pending.data.requests.find((r) => r.parent_name === 'Requester Ron' && r.status === 'pending');
    assert.ok(ron, 'conflict-card request lands in the admin queue');
    const approved = await post(`/api/hubs/${first.data.hub.id}/join-requests/${ron.id}/approve`, {});
    assert.equal(approved.res.status, 200);
    const detail = await jf(`/api/hubs/${first.data.hub.id}`);
    assert.equal(detail.data.member_count, 2, 'approved requester becomes a member');
  });

  await t.test('parse-link rejects bad URLs and extracts school identity from a page', { timeout: 180000 }, async () => {
    const badProtocol = await post('/api/hubs/parse-link', { url: 'ftp://example.test/school', kind: 'school' });
    assert.equal(badProtocol.res.status, 400);
    const missing = await post('/api/hubs/parse-link', { url: '', kind: 'school' });
    assert.equal(missing.res.status, 400);
    const unreachable = await post('/api/hubs/parse-link', { url: 'http://127.0.0.1:9/nope', kind: 'school' });
    assert.equal(unreachable.res.status, 500);

    const pageHtml = '<html><head><title>Foxfield Public School</title></head><body>' +
      '<h1>Foxfield Public School</h1><p>45 Willow Street, Willow Creek, Ontario, Canada.</p>' +
      '<p>Welcome to Foxfield Public School, home of the Foxes.</p></body></html>';
    const site = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(pageHtml);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    const sitePort = site.address().port;
    try {
      const hubsBefore = await jf('/api/hubs');
      const parsed = await post('/api/hubs/parse-link', { url: `http://127.0.0.1:${sitePort}/`, kind: 'school' });
      assert.equal(parsed.res.status, 200, parsed.text.slice(0, 400));
      assert.equal(parsed.data.domain, '127.0.0.1');
      for (const key of ['school_name', 'city', 'province', 'country']) {
        assert.ok(typeof parsed.data.fields[key] === 'string', `identity field present: ${key}`);
      }
      assert.match(parsed.data.fields.school_name, /Foxfield/i);
      const hubsAfter = await jf('/api/hubs');
      assert.equal(hubsAfter.data.hubs.length, hubsBefore.data.hubs.length, 'parse-link creates nothing');
    } finally {
      await new Promise((resolve) => site.close(resolve));
    }
  });

  await t.test('hub delete: admin removes hub and its data; others get 403', async () => {
    await post('/api/profile/demo', {});
    const created = await post('/api/hubs', { name: 'Doomed Test Hub', kind: 'other' });
    assert.equal(created.res.status, 200);
    const hubId = created.data.hub.id;
    const invite = await post(`/api/hubs/${hubId}/invites`, {});
    assert.equal(invite.res.status, 200);
    await post('/api/profile', {
      parent_name: 'Deleter Dan',
      child_name: 'Dan Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    await post(`/api/join/${invite.data.token}/accept`, {});
    const denied = await jf(`/api/hubs/${hubId}`, { method: 'DELETE' });
    assert.equal(denied.res.status, 403, 'members cannot delete');
    await post('/api/profile', {
      parent_name: 'Outsider Eve',
      child_name: 'Eve Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const outsider = await jf(`/api/hubs/${hubId}`, { method: 'DELETE' });
    assert.equal(outsider.res.status, 403, 'non-members cannot delete');
    await post('/api/profile/demo', {});
    const del = await jf(`/api/hubs/${hubId}`, { method: 'DELETE' });
    assert.equal(del.res.status, 200);
    const gone = await jf(`/api/hubs/${hubId}`);
    assert.equal(gone.res.status, 404);
    const hubs = await jf('/api/hubs');
    assert.ok(!hubs.data.hubs.some((h) => h.id === hubId), 'deleted hub leaves the list');
    const joinGone = await jf(`/api/join/${invite.data.token}`);
    assert.equal(joinGone.res.status, 404, 'invites die with the hub');
    const again = await jf(`/api/hubs/${hubId}`, { method: 'DELETE' });
    assert.equal(again.res.status, 404);
  });

  await t.test('material text endpoint serves members only what their scope allows', async () => {
    await post('/api/profile/demo', {});
    const made = await post(`/api/hubs/${hubA.id}/materials`, {
      kind: 'paste',
      title: 'Class 3B spelling list',
      text: 'Maple Grove Elementary notice for Class 3B: the class spelling list is posted on the classroom door.',
      audience: 'class',
    });
    assert.equal(made.res.status, 200);
    const mid = made.data.material.id;
    const demoText = await jf(`/api/hubs/${hubA.id}/materials/${mid}/text`);
    assert.equal(demoText.res.status, 200);
    assert.ok(demoText.data.text.includes('spelling list'), 'member reads the stored text');
    assert.equal(demoText.data.title, 'Class 3B spelling list');
    const samInvite = await post(`/api/hubs/${hubA.id}/invites`, {});
    assert.equal(samInvite.res.status, 200);
    await post('/api/profile', {
      parent_name: 'Text Scope Sam',
      child_name: 'Sam Kid',
      grade: 'Grade 9',
      class_name: '9C',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    await post(`/api/join/${samInvite.data.token}/accept`, {});
    const scopedOut = await jf(`/api/hubs/${hubA.id}/materials/${mid}/text`);
    assert.equal(scopedOut.res.status, 404, 'out-of-scope profiles cannot read the text');
    await post('/api/profile', {
      parent_name: 'Text Outsider Eve',
      child_name: 'Eve Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const outsider = await jf(`/api/hubs/${hubA.id}/materials/${mid}/text`);
    assert.equal(outsider.res.status, 403, 'non-members cannot read the text');
    await post('/api/profile/demo', {});
    const missing = await jf(`/api/hubs/${hubA.id}/materials/no-such-material/text`);
    assert.equal(missing.res.status, 404);
    const allHubs = await jf('/api/hubs');
    const hockeyHub = allHubs.data.hubs.find((h) => h.name === 'U9 Hockey — Maple Grove');
    assert.ok(hockeyHub);
    const wrongHub = await jf(`/api/hubs/${hockeyHub.id}/materials/${mid}/text`);
    assert.equal(wrongHub.res.status, 404, 'material text is hub-bound');
  });

  await t.test('near-match school names return similar 409; force creates, different city is unaffected', async () => {
    await post('/api/profile/demo', {});
    const east = await post('/api/hubs', { school_name: 'St. Nicholas East', city: 'Willow Creek', province: 'Ontario', country: 'Canada', kind: 'school' });
    assert.equal(east.res.status, 409, 'subset/superset of an existing Willow Creek school is a near match');
    assert.equal(east.data.match_type, 'similar');
    assert.equal(east.data.existing_hub.name, 'St. Nicholas — Willow Creek');
    assert.equal(east.data.existing_hub.founder_first_name, 'Alex');
    const forced = await post('/api/hubs', { school_name: 'St. Nicholas East', city: 'Willow Creek', province: 'Ontario', country: 'Canada', kind: 'school', force: true });
    assert.equal(forced.res.status, 200, 'force creates on a similar match');
    assert.equal(forced.data.hub.name, 'St. Nicholas East — Willow Creek');
    const far = await post('/api/hubs', { school_name: 'St. Nicholas', city: 'Cedar Falls', province: 'Ontario', country: 'Canada', kind: 'school' });
    assert.equal(far.res.status, 200, 'same school name in a different city creates cleanly');
    assert.equal(far.data.hub.name, 'St. Nicholas — Cedar Falls');
  });

  await t.test('join request → approve adds a member, decline does not', async () => {
    // Sam Chen's seeded pending request sits on Hub A; Rivera (demo) is admin.
    await post('/api/profile/demo', {});
    const before = await jf(`/api/hubs/${hubA.id}`);
    const requests = await jf(`/api/hubs/${hubA.id}/join-requests`);
    const sam = requests.data.requests.find((r) => r.parent_name === 'Sam Chen' && r.status === 'pending');
    assert.ok(sam, 'seeded Sam Chen request exists');
    const approved = await post(`/api/hubs/${hubA.id}/join-requests/${sam.id}/approve`, {});
    assert.equal(approved.res.status, 200);
    const afterApprove = await jf(`/api/hubs/${hubA.id}`);
    assert.equal(afterApprove.data.member_count, before.data.member_count + 1);

    await post('/api/profile', {
      parent_name: 'Requester Rae',
      child_name: 'Rae Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const reqMade = await post(`/api/hubs/${hubA.id}/join-requests`, {});
    assert.equal(reqMade.res.status, 200);
    await post('/api/profile/demo', {});
    const list2 = await jf(`/api/hubs/${hubA.id}/join-requests`);
    const rae = list2.data.requests.find((r) => r.parent_name === 'Requester Rae' && r.status === 'pending');
    assert.ok(rae);
    const declined = await post(`/api/hubs/${hubA.id}/join-requests/${rae.id}/decline`, {});
    assert.equal(declined.res.status, 200);
    const afterDecline = await jf(`/api/hubs/${hubA.id}`);
    assert.equal(afterDecline.data.member_count, afterApprove.data.member_count);
    const list3 = await jf(`/api/hubs/${hubA.id}/join-requests`);
    assert.equal(list3.data.requests.find((r) => r.id === rae.id).status, 'declined');
  });

  await t.test('paste material into a hub adds facts with that hub_id', { timeout: 180000 }, async () => {
    await post('/api/profile/demo', {});
    const added = await post(`/api/hubs/${hubA.id}/materials`, {
      kind: 'paste',
      title: 'Test picnic notice',
      text: 'Maple Grove Elementary notice: The school picnic is on Friday, November 20, 2026. Please bring a water bottle. Reply forms are due Wednesday, November 18, 2026.',
    });
    assert.equal(added.res.status, 200, added.text.slice(0, 400));
    assert.ok(added.data.facts_added >= 1);
    assert.ok(added.data.facts.every((f) => f.hub_id === hubA.id));
    assert.ok(added.data.facts.every((f) => f.source_text));
    assert.ok(added.data.facts.every((f) => typeof f.group_label === 'string'), 'extraction emits group_label');
    assert.ok(added.data.facts.every((f) => typeof f.group_summary === 'string'), 'extraction emits group_summary');
    const detailAfter = await jf(`/api/hubs/${hubA.id}`);
    assert.ok(detailAfter.data.facts.some((f) => typeof f.group_label === 'string' && f.group_label.length > 0), 'stored facts carry a group label');
  });

  await t.test('team hubs store sport and level, show them, and skip uniqueness checks', async () => {
    await post('/api/profile/demo', {});
    const team = await post('/api/hubs', { name: 'U11 Maple Grove Soccer', kind: 'team', sport: 'Soccer', level: 'Rep' });
    assert.equal(team.res.status, 200);
    assert.equal(team.data.hub.sport, 'Soccer');
    assert.equal(team.data.hub.level, 'Rep');
    const hubs = await jf('/api/hubs');
    const listed = hubs.data.hubs.find((h) => h.id === team.data.hub.id);
    assert.equal(listed.sport, 'Soccer');
    assert.equal(listed.level, 'Rep');
    const detail = await jf(`/api/hubs/${team.data.hub.id}`);
    assert.equal(detail.data.hub.sport, 'Soccer');
    assert.equal(detail.data.hub.level, 'Rep');
    const twin = await post('/api/hubs', { name: 'U11 Maple Grove Soccer', kind: 'team', sport: 'Soccer', level: 'Rep' });
    assert.equal(twin.res.status, 200, 'team hubs have no uniqueness checks');
    const noLevel = await post('/api/hubs', { name: 'Drop-in Basketball', kind: 'team', sport: 'Basketball', level: '' });
    assert.equal(noLevel.res.status, 200);
    assert.equal(noLevel.data.hub.sport, 'Basketball');
    assert.equal(noLevel.data.hub.level, '');
  });

  await t.test('audience scope: out-of-scope profile receives nothing via any endpoint', { timeout: 180000 }, async () => {
    await post('/api/profile/demo', {});
    const spelling = await post(`/api/hubs/${hubA.id}/materials`, {
      kind: 'paste',
      title: 'Class 3B spelling list',
      text: 'Maple Grove Elementary notice for Class 3B: the class spelling list for Friday, November 13, 2026 is posted on the classroom door. Class 3B students should practice ten words each night.',
      audience: 'class',
    });
    assert.equal(spelling.res.status, 200, spelling.text.slice(0, 400));
    assert.ok(spelling.data.facts_added >= 1);
    assert.ok(spelling.data.facts.every((f) => f.scope === 'class'), 'explicit class choice overrides extraction scope');
    const classFactIds = new Set(spelling.data.facts.map((f) => f.id));
    const invite = await post(`/api/hubs/${hubA.id}/invites`, {});
    await post('/api/profile', {
      parent_name: 'Scope Sam',
      child_name: 'Sam Kid',
      grade: 'Grade 9',
      class_name: '9C',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    await post(`/api/join/${invite.data.token}/accept`, {});
    const scopedDetail = await jf(`/api/hubs/${hubA.id}`);
    assert.ok(scopedDetail.data.facts.length > 0, 'school-wide facts stay visible');
    assert.ok(
      scopedDetail.data.facts.every((f) => f.scope === 'school'),
      'Grade 9 / class 9C sees no grade- or class-scoped facts'
    );
    assert.ok(!scopedDetail.data.facts.some((f) => classFactIds.has(f.id)));
    assert.ok(!(scopedDetail.data.materials || []).some((m) => m.title === 'Class 3B spelling list'), 'class-scoped material hidden too');
    // /api/facts is the demo-only strip: non-demo profiles get nothing at all (no leak possible).
    const scopedFeed = await jf('/api/facts');
    assert.deepEqual(scopedFeed.data.facts, []);

    // Back on the demo family (Grade 3 / 3B), the narrower items are visible again —
    // via both the hub detail and the demo /api/facts feed.
    await post('/api/profile/demo', {});
    const demoDetail = await jf(`/api/hubs/${hubA.id}`);
    assert.ok(demoDetail.data.facts.some((f) => f.scope === 'class'), 'demo sees class-scoped facts');
    assert.ok(demoDetail.data.facts.some((f) => f.scope === 'grade'), 'demo sees grade-scoped facts');
    const demoFeed = await jf('/api/facts');
    assert.ok(demoFeed.data.facts.some((f) => f.scope === 'class'), 'demo feed keeps class-scoped facts');
    assert.ok(demoFeed.data.facts.some((f) => f.scope === 'grade'), 'demo feed keeps grade-scoped facts');
  });

  await t.test('email filing requires hub_id', async () => {
    const out = await post('/api/email/use-newsletter', { messageId: 'abc' });
    assert.equal(out.res.status, 500);
    assert.match(out.data.error, /hub/i);
  });

  await t.test('parent run v2 cites only DB facts, groups by hub, flags Nov 6 conflict, ends with PRIVACY CHECK', { timeout: 180000 }, async () => {
    await post('/api/profile/demo', {});
    const hubs = await jf('/api/hubs');
    const allFacts = [];
    for (const h of hubs.data.hubs) {
      const detail = await jf(`/api/hubs/${h.id}`);
      allFacts.push(...detail.data.facts);
    }
    const dbIds = new Set(allFacts.map((f) => f.id));
    const run = await post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 500));
    assert.ok(run.data.relevant_facts.every((f) => dbIds.has(f.id)));
    const groupNames = (run.data.groups || []).map((g) => g.hub_name);
    assert.ok(groupNames.includes('Grade 3 — Maple Grove Elementary'), groupNames.join(' | '));
    assert.ok(groupNames.includes('U9 Hockey — Maple Grove'), groupNames.join(' | '));
    for (const g of run.data.groups || []) {
      assert.ok((g.facts || []).every((f) => typeof f.group_label === 'string'), 'group facts carry their section labels');
    }
    const conflictText = (run.data.conflicts || []).map((c) => c.message).join('\n');
    assert.match(conflictText, /U9 Hockey/);
    assert.match(conflictText, /Fall Festival/i);
    assert.match(conflictText, /Nov 6/);
    const lastLog = run.data.logs[run.data.logs.length - 1].message;
    assert.equal(
      lastLog,
      'PRIVACY CHECK: family profile data used only inside this Parent Agent run — nothing sent to the school or group.'
    );
  });
});
