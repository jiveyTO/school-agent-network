const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 024: a signed-in parent who starts a new family makes THAT family
// their account family. The account link (profiles.google_sub/google_email)
// moves to the newly created family; the previous family keeps its data,
// hubs, and memberships, just unlinked.
//
// Store-level cases run in-process against a temp db; the API-level case
// boots a server (PARENTLOOP_TEST_AUTH=1, never set in production) to prove
// POST /api/profile is wired to the move.
//
// Fixtures are fictional (Juniper/Cedar families). No real data.

const ROOT = path.join(__dirname, '..');
const PORT = 36900 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

function familyInput(parentName, childName) {
  return {
    parent_name: parentName,
    children: [{ name: childName }],
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  };
}

test('signed-in family creation moves the account link (store level)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-link-move-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  const db = require('../db');
  await db.initDb();
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('account linked to A; signed-in session creates B: link moves, A intact', async () => {
    const SUB = 'test-sub-link-move-a';
    const EMAIL = 'link.move.a@example.com';
    const session = db.createSession();
    const familyA = db.createProfile(familyInput('Juniper Parent', 'Juniper Child'));
    db.setSessionProfile(session.id, familyA.id);
    const hub = db.createHub(familyA.id, 'Juniper School', 'school', {
      school_name: 'Juniper School',
      city: 'Juniper Town',
      province: 'Ontario',
      country: 'Canada',
    });
    db.addMember(hub.id, familyA.id, 'admin', 'founder');
    const attached = db.completeGoogleSignIn(session.id, SUB, EMAIL);
    assert.equal(attached.profile.id, familyA.id, 'family A starts linked');

    const familyB = db.createProfileForSession(session.id, familyInput('Cedar Parent', 'Cedar Child'));

    assert.equal(db.getProfileByGoogleSub(SUB).id, familyB.id, 'B carries the link');
    const rowA = db.getProfileRowById(familyA.id);
    assert.equal(rowA.google_sub || '', '', 'A link sub cleared');
    assert.equal(rowA.google_email || '', '', 'A link email cleared');
    const rowB = db.getProfileRowById(familyB.id);
    assert.equal(rowB.google_sub, SUB, 'B link sub stored');
    assert.equal(rowB.google_email, EMAIL, 'B link email stored');

    assert.equal(rowA.parent_name, 'Juniper Parent', 'A data intact');
    assert.deepEqual(
      db.getChildren(familyA.id).map((c) => c.name),
      ['Juniper Child'],
      'A children intact'
    );
    assert.ok(
      db.listHubsForProfile(familyA.id).some((h) => h.id === hub.id),
      'A hub membership intact'
    );

    const fresh = db.createSession();
    const back = db.completeGoogleSignIn(fresh.id, SUB, EMAIL);
    assert.equal(back.profile.id, familyB.id, 'a later sign-in restores B via unchanged rule (a)');
    assert.equal(back.switched, true);
  });

  await t.test('signed-in session with no prior family links immediately', async () => {
    const SUB = 'test-sub-link-move-b';
    const EMAIL = 'link.move.b@example.com';
    const session = db.createSession();
    db.setSessionIdentity(session.id, SUB, EMAIL);
    const family = db.createProfileForSession(session.id, familyInput('Alder Parent', 'Alder Child'));
    assert.equal(db.getProfileByGoogleSub(SUB).id, family.id, 'linked without waiting for a sign-in');
  });

  await t.test('anonymous creation links nothing', async () => {
    const anon = db.createSession();
    const family = db.createProfileForSession(anon.id, familyInput('Birch Parent', 'Birch Child'));
    assert.equal(db.getProfileByGoogleSub('test-sub-never-linked'), null);
    const row = db.getProfileRowById(family.id);
    assert.equal(row.google_sub || '', '', 'no link sub stored');
    assert.equal(row.google_email || '', '', 'no link email stored');
    const plain = db.createProfile(familyInput('Spruce Parent', 'Spruce Child'));
    const plainRow = db.getProfileRowById(plain.id);
    assert.equal(plainRow.google_sub || '', '', 'plain createProfile unchanged');
  });
});

test('signed-in POST /api/profile moves the link end to end', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-link-move-api-'));
  const dbPath = path.join(tmpDir, 'app.db');
  let child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: dbPath,
      PARENTLOOP_TEST_AUTH: '1',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitForServer() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/api/onboarding/status`);
        if (res.ok) return;
      } catch {
        // Server is still starting.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Test server did not start.');
  }
  await waitForServer();

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
      return { res, data };
    }
    return {
      get: (p, opts) => req(p, opts),
      post: (p, body) =>
        req(p, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        }),
    };
  }

  const browser = makeClient();
  const createdA = await browser.post('/api/profile', {
    parent_name: 'Willow Parent',
    child_name: 'Willow Child',
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  assert.equal(createdA.res.status, 200);
  await browser.post('/api/auth/test-complete', {
    sub: 'test-sub-link-move-api',
    email: 'link.move.api@example.com',
  });

  const createdB = await browser.post('/api/profile', {
    parent_name: 'Aspen Parent',
    child_name: 'Aspen Child',
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  assert.equal(createdB.res.status, 200);
  const statusB = await browser.get('/api/onboarding/status');
  assert.equal(statusB.data.profile.id, createdB.data.profile.id, 'session stays on the new family');

  const fresh = makeClient();
  const back = await fresh.post('/api/auth/test-complete', {
    sub: 'test-sub-link-move-api',
    email: 'link.move.api@example.com',
  });
  assert.equal(back.data.profile.id, createdB.data.profile.id, 'fresh sign-in restores the new family');
});
