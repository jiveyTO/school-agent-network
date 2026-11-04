// Brief 053: materials added from a file (pasted image, uploaded PDF) are
// titled from their content by the same extraction read, never by the file
// name. No usable title -> a neutral dated label ("Photo — Nov 2"). Pasted
// text is titled the same way (Brief 072).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39800 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

// 1x1 PNG: a real image the server sniffs as image/png.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Brief 062: re-adding the same file to a hub is a duplicate, so each
// subtest that needs a new material gets its own bytes (trailing data after
// IEND; the server still sniffs a PNG) or its own PDF text.
const pngVariant = (n) => Buffer.concat([Buffer.from(PNG_1X1, 'base64'), Buffer.from('variant ' + n)]).toString('base64');
const SCREENSHOT_NAME = 'CleanShot 2026-11-02 at 3.55.43 PM.png';
const EMAIL_TITLE = 'Remembrance Day & Anti-Bullying Week — principal’s email';
const PHOTO_DAY_TEXT =
  'Photo Day notice: Maple Grove Elementary Photo Day is Thursday, November 12, 2026. ' +
  'Students should wear their uniform. Order forms are due Monday, November 9, 2026.';

const FACT = {
  id: 'photo-day-1', type: 'event', title: 'Photo Day',
  detail: 'School photo day.', date: '2026-11-12', time: '',
  applies_to: 'all students', action_required: false, action: '', link: '',
  source_document: 'notice', source_text: 'Photo Day is Thursday, November 12, 2026.',
  published_at: '', extracted_at: '', confidence: 1, supersedes: '',
  group_label: '', group_summary: '',
};

// Minimal one-page PDF with a text layer (dense enough to skip OCR).
function textPdf(text) {
  const stream = 'BT /F1 10 Tf 40 720 Td (' + text.replace(/([()\\])/g, '\\$1') + ') Tj ET';
  const objs = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(out, 'latin1');
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

function systemOf(body) {
  return String(((body && body.messages) || [])[0] && body.messages[0].content || '');
}

test('file materials are titled from their content, not the file name', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-mtitle-'));
  // What the stub model proposes as material_title next; null = reply with
  // a plain facts array (no title at all).
  let nextTitle = null;
  const prompts = [];
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      prompts.push(systemOf(body));
      const content = nextTitle === null
        ? JSON.stringify([FACT])
        : JSON.stringify({ material_title: nextTitle, facts: [FACT] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1',
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
    parent_name: 'Title Founder', parent_email: 'title.founder@example.com',
    children: [{ name: 'Title Kid' }],
  });
  assert.equal(prof.res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Title Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;
  const listed = async (id) => (await client.get(`/api/hubs/${hubId}`)).data.materials.find((m) => m.id === id);
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  await t.test('pasted screenshot takes the subject line the model read, not the file name', async () => {
    nextTitle = EMAIL_TITLE;
    prompts.length = 0;
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image', imageBase64: PNG_1X1, fileName: SCREENSHOT_NAME,
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.ok(prompts.some((p) => /material_title/.test(p)), 'the extraction read was asked for a title');
    assert.equal(up.data.material.title, EMAIL_TITLE, 'upload response carries the content title');
    const mat = await listed(up.data.material.id);
    assert.equal(mat.title, EMAIL_TITLE, 'hub list shows the content title');
    assert.ok(!/CleanShot/.test(mat.title));
    assert.ok((up.data.facts || []).every((f) => f.source_document === EMAIL_TITLE), 'facts are stamped with the new title');
  });

  await t.test('uploaded PDF takes a descriptive title from its text', async () => {
    nextTitle = 'Photo Day notice';
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', fileName: 'scan_20261102_0915.pdf', fileBase64: textPdf(PHOTO_DAY_TEXT).toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.material.title, 'Photo Day notice');
    assert.equal((await listed(up.data.material.id)).title, 'Photo Day notice');
  });

  await t.test('no title in the read -> neutral dated label, never the file name', async () => {
    nextTitle = null;
    const img = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image', imageBase64: pngVariant(1), fileName: SCREENSHOT_NAME,
    });
    assert.equal(img.res.status, 200, img.text.slice(0, 400));
    assert.equal(img.data.material.title, `Photo — ${today}`);
    const pdf = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', fileName: 'scan_20261102_0915.pdf', fileBase64: textPdf(PHOTO_DAY_TEXT + ' Second copy.').toString('base64'),
    });
    assert.equal(pdf.res.status, 200, pdf.text.slice(0, 400));
    assert.equal(pdf.data.material.title, `Document — ${today}`);
  });

  await t.test('a file-name or ungrounded title is refused for the neutral label', async () => {
    nextTitle = 'CleanShot 2026-11-02 at 3.55.43 PM';
    const img = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image', imageBase64: pngVariant(2), fileName: SCREENSHOT_NAME,
    });
    assert.equal(img.data.material.title, `Photo — ${today}`);
    // "December 3" is not in the PDF's text: an invented date.
    nextTitle = 'Photo Day — December 3';
    const pdf = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', fileName: 'notice.pdf', fileBase64: textPdf(PHOTO_DAY_TEXT + ' Third copy.').toString('base64'),
    });
    assert.equal(pdf.data.material.title, `Document — ${today}`);
  });

  // Brief 072: pasted text now asks the same read for a title too
  // (test/paste-title.test.js covers it in full).
  await t.test('pasted text is titled from its content too', async () => {
    nextTitle = 'Photo Day notice';
    prompts.length = 0;
    const up = await client.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text: PHOTO_DAY_TEXT });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.ok(prompts.some((p) => /material_title/.test(p)), 'the paste read is asked for a title');
    assert.equal(up.data.material.title, 'Photo Day notice');
  });
});
