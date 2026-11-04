const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 37100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

// Smallest PDF this app's parser (pdf-parse) accepts: one page, one line of
// text. The xref table is built with real byte offsets so pdf.js reads it
// without recovery mode.
function minimalPdf(text) {
  const stream =
    'BT /F1 18 Tf 72 720 Td (' +
    String(text).replace(/([()\\])/g, '\\$1') +
    ') Tj ET';
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
    '/Resources << /Font << /F1 5 0 R >> >> >>';
  objs[4] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(out);
  out += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

// A valid PDF padded past a target size with an unreferenced stream
// object (object 6), so pdf-parse still reads page 1's text. Used for the
// brief 051 size-cap tests: real school PDFs are multi-MB scans.
function largePdf(text, targetBytes) {
  function build(padBytes) {
    const stream =
      'BT /F1 18 Tf 72 720 Td (' +
      String(text).replace(/([()\\])/g, '\\$1') +
      ') Tj ET';
    const objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>';
    objs[4] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
    objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    objs[6] = '<< /Length ' + padBytes + ' >>\nstream\n' + 'x'.repeat(padBytes) + '\nendstream';
    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i <= 6; i++) {
      offsets[i] = Buffer.byteLength(out);
      out += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
    }
    const xref = Buffer.byteLength(out);
    out += 'xref\n0 7\n0000000000 65535 f \n';
    for (let i = 1; i <= 6; i++) {
      out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    out += 'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    return Buffer.from(out, 'latin1');
  }
  let pad = targetBytes;
  let buf = build(pad);
  for (let i = 0; i < 3 && buf.length !== targetBytes; i++) {
    pad += targetBytes - buf.length;
    buf = build(pad);
  }
  return buf;
}

function makeClient() {
  let cookie = '';
  function capture(res) {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/parentloop_session=([^;]+)/);
      if (m) cookie = 'parentloop_session=' + m[1];
    }
  }
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (cookie) opts.headers.Cookie = cookie;
    const res = await fetch(`${BASE}${urlPath}`, opts);
    capture(res);
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
    post: (p, body) =>
      req(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    get: (p) => req(p),
    // Binary download that keeps this client's session cookie.
    async getFile(p) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(`${BASE}${p}`, { headers });
      capture(res);
      const buf = Buffer.from(await res.arrayBuffer());
      return { res, buf };
    },
  };
}

async function waitForServer(client) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const probed = await client.get('/api/onboarding/status');
      if (probed.res.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

test('original PDF: retained on upload, served to hub members only', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-pdf-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const founder = makeClient();
  await waitForServer(founder);

  const PICNIC =
    'Maple Grove Elementary notice: The school picnic is on Friday, November 20, 2026. ' +
    'Please bring a water bottle. Reply forms are due Wednesday, November 18, 2026.';
  const pdfBytes = minimalPdf(PICNIC);
  let hubId = '';
  let pdfMaterialId = '';
  let pasteMaterialId = '';

  await t.test('setup: founder, hub, pasted material has no file', { timeout: 180000 }, async () => {
    const prof = await founder.post('/api/profile', {
      parent_name: 'Pdf Founder',
      parent_email: 'pdf.founder@example.com',
      children: [{ name: 'Founder Kid' }],
    });
    assert.equal(prof.res.status, 200);
    const hub = await founder.post('/api/hubs', { name: 'PDF Test Hub', kind: 'other' });
    assert.equal(hub.res.status, 200);
    hubId = hub.data.hub.id;

    const pasted = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste',
      title: 'Pasted picnic note',
      text: PICNIC,
    });
    assert.equal(pasted.res.status, 200, pasted.text.slice(0, 300));
    pasteMaterialId = pasted.data.material.id;

    const detail = await founder.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === pasteMaterialId);
    assert.ok(mat, 'pasted material is listed');
    assert.equal(mat.has_file, false, 'pasted material reports no retained file');

    const file = await founder.getFile(`/api/hubs/${hubId}/materials/${pasteMaterialId}/file`);
    assert.equal(file.res.status, 404, 'pasted material has no file to serve');
  });

  await t.test('upload-then-view round trip: the exact bytes come back as a PDF', { timeout: 180000 }, async () => {
    const up = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf',
      fileName: 'picnic-notice.pdf',
      fileBase64: pdfBytes.toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 300));
    pdfMaterialId = up.data.material.id;
    assert.ok(pdfMaterialId);

    const detail = await founder.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === pdfMaterialId);
    assert.ok(mat, 'PDF material is listed');
    assert.equal(mat.kind, 'pdf');
    assert.equal(mat.has_file, true, 'PDF material reports its retained file');

    const file = await founder.getFile(`/api/hubs/${hubId}/materials/${pdfMaterialId}/file`);
    assert.equal(file.res.status, 200);
    assert.match(file.res.headers.get('content-type') || '', /application\/pdf/);
    assert.match(file.res.headers.get('content-disposition') || '', /inline/);
    assert.deepEqual(file.buf, pdfBytes, 'served bytes are the uploaded PDF, byte for byte');
  });

  await t.test('brief 062: the PDF kept beside the paste of its text; the same PDF again is a duplicate', { timeout: 180000 }, async () => {
    assert.notEqual(pdfMaterialId, pasteMaterialId, 'a pasted copy never swallows the uploaded original');
    const again = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf',
      fileName: 'picnic-notice (1).pdf',
      fileBase64: pdfBytes.toString('base64'),
    });
    assert.equal(again.res.status, 200, again.text.slice(0, 300));
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.material.id, pdfMaterialId, 'points at the first upload');
    const detail = await founder.get(`/api/hubs/${hubId}`);
    assert.equal(detail.data.materials.filter((m) => m.kind === 'pdf').length, 1, 'one PDF material');
  });

  await t.test('another hub member can view it; a non-member cannot', async () => {
    const invite = await founder.post(`/api/hubs/${hubId}/invites`, {});
    // Brief 067: this hub lets anyone with a link join (the default asks the admin).
    assert.equal((await founder.post(`/api/hubs/${hubId}/join-settings`, { open: true })).res.status, 200);
    assert.equal(invite.res.status, 200);
    const member = makeClient();
    await member.post('/api/profile', {
      parent_name: 'Pdf Member',
      parent_email: 'pdf.member@example.com',
      children: [{ name: 'Member Kid' }],
    });
    const accepted = await member.post(`/api/join/${invite.data.token}/accept`, {});
    assert.equal(accepted.res.status, 200);
    const memberFile = await member.getFile(`/api/hubs/${hubId}/materials/${pdfMaterialId}/file`);
    assert.equal(memberFile.res.status, 200, 'hub member can fetch the PDF');
    assert.deepEqual(memberFile.buf, pdfBytes);

    const outsider = makeClient();
    await outsider.post('/api/profile', {
      parent_name: 'Pdf Outsider',
      parent_email: 'pdf.outsider@example.com',
      children: [{ name: 'Outsider Kid' }],
    });
    const denied = await outsider.getFile(`/api/hubs/${hubId}/materials/${pdfMaterialId}/file`);
    assert.equal(denied.res.status, 403, 'non-member is refused');
    assert.ok(!denied.buf.equals(pdfBytes), 'non-member never receives the bytes');

    const anon = makeClient();
    const anonDenied = await anon.getFile(`/api/hubs/${hubId}/materials/${pdfMaterialId}/file`);
    assert.equal(anonDenied.res.status, 403, 'no family session is refused');
  });

  await t.test('file route is hub-bound and 404s for unknown materials', async () => {
    const otherHub = await founder.post('/api/hubs', { name: 'PDF Other Hub', kind: 'other' });
    assert.equal(otherHub.res.status, 200);
    const wrongHub = await founder.getFile(
      `/api/hubs/${otherHub.data.hub.id}/materials/${pdfMaterialId}/file`
    );
    assert.equal(wrongHub.res.status, 404, 'material file is hub-bound');
    const missing = await founder.getFile(`/api/hubs/${hubId}/materials/no-such-material/file`);
    assert.equal(missing.res.status, 404);
    const missingHub = await founder.getFile(`/api/hubs/no-such-hub/materials/${pdfMaterialId}/file`);
    assert.equal(missingHub.res.status, 404);
  });

  await t.test('a PDF over 5 MB and under 10 MB uploads, is retained, and serves back byte-identical to a member', { timeout: 180000 }, async () => {
    // Repeat the notice so the text layer is substantial (as in a real
    // multi-page school PDF) while padding carries the file past 5 MB.
    const bigPdfBytes = largePdf(PICNIC.repeat(20), 6 * 1024 * 1024);
    assert.ok(bigPdfBytes.length > 5 * 1024 * 1024, 'fixture is over the old 5 MB cap');
    assert.ok(bigPdfBytes.length < 10 * 1024 * 1024, 'fixture is under the new 10 MB cap');
    const up = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf',
      fileName: 'big-notice.pdf',
      fileBase64: bigPdfBytes.toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 300));
    const bigMaterialId = up.data.material.id;
    assert.ok(bigMaterialId);

    const detail = await founder.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === bigMaterialId);
    assert.ok(mat, 'large PDF material is listed');
    assert.equal(mat.has_file, true, 'large PDF material reports its retained file');

    const invite = await founder.post(`/api/hubs/${hubId}/invites`, {});
    // Brief 067: this hub lets anyone with a link join (the default asks the admin).
    assert.equal((await founder.post(`/api/hubs/${hubId}/join-settings`, { open: true })).res.status, 200);
    assert.equal(invite.res.status, 200);
    const bigMember = makeClient();
    await bigMember.post('/api/profile', {
      parent_name: 'Pdf Big Member',
      parent_email: 'pdf.big.member@example.com',
      children: [{ name: 'Big Member Kid' }],
    });
    const accepted = await bigMember.post(`/api/join/${invite.data.token}/accept`, {});
    assert.equal(accepted.res.status, 200);
    const memberFile = await bigMember.getFile(`/api/hubs/${hubId}/materials/${bigMaterialId}/file`);
    assert.equal(memberFile.res.status, 200, 'hub member can fetch the large PDF');
    assert.match(memberFile.res.headers.get('content-type') || '', /application\/pdf/);
    assert.deepEqual(memberFile.buf, bigPdfBytes, 'served bytes are the uploaded large PDF, byte for byte');
  });

  await t.test('an over-limit PDF is rejected and saves nothing', { timeout: 180000 }, async () => {
    const before = await founder.get(`/api/hubs/${hubId}`);
    const countBefore = before.data.materials.length;
    const big = largePdf(PICNIC, 10 * 1024 * 1024 + 1024);
    const up = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf',
      fileName: 'too-big.pdf',
      fileBase64: big.toString('base64'),
    });
    assert.notEqual(up.res.status, 200);
    assert.match(up.text, /too large/i);
    assert.match(up.text, /limit is 10 MB/);
    const after = await founder.get(`/api/hubs/${hubId}`);
    assert.equal(after.data.materials.length, countBefore, 'oversize upload created no material');
  });

  await t.test('hub page offers the original-PDF action only for retained files', async () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(page.includes('View original PDF'), 'button label exists');
    assert.ok(page.includes('has_file'), 'button is gated on the retained-file flag');

    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    const hubs = await demo.get('/api/hubs');
    assert.ok(hubs.data.hubs.length > 0);
    for (const h of hubs.data.hubs) {
      const detail = await demo.get(`/api/hubs/${h.id}`);
      for (const m of detail.data.materials || []) {
        assert.equal(m.has_file, false, 'demo (text-seeded) materials never claim a file');
      }
    }
  });
});
