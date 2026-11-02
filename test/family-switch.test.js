const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 031 (fix for 028): a family switch leaked the old family through
// TIMING only — a stale placements card never refetched after a family
// switch, and an evening check whose request arrived before a concurrent
// family creation ran on its arrival-time session snapshot.
//
// Fixtures are fictional (Rowan/Sorrel). No real data.

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('create-profile success handler refreshes placements for the new family', () => {
  const handlerAt = PAGE.indexOf("getElementById('createProfileBtn')");
  assert.ok(handlerAt !== -1, 'create handler exists');
  const handler = PAGE.slice(handlerAt, PAGE.indexOf('async function switchToDemo'));
  const createAt = handler.indexOf("postJson('/api/profile', {");
  assert.ok(createAt !== -1, 'create (non-edit) path exists');
  const createPath = handler.slice(createAt, handler.indexOf('await loadHubs();\n      showMain();'));
  assert.ok(createPath.includes('renderFamily(data.profile)'), 'create path renders the new family');
  assert.ok(
    createPath.includes('await loadFamilyPlacements()'),
    'create path refetches placements alongside renderFamily/loadHubs, mirroring the edit branch'
  );
});

test('pre-transfer placements responses are never rendered post-transfer', () => {
  const fnAt = PAGE.indexOf('async function loadFamilyPlacements()');
  assert.ok(fnAt !== -1, 'loadFamilyPlacements exists');
  const fn = PAGE.slice(fnAt, PAGE.indexOf('let currentHubs = []'));
  assert.ok(fn.includes('function switchedFamily()'), 'stale-response guard exists');
  const guards = fn.split('switchedFamily()').length - 1;
  assert.ok(guards >= 3, `guard consulted on every render path (found ${guards})`);
  const hubsFetchAt = fn.indexOf("fetch('/api/hubs')");
  const firstGuardAt = fn.indexOf('if (switchedFamily()) return;');
  assert.ok(hubsFetchAt !== -1 && firstGuardAt > hubsFetchAt, 'hub-list response is dropped when the family switched mid-fetch');
  const renderAt = fn.indexOf('box.innerHTML = cards.join');
  assert.ok(renderAt !== -1, 'cards render exists');
  const guardBeforeRender = fn.lastIndexOf('if (switchedFamily()) return;', renderAt);
  assert.ok(guardBeforeRender !== -1 && guardBeforeRender > hubsFetchAt, 'detail responses are dropped when the family switched mid-fetch');
  assert.ok(
    fn.includes("if (!switchedFamily()) box.innerHTML = '<p class=\"facts-empty\">Couldn’t load your hubs.</p>'"),
    'even the load-failure message stays off a switched family'
  );
});

test('parent run and placements endpoints resolve the current viewer, not the arrival snapshot', () => {
  assert.ok(SERVER.includes('function currentViewer(session)'), 'late viewer helper exists');
  const runAt = SERVER.indexOf("url.pathname === '/api/parent/run'");
  const runCallAt = SERVER.indexOf('runParentAgent(logs', runAt);
  assert.ok(runAt !== -1 && runCallAt !== -1, 'parent run handler exists');
  assert.ok(
    SERVER.slice(runAt, runCallAt + 120).includes('currentViewer(session)'),
    'POST /api/parent/run re-reads the session row before runParentAgent'
  );
  for (const anchor of [
    "req.method === 'GET' && url.pathname === '/api/hubs'",
    "req.method === 'GET' && hubMatch",
    "req.method === 'POST' && hubPlacementsMatch",
    "req.method === 'DELETE' && hubPlacementMatch",
  ]) {
    const at = SERVER.indexOf(anchor);
    assert.ok(at !== -1, `${anchor} exists`);
    assert.ok(
      SERVER.slice(at, at + 400).includes('currentViewer(session)'),
      `${anchor} resolves the current viewer`
    );
  }
});

const PORT = 36950 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

test('switching families mid-session moves placements and the parent run to family B', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-family-switch-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const child = spawn(process.execPath, ['server.js'], {
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
  const post = (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const get = (p) => req(p);

  // Family A, signed in, with a placed school hub.
  const createdA = await post('/api/profile', {
    parent_name: 'Rowan Parent',
    children: [{ name: 'Rowan Child' }],
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  assert.equal(createdA.res.status, 200);
  await post('/api/auth/test-complete', { sub: 'test-sub-family-switch', email: 'family.switch@example.com' });
  const hubA = await post('/api/hubs', {
    school_name: 'Rowan School', city: 'Rowan Town', province: 'Ontario', country: 'Canada', kind: 'school',
  });
  assert.equal(hubA.res.status, 200);
  const kidA = (await get('/api/family-profile')).data.profile.children[0].id;
  const placedA = await post(`/api/hubs/${hubA.data.hub.id}/placements`, {
    placements: [{ child_id: kidA, grade: 'Grade 2', class: '' }],
  });
  assert.equal(placedA.res.status, 200);

  // Switch: create family B on the same signed-in session.
  const createdB = await post('/api/profile', {
    parent_name: 'Sorrel Parent',
    children: [{ name: 'Sorrel Child' }],
    priorities: [],
    nudge_style: 'one short message in the evening',
    actions: {},
  });
  assert.equal(createdB.res.status, 200);
  assert.equal(createdB.data.profile.parent.name, 'Sorrel Parent');

  // Placements resolve family B: the old hub is no longer visible, and a hub
  // created now carries only B's child, unplaced.
  const oldHub = await get(`/api/hubs/${hubA.data.hub.id}`);
  assert.equal(oldHub.res.status, 403, 'family A hub is invisible to family B');
  const hubB = await post('/api/hubs', {
    school_name: 'Sorrel School', city: 'Sorrel Town', province: 'Ontario', country: 'Canada', kind: 'school',
  });
  assert.equal(hubB.res.status, 200);
  const detailB = await get(`/api/hubs/${hubB.data.hub.id}`);
  assert.equal(detailB.res.status, 200);
  assert.deepEqual(detailB.data.children.map((c) => c.name), ['Sorrel Child']);
  assert.equal(detailB.data.needs_placement, true, 'family B starts unplaced');

  // The parent run resolves family B too: its pre-model log names B's child.
  const run = await post('/api/parent/run', {});
  const messages = (run.data.logs || []).map((l) => l.message).join('\n');
  assert.ok(
    messages.includes('family profile loaded for Sorrel Child'),
    `run executed as family B:\n${messages.slice(0, 800)}`
  );
  assert.ok(!messages.includes('Rowan Child'), 'no trace of the old family in the run');
});
