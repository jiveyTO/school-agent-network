const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 36500 + (process.pid % 200);
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

test('deriveMaterialTitle uses the first line, truncates, and falls back dated', () => {
  const { deriveMaterialTitle } = require('../server');
  assert.equal(
    deriveMaterialTitle('Maple Grove Elementary — Week of November 16, 2026\nPizza day Friday.'),
    'Maple Grove Elementary — Week of November 16, 2026'
  );
  assert.equal(deriveMaterialTitle('  \n  Hello parents\nmore'), 'Hello parents');
  assert.equal(deriveMaterialTitle('## November update\nBody here.'), 'November update');
  const long = 'x'.repeat(200);
  const truncated = deriveMaterialTitle(long + '\nsecond');
  assert.ok(truncated.length <= 81 + 1, 'long first lines truncate');
  assert.ok(truncated.endsWith('…'), 'truncation is marked');
  assert.match(deriveMaterialTitle('   \n  '), /^Newsletter — \d{4}-\d{2}-\d{2}$/);
  assert.match(deriveMaterialTitle(''), /^Newsletter — \d{4}-\d{2}-\d{2}$/);
  assert.equal(deriveMaterialTitle('Custom title', new Date('2026-11-01T00:00:00.000Z')), 'Custom title');
});

test('hub simplification: sources, website, and one-box adding', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-simplify-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;

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

  await t.test('demo school hub is seeded with its fictional website', async () => {
    await post('/api/profile/demo', {});
    const hubs = await jf('/api/hubs');
    const demo = hubs.data.hubs.find((h) => h.name === 'Grade 3 — Maple Grove Elementary');
    assert.ok(demo, 'demo school hub exists');
    assert.equal(demo.website, 'https://maplegrove-elementary.example.com');
    const detail = await jf(`/api/hubs/${demo.id}`);
    assert.equal(detail.data.hub.website, 'https://maplegrove-elementary.example.com');
  });

  await t.test('create-hub stores the school website; invalid links are rejected', async () => {
    await post('/api/profile/demo', {});
    const created = await post('/api/hubs', {
      school_name: 'Riverside North',
      city: 'Willow Creek',
      province: 'Ontario',
      country: 'Canada',
      kind: 'school',
      website: 'https://riverside-north.example.com/news',
    });
    assert.equal(created.res.status, 200, created.text.slice(0, 300));
    assert.equal(created.data.hub.website, 'https://riverside-north.example.com/news');
    const detail = await jf(`/api/hubs/${created.data.hub.id}`);
    assert.equal(detail.data.hub.website, 'https://riverside-north.example.com/news');

    const bad = await post('/api/hubs', {
      school_name: 'Riverside South',
      city: 'Willow Creek',
      province: 'Ontario',
      country: 'Canada',
      kind: 'school',
      website: 'not a url',
    });
    assert.equal(bad.res.status, 400);

    const plain = await post('/api/hubs', {
      school_name: 'Riverside West',
      city: 'Willow Creek',
      province: 'Ontario',
      country: 'Canada',
      kind: 'school',
    });
    assert.equal(plain.res.status, 200);
    assert.equal(plain.data.hub.website, '');
  });

  await t.test('admins can add a website later; members cannot; bad input fails', async () => {
    await post('/api/profile/demo', {});
    const hubs = await jf('/api/hubs');
    const hub = hubs.data.hubs.find((h) => h.name === 'Riverside West — Willow Creek');
    assert.ok(hub, 'hub without a website exists');
    assert.equal(hub.website, '');

    const saved = await post(`/api/hubs/${hub.id}/website`, { website: 'https://riverside-west.example.com' });
    assert.equal(saved.res.status, 200, saved.text.slice(0, 300));
    assert.equal(saved.data.hub.website, 'https://riverside-west.example.com');
    const detail = await jf(`/api/hubs/${hub.id}`);
    assert.equal(detail.data.hub.website, 'https://riverside-west.example.com');

    const bad = await post(`/api/hubs/${hub.id}/website`, { website: 'ftp://files.example.com/x' });
    assert.equal(bad.res.status, 400);
    const empty = await post(`/api/hubs/${hub.id}/website`, { website: '' });
    assert.equal(empty.res.status, 400);

    const tokenRes = await post(`/api/hubs/${hub.id}/invites`, {});
    assert.equal(tokenRes.res.status, 200);
    await post('/api/profile', {
      parent_name: 'Member Meg',
      child_name: 'Meg Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Riverside West',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const joined = await post(`/api/join/${tokenRes.data.token}/accept`, {});
    assert.equal(joined.res.status, 200);
    const denied = await post(`/api/hubs/${hub.id}/website`, { website: 'https://meg.example.com' });
    assert.equal(denied.res.status, 403, 'members who are not admins cannot set the website');
    await post('/api/profile/demo', {});
  });

  await t.test('simplified add extracts under an auto-title with extraction scopes', { timeout: 180000 }, async () => {
    await post('/api/profile/demo', {});
    const hubs = await jf('/api/hubs');
    const demo = hubs.data.hubs.find((h) => h.name === 'Grade 3 — Maple Grove Elementary');
    assert.ok(demo);
    const added = await post(`/api/hubs/${demo.id}/materials`, {
      kind: 'paste',
      text: 'Maple Grove Elementary — Week of November 16\nPizza lunch orders are due Friday, November 20, 2026. Please send payment with the order form.',
    });
    assert.equal(added.res.status, 200, added.text.slice(0, 400));
    assert.equal(added.data.material.title, 'Maple Grove Elementary — Week of November 16');
    assert.ok(added.data.facts_added >= 1);
    assert.ok(added.data.facts.every((f) => f.hub_id === demo.id));
    assert.ok(added.data.facts.every((f) => f.material_id === added.data.material.id), 'facts group under the new material');
    assert.ok(added.data.facts.every((f) => f.source_text), 'facts keep their source text');
    assert.ok(added.data.facts.every((f) => typeof f.group_label === 'string'), 'extraction emits group_label');
    assert.ok(
      added.data.facts.every((f) => ['school', 'grade', 'class', ''].includes(f.scope)),
      'no audience override is stamped; scopes are whatever extraction produced'
    );
    const detail = await jf(`/api/hubs/${demo.id}`);
    const listed = (detail.data.materials || []).find((m) => m.id === added.data.material.id);
    assert.ok(listed, 'auto-titled material is listed');
    assert.equal(listed.title, 'Maple Grove Elementary — Week of November 16');
    assert.ok(
      detail.data.facts.some((f) => f.material_id === added.data.material.id),
      'its facts are grouped with it in hub detail'
    );
  });
});
