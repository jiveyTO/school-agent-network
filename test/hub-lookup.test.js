const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 38200 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

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

// Lookup with no session cookie at all: the read is public.
async function lookup(query) {
  const res = await fetch(`${BASE}/api/hubs/lookup?${new URLSearchParams(query)}`);
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { res, data, text };
}

const FORBIDDEN_HUB_KEYS = [
  'id',
  'members',
  'member_list',
  'member_ids',
  'facts',
  'materials',
  'contents',
  'profiles',
  'profile',
  'children',
  'emails',
  'parent_name',
  'parent_email',
  'created_by',
  'invites',
  'join_requests',
];

function assertPublicCardOnly(result) {
  assert.ok(result.data.hub, 'hub card present');
  for (const key of FORBIDDEN_HUB_KEYS) {
    assert.ok(!(key in result.data.hub), `forbidden hub key absent: ${key}`);
  }
  assert.ok(!('members' in result.data), 'no top-level members');
  assert.ok(!('facts' in result.data), 'no top-level facts');
  assert.ok(!('materials' in result.data), 'no top-level materials');
  assert.ok(!/@/.test(result.text), 'no email addresses in the response');
  assert.ok(!result.text.includes('Maya Rivera'), 'no child names in the response');
}

test('hub lookup exposes the school duplicate guard as a public read', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-lookup-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await t.test('seeded demo school returns exact with the public card', async () => {
    const result = await lookup({
      school: 'Grade 3',
      city: 'Maple Grove Elementary',
      province: 'Ontario',
      country: 'Canada',
    });
    assert.equal(result.res.status, 200, result.text.slice(0, 300));
    assert.equal(result.data.match, 'exact');
    assert.equal(result.data.hub.name, 'Grade 3 — Maple Grove Elementary');
    assert.equal(result.data.hub.city, 'Maple Grove Elementary');
    assert.equal(result.data.hub.province, '');
    assert.equal(result.data.hub.country, '');
    assert.ok(Number(result.data.hub.families) >= 1, 'family count is public');
    assert.equal(result.data.hub.founder_first_name, 'Alex');
    assertPublicCardOnly(result);
  });

  await t.test('a created school is found exactly, aliases included, without sign-in', async () => {
    await post('/api/profile', {
      parent_name: 'Founder Pat',
      parent_email: 'founder.pat@example.com',
      child_name: 'Pat Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'St. Nicholas',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const created = await post('/api/hubs', {
      school_name: 'St. Nicholas',
      city: 'Willow Creek',
      province: 'Ontario',
      country: 'Canada',
      kind: 'school',
    });
    assert.equal(created.res.status, 200, created.text.slice(0, 300));

    const result = await lookup({
      school: 'Saint Nicholas',
      city: 'Willow Creek',
      province: 'ON',
      country: 'CA',
    });
    assert.equal(result.res.status, 200, result.text.slice(0, 300));
    assert.equal(result.data.match, 'exact');
    assert.equal(result.data.hub.name, 'St. Nicholas — Willow Creek');
    assert.equal(result.data.hub.city, 'Willow Creek');
    assert.equal(result.data.hub.province, 'Ontario');
    assert.equal(result.data.hub.country, 'Canada');
    assert.equal(result.data.hub.families, 1);
    assert.equal(result.data.hub.founder_first_name, 'Founder');
    assertPublicCardOnly(result);
    assert.ok(!result.text.includes('Pat Kid'), 'no child names in the response');
    assert.ok(!result.text.includes('Founder Pat'), 'no full member names beyond founder first name');
  });

  await t.test('a near-name returns similar with the same public card', async () => {
    const result = await lookup({
      school: 'St. Nicholas East',
      city: 'Willow Creek',
      province: 'Ontario',
      country: 'Canada',
    });
    assert.equal(result.res.status, 200, result.text.slice(0, 300));
    assert.equal(result.data.match, 'similar');
    assert.equal(result.data.hub.name, 'St. Nicholas — Willow Creek');
    assert.equal(result.data.hub.founder_first_name, 'Founder');
    assertPublicCardOnly(result);
  });

  await t.test('an unknown school returns none with a null hub', async () => {
    const result = await lookup({
      school: 'Nonsense Academy',
      city: 'Nowhere Falls',
      province: 'Ontario',
      country: 'Canada',
    });
    assert.equal(result.res.status, 200, result.text.slice(0, 300));
    assert.equal(result.data.match, 'none');
    assert.equal(result.data.hub, null);
  });

  await t.test('missing params are a plain 400', async () => {
    const empty = await lookup({});
    assert.equal(empty.res.status, 400);
    assert.ok(typeof empty.data.error === 'string' && empty.data.error.length > 0);
    const partial = await lookup({ school: 'St. Nicholas' });
    assert.equal(partial.res.status, 400);
    assert.ok(typeof partial.data.error === 'string' && partial.data.error.length > 0);
    const noProvince = await lookup({
      school: 'St. Nicholas',
      city: 'Willow Creek',
      country: 'Canada',
    });
    assert.equal(noProvince.res.status, 400);
  });
});
