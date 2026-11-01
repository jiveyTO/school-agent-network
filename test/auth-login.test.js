const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Account login (Google identity <-> family linking). The real OAuth callback
// needs Google; tests exercise the same server-side completion path through
// the test-only /api/auth/test-complete endpoint (enabled here via
// PARENTLOOP_TEST_AUTH=1, never set in production) plus the real login
// redirect, status, logout, and header markup.
//
// Fixtures are fictional (Northwind family). No real data.

const ROOT = path.join(__dirname, '..');
const PORT = 34300 + (process.pid % 800);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let child = null;
let tmpDir = null;

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
    get: (p, opts) => req(p, opts),
    post: (p, body) =>
      req(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
  };
}

async function makeFamily(client, parentName, childName) {
  const created = await client.post('/api/profile', {
    parent_name: parentName,
    child_name: childName,
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  assert.equal(created.res.status, 200);
  return created.data.profile;
}

test('account login: attach, return, sign-out, demo guard, header', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-auth-'));
  const dbPath = path.join(tmpDir, 'app.db');
  child = spawn(process.execPath, ['server.js'], {
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
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await t.test('login redirects to Google with identity scopes only', async () => {
    const anon = makeClient();
    const login = await anon.get('/api/auth/login', { redirect: 'manual' });
    assert.equal(login.res.status, 302);
    const location = login.res.headers.get('location') || '';
    assert.ok(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'), 'Google consent URL');
    const target = new URL(location);
    assert.equal(target.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
    assert.ok(target.searchParams.get('redirect_uri').endsWith('/api/auth/callback'), 'login callback URI');
    const scope = target.searchParams.get('scope') || '';
    assert.ok(scope.includes('openid') && scope.includes('email') && scope.includes('profile'), 'identity scopes');
    assert.ok(!scope.includes('gmail'), 'no gmail scopes on the login flow');
    assert.ok(target.searchParams.get('state'), 'one-time state nonce');
  });

  await t.test('attach flow: family created anonymously becomes the account family', async () => {
    const browser = makeClient();
    const family = await makeFamily(browser, 'Northwind Parent', 'Northwind Child');
    const done = await browser.post('/api/auth/test-complete', {
      sub: 'test-sub-northwind',
      email: 'northwind.parent@example.com',
    });
    assert.equal(done.res.status, 200);
    assert.equal(done.data.signed_in, true);
    assert.equal(done.data.email, 'northwind.parent@example.com');
    const status = await browser.get('/api/onboarding/status');
    assert.equal(status.data.profile.id, family.id, 'same family after sign-in');
    assert.equal(status.data.needsOnboarding, false);
    assert.equal(status.data.auth.signed_in, true);
    assert.equal(status.data.auth.email, 'northwind.parent@example.com');
  });

  await t.test('returning flow: brand-new session restores the same family and hubs', async () => {
    const first = makeClient();
    const family = await makeFamily(first, 'Harbor Parent', 'Harbor Child');
    const hub = await first.post('/api/hubs', {
      school_name: 'Harbor School',
      city: 'Harbor Town',
      province: 'Ontario',
      country: 'Canada',
      kind: 'school',
    });
    assert.equal(hub.res.status, 200);
    await first.post('/api/auth/test-complete', { sub: 'test-sub-harbor', email: 'harbor.parent@example.com' });

    const second = makeClient();
    const fresh = await second.get('/api/onboarding/status');
    assert.equal(fresh.data.profile.is_demo, true, 'brand-new session starts on demo');
    const back = await second.post('/api/auth/test-complete', {
      sub: 'test-sub-harbor',
      email: 'harbor.parent@example.com',
    });
    assert.equal(back.data.profile.id, family.id, 'same family restored');
    const hubs = await second.get('/api/hubs');
    assert.ok(hubs.data.hubs.some((h) => h.id === hub.data.hub.id), 'hubs come back too');
  });

  await t.test('account family wins when the session already has its own family', async () => {
    const owner = makeClient();
    const owned = await makeFamily(owner, 'Owned Parent', 'Owned Child');
    await owner.post('/api/auth/test-complete', { sub: 'test-sub-owner', email: 'owned.parent@example.com' });

    const other = makeClient();
    await makeFamily(other, 'Other Parent', 'Other Child');
    const done = await other.post('/api/auth/test-complete', {
      sub: 'test-sub-owner',
      email: 'owned.parent@example.com',
    });
    assert.equal(done.data.profile.id, owned.id, 'account family wins, no merging');
  });

  await t.test('sign-out detaches the session but keeps the stored family', async () => {
    const browser = makeClient();
    const family = await makeFamily(browser, 'Signout Parent', 'Signout Child');
    const hub = await browser.post('/api/hubs', {
      school_name: 'Signout School',
      city: 'Signout Town',
      province: 'Ontario',
      country: 'Canada',
      kind: 'school',
    });
    assert.equal(hub.res.status, 200);
    await browser.post('/api/auth/test-complete', { sub: 'test-sub-signout', email: 'signout.parent@example.com' });

    const out = await browser.post('/api/auth/logout', {});
    assert.equal(out.data.ok, true);
    const status = await browser.get('/api/auth/status');
    assert.equal(status.data.signed_in, false);
    assert.equal(status.data.email, '');
    const viewing = await browser.get('/api/onboarding/status');
    assert.equal(viewing.data.profile.is_demo, true, 'session returns to demo/anonymous');
    assert.equal(viewing.data.needsOnboarding, true);

    const again = await browser.post('/api/auth/test-complete', {
      sub: 'test-sub-signout',
      email: 'signout.parent@example.com',
    });
    assert.equal(again.data.profile.id, family.id, 'family comes back at the next sign-in');
    const hubs = await browser.get('/api/hubs');
    assert.ok(hubs.data.hubs.some((h) => h.id === hub.data.hub.id), 'hubs intact after sign-out');
  });

  await t.test('demo family cannot be attached', async () => {
    const viewer = makeClient();
    const before = await viewer.get('/api/onboarding/status');
    assert.equal(before.data.profile.is_demo, true);
    const done = await viewer.post('/api/auth/test-complete', {
      sub: 'test-sub-demo-viewer',
      email: 'demo.viewer@example.com',
    });
    assert.equal(done.data.signed_in, true, 'identity still signs in');
    const status = await viewer.get('/api/onboarding/status');
    assert.equal(status.data.profile.is_demo, true, 'viewing demo goes to onboarding, not a claimed demo');
    assert.equal(status.data.needsOnboarding, true);
    // The demo family was not claimed: the same account from a fresh session
    // still has no family of its own.
    const fresh = makeClient();
    const back = await fresh.post('/api/auth/test-complete', {
      sub: 'test-sub-demo-viewer',
      email: 'demo.viewer@example.com',
    });
    assert.equal(back.data.profile, null, 'no family was attached to the account');
  });

  await t.test('header renders sign-in when out, email + sign-out when in', async () => {
    for (const token of [
      'id="authArea"',
      'id="signInBtn"',
      'Sign in with Google',
      '/api/auth/login',
      'id="signedInAs"',
      'Signed in as',
      'id="signedInEmail"',
      'id="signOutBtn"',
      'Sign out',
      '/api/auth/status',
      '/api/auth/logout',
    ]) {
      assert.ok(PAGE.includes(token), `${token} must be present in the header`);
    }
    assert.ok(!PAGE.includes('access_token') && !PAGE.includes('id_token'), 'no token lands in the page');
  });
});
