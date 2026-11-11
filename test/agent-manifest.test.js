const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 047: public GET /api/agent manifest. It must describe the real
// agent surface (045 lookup + 046 Bearer tokens) truthfully, expose no
// family/hub/member data, and keep the demo evening check unchanged.

const ROOT = path.join(__dirname, '..');
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PORT = 38300 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

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
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data, text };
}
function post(urlPath, body) {
  return jf(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}
async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const probed = await jf('/api/onboarding/status');
      if (probed.res.ok) return;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

// Every manifest endpoint must correspond to a handler in server.js.
function assertRealRoute(endpoint) {
  const { method, path: p } = endpoint;
  assert.ok(method && p, 'endpoint has method and path');
  if (p === '/api/hubs/lookup') {
    assert.ok(SERVER_SOURCE.includes("url.pathname === '/api/hubs/lookup'"), 'lookup route exists');
  } else if (p === '/api/family-profile') {
    assert.ok(SERVER_SOURCE.includes("url.pathname === '/api/family-profile'"), 'family route exists');
  } else if (p === '/api/hubs' && method === 'GET') {
    assert.ok(SERVER_SOURCE.includes("req.method === 'GET' && url.pathname === '/api/hubs'"), 'my hubs route exists');
  } else if (p === '/api/hubs' && method === 'POST') {
    assert.ok(SERVER_SOURCE.includes("req.method === 'POST' && url.pathname === '/api/hubs'"), 'create hub route exists');
  } else if (/^\/api\/hubs\/\{[^}]+\}\/placements$/.test(p)) {
    assert.ok(SERVER_SOURCE.includes('hubPlacementsMatch') && SERVER_SOURCE.includes("req.method === 'POST' && hubPlacementsMatch"), 'placements route exists');
  } else if (/^\/api\/join\/\{[^}]+\}\/accept$/.test(p)) {
    assert.ok(SERVER_SOURCE.includes('joinAcceptMatch') && SERVER_SOURCE.includes("req.method === 'POST' && joinAcceptMatch"), 'invite accept route exists');
  } else if (/^\/api\/join\/\{[^}]+\}\/connect$/.test(p)) {
    assert.ok(SERVER_SOURCE.includes("req.method === 'POST' && joinConnectMatch"), 'invite connect route exists');
  } else if (/^\/api\/agent-connect\/\{[^}]+\}\/token$/.test(p)) {
    assert.ok(SERVER_SOURCE.includes("req.method === 'POST' && agentConnectActionMatch") && SERVER_SOURCE.includes("action === 'token'"),
      'agent token collect route exists');
  } else if (/^\/api\/hubs\/\{[^}]+\}$/.test(p)) {
    assert.ok(SERVER_SOURCE.includes('hubMatch') && SERVER_SOURCE.includes("req.method === 'GET' && hubMatch"), 'hub read route exists');
  } else if (/^\/api\/hubs\/\{[^}]+\}\/materials$/.test(p)) {
    assert.ok(SERVER_SOURCE.includes('hubMaterialsMatch') && SERVER_SOURCE.includes("req.method === 'POST' && hubMaterialsMatch"), 'add material route exists');
  } else if (/^\/api\/hubs\/\{[^}]+\}\/materials\/\{[^}]+\}$/.test(p) && (method === 'PATCH' || method === 'DELETE')) {
    assert.ok(SERVER_SOURCE.includes(`req.method === '${method}' && hubMaterialMatch`), `${method} material route exists`);
    const at = SERVER_SOURCE.indexOf(`req.method === '${method}' && hubMaterialMatch`);
    assert.ok(SERVER_SOURCE.slice(at, at + 200).includes('bearerAuth ? bearerAuth.profile'), `${method} material accepts an agent token`);
  } else if (p === '/api/parent/run' && method === 'POST') {
    assert.ok(SERVER_SOURCE.includes("req.method === 'POST' && url.pathname === '/api/parent/run'"), 'evening check route exists');
  } else if (p === '/api/parent/latest' && method === 'GET') {
    assert.ok(SERVER_SOURCE.includes("req.method === 'GET' && url.pathname === '/api/parent/latest'"), 'latest evening check route exists');
  } else if (p === '/api/agent/evening-check' && method === 'POST') {
    assert.ok(SERVER_SOURCE.includes("req.method === 'POST' && url.pathname === '/api/agent/evening-check'"), 'submit evening check route exists');
  } else if (p === '/api/agent/context' && method === 'GET') {
    assert.ok(SERVER_SOURCE.includes("req.method === 'GET' && url.pathname === '/api/agent/context'"), 'context bundle route exists');
  } else {
    assert.fail(`manifest lists an endpoint with no known real route: ${method} ${p}`);
  }
}

const EXPECTED_ENDPOINTS = [
  ['GET', '/api/hubs/lookup'],
  ['GET', '/api/family-profile'],
  ['GET', '/api/hubs'],
  ['POST', '/api/hubs'],
  ['POST', '/api/hubs/{hub_id}/placements'],
  ['POST', '/api/join/{token}/accept'],
  ['POST', '/api/join/{token}/connect'],
  ['POST', '/api/agent-connect/{request_id}/token'],
  ['GET', '/api/hubs/{hub_id}'],
  ['POST', '/api/hubs/{hub_id}/materials'],
  ['PATCH', '/api/hubs/{hub_id}/materials/{material_id}'],
  ['DELETE', '/api/hubs/{hub_id}/materials/{material_id}'],
  ['POST', '/api/parent/run'],
  ['GET', '/api/parent/latest'],
  ['GET', '/api/agent/context'],
  ['POST', '/api/agent/evening-check'],
];

test('GET /api/agent manifest: shape, real routes, recipe, no data', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-manifest-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  let manifest = null;
  await t.test('public manifest returns 200 with documented top-level keys', async () => {
    // No cookie, no Bearer: the front door is public.
    const res = await fetch(`${BASE}/api/agent`);
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    manifest = data;
    for (const key of ['service', 'purpose', 'auth', 'endpoints', 'recipe']) {
      assert.ok(key in data, `top-level key present: ${key}`);
    }
    assert.equal(data.service, 'ParentLoop');
    assert.ok(typeof data.purpose === 'string' && data.purpose.length > 10, 'one-line purpose');
    // Auth scheme: human-issued Bearer token, one family, revocable.
    const authText = JSON.stringify(data.auth).toLowerCase();
    assert.ok(authText.includes('bearer'), 'auth names Bearer');
    assert.ok(authText.includes('my family'), 'auth says where a parent issues it');
    assert.ok(authText.includes('agent access'), 'auth names the Agent access section');
    assert.ok(authText.includes('one family') || authText.includes('single family'), 'auth says scoped to one family');
    assert.ok(authText.includes('revoc'), 'auth says revocable');
    assert.ok(authText.includes('authorization'), 'auth names the header');
    // No family, hub, or member data beyond the manifest itself.
    assert.ok(!/@/.test(text), 'no email addresses in the manifest');
    assert.ok(!text.includes('Maya Rivera'), 'no member/child data in the manifest');
    assert.ok(!('profile' in data) && !('hub' in data) && !('members' in data), 'no data payload keys');
  });

  await t.test('every listed endpoint corresponds to a real route', async () => {
    assert.ok(Array.isArray(manifest.endpoints), 'endpoints is a list');
    const listed = manifest.endpoints.map((e) => [e.method, e.path]);
    assert.deepEqual(listed, EXPECTED_ENDPOINTS, 'endpoint directory matches the shipped agent surface');
    for (const endpoint of manifest.endpoints) {
      assert.ok(typeof endpoint.description === 'string' && endpoint.description.length > 0, `description for ${endpoint.method} ${endpoint.path}`);
      assertRealRoute(endpoint);
    }
  });

  await t.test('evening routine tells an agent to read, refresh if stale, and tell the parent', async () => {
    const routine = manifest.evening_routine;
    assert.ok(Array.isArray(routine) && routine.length >= 3, 'evening routine is listed');
    const text = routine.join('\n');
    assert.ok(text.indexOf('GET /api/parent/latest') !== -1 && text.indexOf('POST /api/parent/run') > text.indexOf('GET /api/parent/latest'),
      'read the saved check first, run only when stale');
    assert.ok(/stale/.test(text) && /tell the parent/i.test(text), 'refresh when stale, then tell the parent');
  });

  await t.test('both evening check modes are documented: app check, and agent relay / generate', async () => {
    const modes = manifest.evening_check_modes;
    assert.ok(modes && modes.app_check && modes.agent_check, 'app and agent modes listed');
    assert.deepEqual(modes.app_check.endpoints, ['GET /api/parent/latest', 'POST /api/parent/run']);
    const { relay, generate } = modes.agent_check.styles || {};
    assert.ok(relay && generate, 'agent mode has both styles');
    const relayText = relay.steps.join('\n');
    assert.ok(relayText.includes('GET /api/parent/latest') && relayText.includes('POST /api/parent/run'), 'relay calls the prepared check');
    assert.ok(/local context/i.test(relay.summary), 'relay may add local context');
    const genText = generate.steps.join('\n');
    assert.ok(genText.includes('GET /api/agent/context') && genText.includes('?since='), 'generate fetches the bundle with since');
    assert.ok(/never send it to ParentLoop/i.test(genText), 'private context stays with the agent');
    // Brief 032: agent mode is pull -> check -> submit back.
    assert.equal(generate.steps.length, 3, 'three-step obligation');
    assert.ok(generate.steps[0].includes('GET /api/agent/context') && generate.steps[2].includes('POST /api/agent/evening-check'), 'pull first, submit last');
    assert.deepEqual(generate.endpoints, ['GET /api/agent/context', 'POST /api/agent/evening-check']);
    const bundle = manifest.endpoints.find((e) => e.path === '/api/agent/context');
    assert.ok(/source_quote/.test(bundle.description) && /cautions/.test(bundle.description), 'bundle documents quotes and cautions');
    assert.ok(bundle.query && bundle.query.since, 'since query documented');
  });

  await t.test('find-or-create recipe is ordered lookup -> join/create -> placements -> report', async () => {
    const recipe = manifest.recipe || manifest.find_or_create || manifest.workflow;
    assert.ok(Array.isArray(recipe) && recipe.length >= 4, 'recipe has ordered steps');
    const text = recipe.map((s) => (typeof s === 'string' ? s : JSON.stringify(s)).toLowerCase()).join('\n');
    const lookupAt = text.indexOf('lookup');
    const joinAt = Math.max(text.indexOf('join'), text.indexOf('redeem'), text.indexOf('accept'));
    const createAt = text.indexOf('create');
    const placementsAt = text.indexOf('placement');
    const reportAt = text.lastIndexOf('report');
    assert.ok(lookupAt !== -1 && joinAt !== -1 && createAt !== -1, 'recipe covers lookup, join/redeem, create');
    assert.ok(lookupAt < joinAt && lookupAt < createAt, 'lookup comes first');
    assert.ok(Math.max(joinAt, createAt) < placementsAt, 'join/create before placements');
    assert.ok(placementsAt < reportAt, 'placements before report back');
    // The manifest also carries the recipe under an explicit alias.
    assert.ok('find_or_create' in manifest || 'findOrCreate' in manifest, 'find-or-create key present');
  });

  await t.test('demo evening check regression unchanged', { timeout: 180000 }, async () => {
    jarCookie = '';
    await post('/api/profile/demo', {});
    const run = await post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.equal(run.data.nudges.length, 3);
    assert.equal(run.data.conflicts.length, 3);
    assert.equal(run.data.relevant_count, 28);
    assert.equal(run.data.filtered_out_count, 1);
    const lastLog = run.data.logs[run.data.logs.length - 1].message;
    assert.ok(lastLog.startsWith('PRIVACY CHECK: family profile data used only inside this Parent Agent run'));
  });
});
