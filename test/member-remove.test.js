// Brief 055: a hub's founder or admin removes a member family.
// DELETE /api/hubs/:hubId/members/:memberKey (session auth only). The key
// is an opaque per-hub handle from the admin roster, never a profile id.
// Membership + that family's placements in this hub go; the profile, its
// children, its other hubs, and the materials it added here all stay.
// All fixtures are fictional; the store is seeded in-process first (no API
// promotes a non-founder admin), then a server child serves the same file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39900 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

function client(sessionId) {
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ Cookie: 'parentloop_session=' + sessionId }, (options && options.headers) || {});
    const res = await fetch(`${BASE}${urlPath}`, opts);
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  }
  return {
    get: (p) => req(p),
    del: (p) => req(p, { method: 'DELETE' }),
  };
}

test('founder/admin removes a member family from a hub', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-memremove-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();

  const mk = (name) => db.createProfile({ parent_name: name, children: [{ name: name + ' Kid' }] });
  const founder = mk('Founder Fern');
  const admin = mk('Admin Ash');
  const member = mk('Member Mo');
  const target = mk('Sam Testa');
  const other = mk('Other Ola');
  const hub = db.createHub(founder.id, 'Cedar Valley Elementary — Cedar Valley', 'school', {
    school_name: 'Cedar Valley Elementary', city: 'Cedar Valley', province: 'Ontario', country: 'Canada',
  });
  const otherHub = db.createHub(other.id, 'Birch Ridge Public — Birch Ridge', 'school', {
    school_name: 'Birch Ridge Public', city: 'Birch Ridge', province: 'Ontario', country: 'Canada',
  });
  db.addMember(hub.id, admin.id, 'admin', 'invite');
  db.addMember(hub.id, member.id, 'member', 'invite');
  db.addMember(hub.id, target.id, 'member', 'invite');
  db.addMember(otherHub.id, target.id, 'member', 'invite');
  const targetKid = db.getChildren(target.id)[0];
  db.setPlacements(hub.id, target.id, [{ child_id: targetKid.id, grade: '3', class: '3B' }]);
  db.setPlacements(otherHub.id, target.id, [{ child_id: targetKid.id, grade: '4', class: '' }]);
  const targetMaterial = db.createMaterial(hub.id, target.id, 'paste', 'Bake sale note (mock)', 'Bake sale Friday.', 'stored');

  const demoHub = db.getDemoHub();
  const demoFounderId = db.listHubMembers(demoHub.id)._profileIds[0];
  const session = (profileId) => {
    const s = db.createSession();
    db.setSessionProfile(s.id, profileId);
    return client(s.id);
  };
  const asFounder = session(founder.id);
  const asAdmin = session(admin.id);
  const asMember = session(member.id);
  const asDemoFounder = session(demoFounderId);
  const keyOf = (profileId) => db.hubMemberKey(hub.id, profileId);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath, SCHOOL_AGENT_API_KEY: 'test-key', SCHOOL_AGENT_API_URL: 'http://127.0.0.1:9/chat' },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await asFounder.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  await t.test('admin roster carries opaque keys; a plain member sees the roster as before', async () => {
    const asF = await asFounder.get(`/api/hubs/${hub.id}`);
    assert.equal(asF.res.status, 200);
    const byName = Object.fromEntries(asF.data.members.map((m) => [m.parent_name, m]));
    assert.equal(byName['Sam Testa'].can_remove, true);
    assert.equal(byName['Sam Testa'].member_key, keyOf(target.id));
    assert.equal(byName['Founder Fern'].can_remove, false, 'founder is never removable');
    assert.ok(!byName['Founder Fern'].member_key);
    assert.ok(!asF.text.includes(target.id) && !asF.text.includes(member.id), 'no profile id leaves the server');
    const asM = await asMember.get(`/api/hubs/${hub.id}`);
    assert.ok(asM.data.members.every((m) => !('member_key' in m) && !('can_remove' in m)), 'plain members get no remove data');
  });

  await t.test('plain member gets 403', async () => {
    const r = await asMember.del(`/api/hubs/${hub.id}/members/${keyOf(target.id)}`);
    assert.equal(r.res.status, 403);
  });

  await t.test('self-removal and founder-removal are refused', async () => {
    const self = await asAdmin.del(`/api/hubs/${hub.id}/members/${keyOf(admin.id)}`);
    assert.equal(self.res.status, 400);
    const fnd = await asAdmin.del(`/api/hubs/${hub.id}/members/${keyOf(founder.id)}`);
    assert.equal(fnd.res.status, 403);
  });

  await t.test('non-member target: plain not-found, no detail', async () => {
    const r = await asFounder.del(`/api/hubs/${hub.id}/members/${keyOf(other.id)}`);
    assert.equal(r.res.status, 404);
    assert.equal(r.data.error, 'That family is not in this hub.');
    const junk = await asFounder.del(`/api/hubs/${hub.id}/members/not-a-real-key`);
    assert.equal(junk.res.status, 404);
    assert.equal(junk.data.error, r.data.error, 'same message whatever the key');
  });

  await t.test('demo hub roster is protected', async () => {
    const r = await asDemoFounder.del(`/api/hubs/${demoHub.id}/members/${db.hubMemberKey(demoHub.id, member.id)}`);
    assert.equal(r.res.status, 403);
    const roster = await asDemoFounder.get(`/api/hubs/${demoHub.id}`);
    assert.ok(roster.data.members.every((m) => !m.member_key), 'no remove action offered on the demo hub');
  });

  await t.test('founder removes a member: membership and placements go, the rest stays', async () => {
    const before = await asFounder.get(`/api/hubs/${hub.id}`);
    const r = await asFounder.del(`/api/hubs/${hub.id}/members/${keyOf(target.id)}`);
    assert.equal(r.res.status, 200, r.text);
    assert.equal(r.data.member_count, before.data.member_count - 1);
    const after = await asFounder.get(`/api/hubs/${hub.id}`);
    assert.equal(after.data.member_count, before.data.member_count - 1, 'family count drops');
    assert.ok(!after.data.members.some((m) => m.parent_name === 'Sam Testa'), 'gone from the roster');
    assert.ok(after.data.materials.some((m) => m.id === targetMaterial.id), 'their material stays in the hub');
    // A fresh read of the server's file: the server is the only writer.
    const SQL = await require('sql.js')();
    const fileDb = new SQL.Database(fs.readFileSync(dbPath));
    const count = (sql, args) => fileDb.exec(sql, args)[0].values[0][0];
    assert.equal(count('SELECT COUNT(*) FROM hub_members WHERE hub_id = ? AND profile_id = ?', [hub.id, target.id]), 0);
    assert.equal(count('SELECT COUNT(*) FROM placements WHERE hub_id = ? AND child_id = ?', [hub.id, targetKid.id]), 0, 'placements in this hub gone');
    assert.equal(count('SELECT COUNT(*) FROM placements WHERE hub_id = ? AND child_id = ?', [otherHub.id, targetKid.id]), 1, 'other hub placement stays');
    assert.equal(count('SELECT COUNT(*) FROM hub_members WHERE hub_id = ? AND profile_id = ?', [otherHub.id, target.id]), 1, 'other hub membership stays');
    assert.equal(count('SELECT COUNT(*) FROM profiles WHERE id = ?', [target.id]), 1, 'profile stays');
    assert.equal(count('SELECT COUNT(*) FROM children WHERE profile_id = ?', [target.id]), 1, 'children stay');
    assert.equal(count('SELECT uploaded_by FROM materials WHERE id = ?', [targetMaterial.id]) === target.id, true, 'material still attributed');
    fileDb.close();
  });

  await t.test('a non-founder admin can remove a member', async () => {
    const r = await asAdmin.del(`/api/hubs/${hub.id}/members/${keyOf(member.id)}`);
    assert.equal(r.res.status, 200, r.text);
    const after = await asAdmin.get(`/api/hubs/${hub.id}`);
    assert.ok(!after.data.members.some((m) => m.parent_name === 'Member Mo'));
  });

  await t.test('page wires the Remove control with a confirm step', () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(page.includes('data-remove-member='), 'Remove control on removable rows');
    assert.ok(page.includes("'<p class=\"hint\">Remove ' + esc(name) + ' from this hub?</p>'"), 'confirm names the family');
    assert.ok(page.includes("'/members/'") && page.includes("{ method: 'DELETE' }"), 'confirm calls the member DELETE');
    assert.ok(page.includes('members.filter(function (m) { return m.can_remove && m.member_key; })'),
      'only rows with a key get a Remove control (brief 058: under Manage this hub)');
  });
});
