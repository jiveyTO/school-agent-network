// Brief 043: a PDF whose words live inside a picture (image-only page)
// yields little or no text for that page. The material must carry a
// visible caution instead of silently looking complete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 37500 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

const DENSE =
  'Maple Grove Elementary notice: The school picnic is on Friday, November 20, 2026. ' +
  'Please bring a water bottle and a packed lunch. Reply forms are due Wednesday, November 18, 2026.';

const GOOD_FACTS = JSON.stringify([
  {
    id: 'picnic-1', type: 'event', title: 'School picnic',
    detail: 'School picnic.', date: '2026-11-20', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'notice', source_text: 'The school picnic is on Friday, November 20, 2026.',
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  },
]);

// Build a multi-page PDF; a page whose text is '' has no text operators
// at all, standing in for a picture-only flyer page.
function buildPdf(pageTexts) {
  const objs = [];
  const pageIds = pageTexts.map((_, i) => 3 + i * 2);
  const fontId = 3 + pageTexts.length * 2;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageTexts.length + ' >>';
  pageTexts.forEach((text, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const stream = text
      ? 'BT /F1 12 Tf 72 720 Td (' + String(text).replace(/([()\\])/g, '\\$1') + ') Tj ET'
      : '';
    objs[pageId] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentId +
      ' 0 R /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> >>';
    objs[contentId] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
  });
  objs[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(out);
  out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
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

test('picture-risk: picture-only page flags the material, dense text does not', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-picrisk-'));
  const fakeModel = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_FACTS }, finish_reason: 'stop' }] }));
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
    parent_name: 'Pic Founder', parent_email: 'pic.founder@example.com',
    children: [{ name: 'Pic Kid' }],
  });
  assert.equal(prof.res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Pic Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;

  const sparse = await client.post(`/api/hubs/${hubId}/materials`, {
    kind: 'pdf', fileName: 'flyer.pdf',
    fileBase64: buildPdf([DENSE, '']).toString('base64'),
  });
  assert.equal(sparse.res.status, 200, sparse.text.slice(0, 300));
  assert.equal(sparse.data.material.may_have_unread_pictures, true, 'upload response flags the picture-only page');

  const dense = await client.post(`/api/hubs/${hubId}/materials`, {
    kind: 'pdf', fileName: 'notice.pdf',
    fileBase64: buildPdf([DENSE]).toString('base64'),
  });
  assert.equal(dense.res.status, 200, dense.text.slice(0, 300));
  assert.equal(dense.data.material.may_have_unread_pictures, false, 'dense single-page PDF is not flagged');

  const detail = await client.get(`/api/hubs/${hubId}`);
  const sparseMat = detail.data.materials.find((m) => m.id === sparse.data.material.id);
  const denseMat = detail.data.materials.find((m) => m.id === dense.data.material.id);
  assert.equal(sparseMat.may_have_unread_pictures, true, 'hub list keeps the flag');
  assert.equal(denseMat.may_have_unread_pictures, false, 'hub list keeps dense material unflagged');

  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(page.includes('may_have_unread_pictures'), 'page renders from the flag');
  assert.ok(page.includes('inside pictures'), 'page shows the picture caution');
});
