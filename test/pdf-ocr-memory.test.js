// Brief 051d: picture-dense PDFs must not kill the server. Three 4200x3000
// FlateDecode RGB pages (flat fills: tiny on disk, ~38 MB decoded each)
// plus one DCTDecode (JPEG) page go through the OCR pass one page at a
// time, downscaled to <=2000 px on the long edge. Asserts: upload 200,
// material listed with has_file, every OCR PNG's IHDR within bounds,
// child server alive afterwards, and (Linux only) child peak RSS under
// the old 512 MiB limit. A vision-500 subtest proves graceful failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39200 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;

const OCR_TEXT =
  'Holiday Family Skate: Bring the whole family for a holiday skate on Saturday, December 19, 2026 at Maple Grove Arena.';
const BIG_FACTS = JSON.stringify([
  {
    id: 'big-1', type: 'event', title: 'Holiday Family Skate',
    detail: 'Holiday family skate at Maple Grove Arena.', date: '2026-12-19', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'preview', source_text: OCR_TEXT,
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  },
]);

// Minimal valid baseline JPEG: 16x16 flat mid-gray, 1 component.
// Custom minimal Huffman tables (decoder reads them from the file):
// DC table holds one length-1 code for category 0; AC table holds one
// length-3 code for EOB. Flat gray 128 quantizes DC to 0, so every 8x8
// block is code(0) + EOB and the scan is all zero bits.
function buildFlatGrayJpeg(size) {
  const bytes = [];
  const push = (...bs) => { for (const b of bs) bytes.push(b & 0xff); };
  const seg = (marker, payload) => {
    push(0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff);
    push(...payload);
  };
  push(0xff, 0xd8); // SOI
  seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]); // APP0 JFIF
  seg(0xdb, [0x00, ...new Array(64).fill(16)]); // DQT, Tq=0
  seg(0xc0, [0x08, (size >> 8) & 0xff, size & 0xff, (size >> 8) & 0xff, size & 0xff, 0x01, 0x01, 0x11, 0x00]); // SOF0
  seg(0xc4, [0x00, 0x01, ...new Array(15).fill(0), 0x00]); // DHT DC: one 1-bit code, symbol 0
  seg(0xc4, [0x10, 0x00, 0x00, 0x01, ...new Array(13).fill(0), 0x00]); // DHT AC: one 3-bit code, EOB
  seg(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]); // SOS
  const blocks = (size / 8) * (size / 8);
  const totalBits = blocks * 4; // 1-bit DC + 3-bit EOB per block, all zero
  const dataBytes = Math.ceil(totalBits / 8);
  const scan = Buffer.alloc(dataBytes, 0x00);
  const extra = dataBytes * 8 - totalBits;
  if (extra > 0) scan[dataBytes - 1] = (1 << extra) - 1; // pad with 1s
  push(...scan);
  push(0xff, 0xd9); // EOI
  return Buffer.from(bytes);
}

// 4200x3000 RGB stripes: alternating light-gray rows compress to KBs on
// disk but decode to ~38 MB per page. Fixture stays small; memory does not.
function buildBigFlate() {
  const w = 4200;
  const h = 3000;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = y % 2 ? 180 : 200;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = v; raw[o + 1] = v; raw[o + 2] = v;
    }
  }
  return { w, h, comp: zlib.deflateSync(raw) };
}

const COVER_TEXT = 'Maple Grove Elementary notice: the winter concert is on Thursday, December 10, 2026.';

function buildBigPdf(bigComp, jpeg) {
  const objs = [];
  const pageCount = 5;
  const pageIds = [3, 5, 7, 9, 13];
  const imageBase = 15;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageCount + ' >>';
  const fontId = imageBase + 4;
  const kinds = ['big', 'big', 'big', 'jpeg', 'text'];
  pageIds.forEach((pageId, i) => {
    const contentId = pageId + 1;
    const imgId = imageBase + i;
    const kind = kinds[i];
    if (kind === 'text') {
      const stream = 'BT /F1 12 Tf 72 720 Td (' + COVER_TEXT.replace(/([()\\])/g, '\\$1') + ') Tj ET';
      objs[pageId] =
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentId +
        ' 0 R /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> >>';
      objs[contentId] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
      return;
    }
    const isJpeg = kind === 'jpeg';
    const w = isJpeg ? 16 : 4200;
    const h = isJpeg ? 16 : 3000;
    const stream = 'q ' + w + ' 0 0 ' + h + ' 72 400 cm /Im' + i + ' Do Q';
    objs[pageId] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentId +
      ' 0 R /Resources << /XObject << /Im' + i + ' ' + imgId + ' 0 R >> >> >>';
    objs[contentId] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
    objs[imgId] = isJpeg
      ? { jpeg: true, dict: '<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>' }
      : { jpeg: false, dict: '<< /Type /XObject /Subtype /Image /Width 4200 /Height 3000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + bigComp.length + ' >>' };
  });
  objs[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    if (objs[i] === undefined) continue;
    offsets[i] = out.length;
    if (objs[i] && typeof objs[i] === 'object') {
      out = Buffer.concat([
        out,
        Buffer.from(i + ' 0 obj\n' + objs[i].dict + '\nstream\n', 'latin1'),
        objs[i].jpeg ? jpeg : bigComp,
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

function isOcrRequest(body) {
  const system = String(((body.messages || [])[0] || {}).content || '');
  return /transcrib/i.test(system);
}

function ocrPngSizes(bodies) {
  return bodies.filter((b) => b && isOcrRequest(b)).map((b) => {
    const user = (b.messages || []).find((m) => m.role === 'user');
    const part = ((user && user.content) || []).find((p) => p && p.type === 'image_url');
    const url = part && part.image_url && part.image_url.url;
    const m = String(url || '').match(/^data:image\/png;base64,(.+)$/);
    assert.ok(m, 'OCR request carries a PNG data URL');
    const png = Buffer.from(m[1], 'base64');
    assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'valid PNG signature');
    return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
  });
}

function childPeakKb(child) {
  if (process.platform !== 'linux') return null;
  const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
  const m = status.match(/VmHWM:\s+(\d+)\s+kB/);
  return m ? Number(m[1]) : null;
}

test('pdf ocr memory: large picture pages downscale, survive, and degrade', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-pdfmem-'));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: BIG_FACTS }, finish_reason: 'stop' }] }));
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
    parent_name: 'Big File Founder', parent_email: 'bigfile.founder@example.com',
    children: [{ name: 'Big File Kid' }],
  });
  assert.equal(prof.res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Big File Hub', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;

  const big = buildBigFlate();
  const jpeg = buildFlatGrayJpeg(16);
  const pdfBase64 = buildBigPdf(big.comp, jpeg).toString('base64');

  await t.test('4200px pages upload 200, downscale, and stay under memory', async () => {
    modelRequests.length = 0;
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', title: 'Big picture newsletter', fileName: 'big-preview.pdf',
      fileBase64: pdfBase64,
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.material.has_file, true, 'material retained the file');
    const sizes = ocrPngSizes(modelRequests);
    assert.equal(sizes.length, 4, 'all four picture pages (3 Flate + 1 JPEG) were read');
    for (const s of sizes) {
      assert.ok(Math.max(s.w, s.h) <= 2000, `PNG IHDR within bounds, got ${s.w}x${s.h}`);
    }
    assert.deepEqual(
      sizes.filter((s) => Math.max(s.w, s.h) === 2000).length, 3,
      'the three large pages were downscaled to the 2000px bound'
    );
    const alive = await client.get('/api/onboarding/status');
    assert.equal(alive.res.status, 200, 'child server answers a follow-up GET');
    const peakKb = childPeakKb(child);
    if (peakKb !== null) {
      assert.ok(peakKb < 450 * 1024, `child peak RSS under the old 512 MiB limit, got ${(peakKb / 1024).toFixed(0)} MiB`);
    }
  });

  await t.test('vision failure still saves the material with the caution', async () => {
    failOcr = true;
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', title: 'Big picture newsletter again', fileName: 'big-preview-2.pdf',
      fileBase64: pdfBase64,
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.material.has_file, true, 'material saved despite vision errors');
    assert.equal(up.data.material.may_have_unread_pictures, true, 'picture caution stays in place');
  });
});
