// Brief 051e follow-up: when the extraction CALL fails (model HTTP error,
// timeout), a hub material is kept and the upload answers 200 with
// facts_pending + a plain message — never a 500 and never a server-side
// ReferenceError. Revision 00061 answered "kind is not defined" here
// because the catch read variables declared inside the try.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39700 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

// 1x1 PNG: a real image the server sniffs as image/png.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const NOTICE =
  'Maple Grove Elementary notice: The school picnic is on Friday, November 20, 2026. ' +
  'Please bring a water bottle and a packed lunch. Reply forms are due Wednesday, November 18, 2026.';

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
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
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
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

test('extraction call failure keeps the hub material and answers facts_pending', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-pending-'));
  // Every model call fails: the extraction call errors, nothing is extracted.
  const fakeModel = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'model unavailable' }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_PATH: path.join(tmpDir, 'app.db'),
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
      SCHOOL_AGENT_API_KEY: 'test-key',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const client = makeClient();
  await waitForServer(client);
  const prof = await client.post('/api/profile', {
    parent_name: 'Pending Founder', parent_email: 'pending.founder@example.com',
    children: [{ name: 'Pending Kid' }],
  });
  assert.equal(prof.res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Pending Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;

  await t.test('pasted text: 200 facts_pending, material kept as stored', async () => {
    const up = await client.post(`/api/hubs/${hubId}/materials`, { text: NOTICE });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts_pending, true);
    assert.ok(up.data.facts_error, 'a plain message comes back');
    assert.doesNotMatch(up.data.facts_error, /is not defined/);
    assert.equal(up.data.material.kind, 'paste');
    assert.equal(up.data.material.status, 'stored');
    assert.equal(up.data.material.hub_id, hubId);
    const detail = await client.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === up.data.material.id);
    assert.ok(mat, 'material is listed in the hub');
    assert.equal(mat.status, 'stored', 'not marked failed');
  });

  await t.test('pasted image: 200 facts_pending, file retained', async () => {
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image', imageBase64: PNG_1X1, fileName: 'notice.png',
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts_pending, true);
    assert.equal(up.data.material.kind, 'image');
    assert.equal(up.data.material.has_file, true, 'the image is kept with the material');
    assert.equal(up.data.material.file_mime, 'image/png');
    const detail = await client.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === up.data.material.id);
    assert.ok(mat && mat.has_file, 'listed with its retained file');
    assert.equal(mat.status, 'stored');
  });

  await t.test('newsletter run route: 200 facts_pending, not "hub is not defined"', async () => {
    const up = await client.post('/api/newsletter/run', { hub_id: hubId, text: NOTICE });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts_pending, true);
    assert.equal(up.data.material.hub_id, hubId);
    assert.equal(up.data.material.status, 'stored');
  });

  await t.test('server stays up afterwards', async () => {
    const alive = await client.get('/api/onboarding/status');
    assert.equal(alive.res.status, 200);
  });
});
