// Brief 048: a PDF flagged picture-risk (brief 043) gets its flagged
// pages read as images (OCR via the vision model call). Recovered text
// merges with the text layer and feeds the same grounded extraction.
// Dense PDFs never invoke vision; vision failure degrades to today's
// behavior (text-layer extraction + picture caution).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 38300 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

const DENSE =
  'Maple Grove Elementary notice: The school picnic is on Friday, November 20, 2026. ' +
  'Please bring a water bottle and a packed lunch. Reply forms are due Wednesday, November 18, 2026.';
const OCR_TEXT =
  'Holiday Family Skate: Bring the whole family for a holiday skate on Saturday, December 19, 2026 at Maple Grove Arena.';
const SKATE_QUOTE =
  'Bring the whole family for a holiday skate on Saturday, December 19, 2026 at Maple Grove Arena.';

const PICNIC_FACTS = JSON.stringify([
  {
    id: 'picnic-1', type: 'event', title: 'School picnic',
    detail: 'School picnic.', date: '2026-11-20', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'notice', source_text: 'The school picnic is on Friday, November 20, 2026.',
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  },
]);
const SKATE_FACTS = JSON.stringify([
  {
    id: 'skate-1', type: 'event', title: 'Holiday Family Skate',
    detail: 'Holiday family skate at Maple Grove Arena.', date: '2026-12-19', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'notice', source_text: SKATE_QUOTE,
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  },
]);

// Build a multi-page PDF. A page spec is a string (text layer), '' (no
// text at all), or { image: true } (a picture-only page: an embedded
// image XObject and no text operators — the brief 043 holiday-skate case).
function buildPdf(pageSpecs) {
  const objs = [];
  const pageIds = pageSpecs.map((_, i) => 3 + i * 2);
  const imageId = 3 + pageSpecs.length * 2;
  const fontId = imageId + 1;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageSpecs.length + ' >>';
  pageSpecs.forEach((spec, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const isImage = spec && typeof spec === 'object' && spec.image;
    const stream = isImage
      ? 'q 400 0 0 300 72 400 cm /Im1 Do Q'
      : spec
        ? 'BT /F1 12 Tf 72 720 Td (' + String(spec).replace(/([()\\])/g, '\\$1') + ') Tj ET'
        : '';
    const resources = isImage
      ? '<< /XObject << /Im1 ' + imageId + ' 0 R >> >>'
      : '<< /Font << /F1 ' + fontId + ' 0 R >> >>';
    objs[pageId] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentId +
      ' 0 R /Resources ' + resources + ' >>';
    objs[contentId] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
  });
  // 8x4 RGB image (the picture). Pixel content is irrelevant to the
  // stubbed vision model; presence as a page image is what matters.
  const raw = Buffer.alloc(8 * 4 * 3, 200);
  const comp = zlib.deflateSync(raw);
  objs[imageId] = null; // binary, emitted below
  objs[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    if (objs[i] === undefined) continue;
    offsets[i] = out.length;
    if (i === imageId) {
      out = Buffer.concat([
        out,
        Buffer.from(i + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + comp.length + ' >>\nstream\n', 'latin1'),
        comp,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      out = Buffer.concat([out, Buffer.from(i + ' 0 obj\n' + objs[i] + '\nendobj\n', 'latin1')]);
    }
  }
  const xref = out.length;
  let tail = 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (let i = 1; i < objs.length; i++) tail += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
  tail += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.concat([out, Buffer.from(tail, 'latin1')]);
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

function hasImagePart(body) {
  const msgs = (body && body.messages) || [];
  return msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'));
}
function isOcrRequest(body) {
  const system = String(((body.messages || [])[0] || {}).content || '');
  return /transcrib/i.test(system);
}
function userTextOf(body) {
  const user = (body.messages || []).find((m) => m.role === 'user');
  if (!user) return '';
  if (typeof user.content === 'string') return user.content;
  return (user.content || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
}

test('pdf ocr: picture page is read, dense PDF skips vision, failure degrades', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-pdfocr-'));
  const modelRequests = [];
  let failOcr = false;
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      modelRequests.push(body);
      if (body && isOcrRequest(body)) {
        if (failOcr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'vision unavailable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: OCR_TEXT }, finish_reason: 'stop' }] }));
        return;
      }
      const text = body ? userTextOf(body) : '';
      const facts = /Family Skate/.test(text) ? SKATE_FACTS : PICNIC_FACTS;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: facts }, finish_reason: 'stop' }] }));
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
    parent_name: 'Ocr Founder', parent_email: 'ocr.founder@example.com',
    children: [{ name: 'Ocr Kid' }],
  });
  assert.equal(prof.res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Ocr Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;

  await t.test('picture-only page yields a fact grounded in the picture text', async () => {
    modelRequests.length = 0;
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', fileName: 'preview.pdf',
      fileBase64: buildPdf([DENSE, { image: true }]).toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    // The flagged page went through the vision (image_url) read.
    assert.ok(modelRequests.some((b) => b && isOcrRequest(b) && hasImagePart(b)), 'vision OCR call carried an image part');
    // The grounded extraction then saw the OCR text like ordinary text.
    const extraction = modelRequests.filter((b) => b && !isOcrRequest(b)).pop();
    assert.ok(extraction && /Family Skate/.test(userTextOf(extraction)), 'extraction input includes the OCR text');
    const skate = (up.data.facts || []).find((f) => /skate/i.test(f.title || ''));
    assert.ok(skate, 'a fact came from the picture page');
    assert.equal(skate.source_text, SKATE_QUOTE, 'fact is grounded verbatim in the OCR text');
    assert.equal(up.data.material.pictures_read_with_ocr, true, 'upload response records the OCR read');
    assert.equal(up.data.material.may_have_unread_pictures, true, 'material was picture-flagged');

    const detail = await client.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === up.data.material.id);
    assert.ok(mat, 'material is listed in the hub');
    assert.equal(mat.pictures_read_with_ocr, true, 'hub list data carries the OCR-read marker');

    const doc = await client.get(`/api/hubs/${hubId}/materials/${up.data.material.id}/text`);
    assert.equal(doc.res.status, 200);
    assert.match(doc.data.text || '', /Family Skate/, 'stored material text includes the OCR text');

    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(page.includes('pictures_read_with_ocr'), 'page renders from the OCR marker');
    assert.ok(page.includes('read with OCR'), 'page shows the read-with-OCR label');
  });

  await t.test('dense-text PDF never invokes the vision path', async () => {
    modelRequests.length = 0;
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', fileName: 'notice.pdf',
      fileBase64: buildPdf([DENSE]).toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.ok(!modelRequests.some((b) => b && hasImagePart(b)), 'no vision (image_url) call for a dense PDF');
    assert.equal(up.data.material.pictures_read_with_ocr, false);
    assert.equal(up.data.material.may_have_unread_pictures, false);
  });

  await t.test('vision failure still succeeds with the picture caution', async () => {
    failOcr = true;
    modelRequests.length = 0;
    let up;
    try {
      up = await client.post(`/api/hubs/${hubId}/materials`, {
        kind: 'pdf', fileName: 'preview-again.pdf',
        // Its own bytes: the first subtest's PDF again would now (brief 062)
        // be a duplicate of that material, not a new upload.
        fileBase64: buildPdf([DENSE + ' A second copy of the notice.', { image: true }]).toString('base64'),
      });
    } finally {
      failOcr = false;
    }
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.ok((up.data.facts || []).length >= 1, 'text-layer facts still extracted');
    assert.equal(up.data.material.pictures_read_with_ocr, false, 'no OCR marker when the vision read fails');
    assert.equal(up.data.material.may_have_unread_pictures, true, 'original picture caution stands');
    const detail = await client.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === up.data.material.id);
    assert.equal(mat.pictures_read_with_ocr, false);
    assert.equal(mat.may_have_unread_pictures, true);
  });
});
