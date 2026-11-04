const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 36000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;

const storeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-join-store-'));
process.env.APP_DB_PATH = path.join(storeTmpDir, 'app.db');
const db = require('../db');

let child = null;
let tmpDir = null;

async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
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

const DEMO_HUB_NAMES = ['Grade 3 — Maple Grove Elementary', 'U9 Hockey — Maple Grove'];

test('invite joins never capture the demo family', async (t) => {
  await db.initDb();

  await t.test('store refuses demo membership in a non-demo hub', () => {
    const demo = db.getDemoProfile();
    assert.ok(demo && demo.is_demo);
    const founder = db.createProfile({ parent_name: 'Guard Founder', child_name: 'Guard Kid' });
    assert.ok(!founder.is_demo);
    const realHub = db.createHub(founder.id, 'Guard School — Guardville', 'school', {
      school_name: 'Guard School',
      city: 'Guardville',
      province: 'Ontario',
      country: 'Canada',
    });
    assert.equal(realHub.is_demo, false);
    assert.throws(
      () => db.addMember(realHub.id, demo.id, 'member', 'invite'),
      /Demo families cannot join this hub/
    );
    assert.equal(db.isMember(realHub.id, demo.id), false);
    // The demo hub and real families are unaffected.
    const demoHub = db.getDemoHub();
    db.addMember(demoHub.id, demo.id, 'member', 'invite');
    assert.equal(db.isMember(demoHub.id, demo.id), true);
    db.addMember(realHub.id, founder.id, 'member', 'invite');
    assert.equal(db.isMember(realHub.id, founder.id), true);
    // Removal semantics: true when a row goes away, false otherwise.
    assert.equal(db.removeMember(realHub.id, demo.id), false);
    assert.equal(db.removeMember(realHub.id, null), false);
    assert.equal(db.removeMember(realHub.id, founder.id), true);
    assert.equal(db.isMember(realHub.id, founder.id), false);
    // The session's own profile never falls back to demo.
    assert.equal(db.getSessionOwnProfile(null), null);
    assert.equal(db.getSessionOwnProfile({}), null);
    assert.equal(db.getSessionOwnProfile({ active_profile_id: 'missing' }), null);
  });

  await t.test('boot sweep removes demo memberships from non-demo hubs', () => {
    const demo = db.getDemoProfile();
    const founded = db.createHub(demo.id, 'Sweep School — Sweepville', 'school', {
      school_name: 'Sweep School',
      city: 'Sweepville',
      province: 'Ontario',
      country: 'Canada',
    });
    assert.equal(db.isMember(founded.id, demo.id), true);
    const removed = db.purgeDemoMemberships();
    assert.ok(removed.some((r) => r.hub_id === founded.id));
    assert.equal(db.isMember(founded.id, demo.id), false);
    assert.deepEqual(db.purgeDemoMemberships(), []);
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-join-http-'));
  const dbPath = path.join(tmpDir, 'app.db');
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath, PARENTLOOP_TEST_AUTH: '1' },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(storeTmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  let hubId = null;
  let token = null;

  await t.test('a real family founds a hub and mints an invite', async () => {
    const founder = await post('/api/profile', {
      parent_name: 'Invite Irene',
      parent_email: 'invite.irene@example.com',
      child_name: 'Irene Kid',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    assert.equal(founder.res.status, 200);
    // Attach a Google identity so the test sign-in can return to Irene.
    const linked = await post('/api/auth/test-complete', { sub: 'irene-sub-1', email: 'irene@example.com' });
    assert.equal(linked.res.status, 200);
    const created = await post('/api/hubs', {
      school_name: 'Joinville Public School',
      city: 'Joinville',
      province: 'Ontario',
      country: 'Canada',
      kind: 'school',
    });
    assert.equal(created.res.status, 200);
    hubId = created.data.hub.id;
    const invite = await post(`/api/hubs/${hubId}/invites`, {});
    // Brief 067: this hub lets anyone with a link join (the default asks the admin).
    assert.equal((await post(`/api/hubs/${hubId}/join-settings`, { open: true })).res.status, 200);
    assert.equal(invite.res.status, 200);
    token = invite.data.token;
    const info = await jf(`/api/join/${token}`);
    assert.equal(info.res.status, 200);
    assert.equal(info.data.member_count, 1);
  });

  await t.test('demo hitting Join gets the account question and no membership', async () => {
    await post('/api/profile/demo', {});
    const attempt = await post(`/api/join/${token}/accept`, {});
    assert.equal(attempt.res.status, 409);
    assert.equal(attempt.data.needsAccountChoice, true);
    assert.ok(attempt.data.hub_name);
    const hubs = await jf('/api/hubs');
    assert.deepEqual(
      hubs.data.hubs.map((h) => h.name).sort(),
      DEMO_HUB_NAMES.slice().sort(),
      'demo viewer still sees exactly the seeded demo hubs'
    );
    const detail = await jf(`/api/hubs/${hubId}`);
    assert.equal(detail.res.status, 403, 'demo is not a member of the real hub');
    const info = await jf(`/api/join/${token}`);
    assert.equal(info.data.member_count, 1, 'refused join adds nobody');
  });

  await t.test('a family created after landing joins the hub', async () => {
    // Sign out first so the new family does not inherit Irene's link
    // (creating a family while signed in moves the account link to it).
    await post('/api/auth/logout', {});
    const created = await post('/api/profile', {
      parent_name: 'Joiner Jo',
      parent_email: 'joiner.jo@example.com',
      child_name: 'Jo Kid',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    assert.equal(created.res.status, 200);
    const accepted = await post(`/api/join/${token}/accept`, {});
    assert.equal(accepted.res.status, 200);
    const hubs = await jf('/api/hubs');
    assert.ok(hubs.data.hubs.some((h) => h.id === hubId), 'new family lands in the hub');
    const detail = await jf(`/api/hubs/${hubId}`);
    assert.equal(detail.res.status, 200);
    assert.equal(detail.data.member_count, 2);
  });

  await t.test('sign-in resolves the real family and joins without a second tap', async () => {
    await post('/api/profile/demo', {});
    const signed = await post('/api/auth/test-complete', { sub: 'irene-sub-1', email: 'irene@example.com' });
    assert.equal(signed.res.status, 200);
    assert.equal(signed.data.profile.parent.name, 'Invite Irene', 'account family wins over demo');
    const accepted = await post(`/api/join/${token}/accept`, {});
    assert.equal(accepted.res.status, 200, 'signed-in real family joins immediately');
  });

  await t.test('approving a demo join request is refused and stays pending', async () => {
    await post('/api/profile/demo', {});
    const requested = await post(`/api/hubs/${hubId}/join-requests`, {});
    assert.equal(requested.res.status, 200);
    // Back to Irene via her linked Google identity.
    const signed = await post('/api/auth/test-complete', { sub: 'irene-sub-1', email: 'irene@example.com' });
    assert.equal(signed.data.profile.parent.name, 'Invite Irene');
    const pending = await jf(`/api/hubs/${hubId}/join-requests`);
    const demoReq = pending.data.requests.find((r) => r.status === 'pending');
    assert.ok(demoReq, 'demo request is pending');
    const approved = await post(`/api/hubs/${hubId}/join-requests/${demoReq.id}/approve`, {});
    assert.equal(approved.res.status, 403);
    assert.match(approved.data.error, /Demo/);
    const again = await jf(`/api/hubs/${hubId}/join-requests`);
    assert.equal(
      again.data.requests.find((r) => r.id === demoReq.id).status,
      'pending',
      'refused approval leaves the request pending'
    );
    const declined = await post(`/api/hubs/${hubId}/join-requests/${demoReq.id}/decline`, {});
    assert.equal(declined.res.status, 200);
  });
});
