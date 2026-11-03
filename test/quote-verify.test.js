// Quote-verified facts: a fact from a parent-added material is kept only
// when its quote (source_text) is found, by server code, in the material's
// own text — pasted text, a PDF's text layer plus OCR reads, or an image's
// transcript from the same read. Dropped items go to an audit log and the
// material's unverified count; an all-dropped material still saves.
// Fictional fixtures only; a stub model answers per scenario.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39500 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fact(id, title, quote, date) {
  return {
    id, type: 'event', title, detail: title + '.', date: date || '2026-11-20', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'notice', source_text: quote,
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  };
}

// Two-page PDF: a dense text page, then a picture-only page (flagged for
// the OCR read). Pixel content is irrelevant to the stubbed OCR.
function pdfWithPicturePage(text) {
  const imgRaw = zlib.deflateSync(Buffer.alloc(8 * 4 * 3, 200));
  const stream1 = 'BT /F1 10 Tf 40 720 Td (' + text.replace(/([()\\])/g, '\\$1') + ') Tj ET';
  const stream2 = 'q 400 0 0 300 72 400 cm /Im1 Do Q';
  const objs = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Length ' + Buffer.byteLength(stream1) + ' >>\nstream\n' + stream1 + '\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>',
    '<< /Length ' + Buffer.byteLength(stream2) + ' >>\nstream\n' + stream2 + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    null,
  ];
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    if (i === 8) {
      out = Buffer.concat([out,
        Buffer.from('8 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + imgRaw.length + ' >>\nstream\n', 'latin1'),
        imgRaw, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      out = Buffer.concat([out, Buffer.from(i + ' 0 obj\n' + objs[i] + '\nendobj\n', 'latin1')]);
    }
  }
  const xref = out.length;
  let tail = 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (let i = 1; i < objs.length; i++) tail += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
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

test('extracted facts must prove their quote against the source', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-quoteverify-'));
  const dbPath = path.join(tmpDir, 'app.db');
  // Per-scenario stub: `reply` builds the extraction answer; OCR page reads
  // return `ocrText`.
  let reply = () => '[]';
  let ocrText = '';
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      const system = String(((body && body.messages) || [])[0] && body.messages[0].content || '');
      const content = /reading a picture of a school document page/.test(system) ? ocrText : reply(system);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath,
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const client = makeClient();
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await client.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const prof = await client.post('/api/profile', {
    parent_name: 'Quote Founder', parent_email: 'quote.founder@example.com', children: [{ name: 'Quote Kid' }],
  });
  assert.equal(prof.res.status, 200);
  const hub = await client.post('/api/hubs', { name: 'Quote Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;
  const hubDetail = async () => (await client.get(`/api/hubs/${hubId}`)).data;
  const rejectionsFor = async (materialId) => {
    const SQL = await require('sql.js')();
    const fileDb = new SQL.Database(fs.readFileSync(dbPath));
    const res = fileDb.exec('SELECT fact_title, quote, reason FROM fact_rejections WHERE material_id = ? ORDER BY fact_title', [materialId]);
    fileDb.close();
    return res.length ? res[0].values.map(([title, quote, reason]) => ({ title, quote, reason })) : [];
  };

  await t.test('pasted text: exact and normalized quotes verify; paraphrased and too-short ones are dropped and logged', async () => {
    const text = 'Maple Grove Elementary notice: The “Fall Fun Fair” is on Friday, November 20, 2026 — bring a water bottle. ' +
      'Reply forms are due Wednesday, November 18, 2026. The library is closed for inventory all week.';
    reply = () => JSON.stringify([
      fact('qv-forms', 'Reply forms due', 'Reply forms are due Wednesday, November 18, 2026.', '2026-11-18'),
      fact('qv-fair', 'Fall Fun Fair', '  the "fall fun fair" is on FRIDAY,\n   november 20, 2026 - bring a water bottle.'),
      fact('qv-para', 'Library closed', 'The library will be shut for the week.', ''),
      fact('qv-short', 'Fair day', 'Friday', ''),
    ]);
    const up = await client.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    const keptIds = (up.data.facts || []).map((f) => f.id).sort();
    assert.deepEqual(keptIds, ['qv-fair', 'qv-forms'], 'exact quote and case/space/smart-quote variant verify');
    assert.equal(up.data.material.unverified_count, 2, 'two items left out');
    const detail = await hubDetail();
    const stored = detail.facts.filter((f) => f.material_id === up.data.material.id);
    assert.ok(stored.length === 2 && stored.every((f) => f.quote_verified && f.source_text), 'stored with their quotes, marked verified');
    const mat = detail.materials.find((m) => m.id === up.data.material.id);
    assert.equal(mat.unverified_count, 2, 'hub list carries the count for the caution');
    const log = await rejectionsFor(up.data.material.id);
    assert.deepEqual(log.map((r) => [r.title, r.reason]), [
      ['Fair day', 'quote too short to verify'],
      ['Library closed', 'quote not found in the original'],
    ], 'audit log keeps each dropped item with its quote and reason');
    assert.equal(log.find((r) => r.title === 'Library closed').quote, 'The library will be shut for the week.');
  });

  await t.test('every quote fails: the material still saves with zero notes and the caution count', async () => {
    reply = () => JSON.stringify([
      fact('qv-af-1', 'Photo day', 'Photo day happens on the twelfth.', '2026-11-12'),
      fact('qv-af-2', 'Uniforms', 'Kids should look sharp.', ''),
    ]);
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', text: 'Cedar Valley notice: Photo day is Thursday, November 12, 2026, in the gym for all students. Uniforms please.',
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts_added, 0);
    assert.equal(up.data.material.unverified_count, 2);
    const detail = await hubDetail();
    const mat = detail.materials.find((m) => m.id === up.data.material.id);
    assert.ok(mat, 'material saved');
    assert.equal(mat.status, 'extracted', 'not an error, not failed');
    assert.equal(detail.facts.filter((f) => f.material_id === up.data.material.id).length, 0, 'zero notes');
    assert.equal((await rejectionsFor(up.data.material.id)).length, 2);
  });

  await t.test('picture-page PDF: a quote verifies against the OCR transcript', async () => {
    ocrText = 'Holiday Family Skate: Bring the whole family for a holiday skate on Saturday, December 19, 2026 at Maple Grove Arena.';
    reply = () => JSON.stringify([
      fact('qv-skate', 'Holiday Family Skate', 'Bring the whole family for a holiday skate on Saturday, December 19, 2026', '2026-12-19'),
      fact('qv-picnic', 'School picnic', 'The school picnic is on Friday, November 20, 2026.'),
      fact('qv-invented', 'Skating party', 'Skating party in January for Grade 4.', ''),
    ]);
    const pdf = pdfWithPicturePage('Maple Grove Elementary notice: The school picnic is on Friday, November 20, 2026. Please bring a water bottle and a packed lunch.');
    const up = await client.post(`/api/hubs/${hubId}/materials`, {
      kind: 'pdf', fileName: 'picture-notice.pdf', fileBase64: pdf.toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.material.pictures_read_with_ocr, true, 'the picture page went through the OCR read');
    const kept = (up.data.facts || []).map((f) => f.id).sort();
    assert.deepEqual(kept, ['qv-picnic', 'qv-skate'], 'OCR-page quote and text-layer quote both verify');
    assert.equal(up.data.material.unverified_count, 1, 'the invented item is left out');
  });

  await t.test('image: quotes verify against the read transcript, which the material keeps', async () => {
    const transcript = 'Photo Day: Thursday, November 12, 2026. Wear your school uniform. Order forms are due Monday.';
    reply = (system) => {
      assert.ok(/source_transcript/.test(system), 'an image read is asked for its transcript');
      return JSON.stringify({
        material_title: 'Photo Day notice',
        source_transcript: transcript,
        facts: [
          fact('qv-photo', 'Photo Day', 'Photo Day: Thursday, November 12, 2026.', '2026-11-12'),
          fact('qv-guess', 'Retake day', 'Retakes are on November 30.', '2026-11-30'),
        ],
      });
    };
    const up = await client.post(`/api/hubs/${hubId}/materials`, { kind: 'image', imageBase64: PNG_1X1, fileName: 'photo-day.png' });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.deepEqual((up.data.facts || []).map((f) => f.id), ['qv-photo']);
    assert.equal(up.data.material.unverified_count, 1);
    const doc = await client.get(`/api/hubs/${hubId}/materials/${up.data.material.id}/text`);
    assert.equal(doc.res.status, 200);
    assert.ok((doc.data.text || '').includes('Wear your school uniform.'), 'the image\'s read text is retained with the material');
  });

  await t.test('existing and demo facts are untouched: no verification flag added to them', async () => {
    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    const hubs = (await demo.get('/api/hubs')).data.hubs || [];
    const demoHub = await demo.get(`/api/hubs/${hubs[0].id}`);
    assert.ok(demoHub.data.facts.length > 20, 'demo facts present');
    assert.ok(demoHub.data.facts.every((f) => f.quote_verified === false), 'seeded facts are not retro-verified');
    assert.ok(demoHub.data.materials.every((m) => m.unverified_count === 0), 'no caution on seeded materials');
  });

  await t.test('page shows a verified note\'s quote under it and the left-out caution with its count', () => {
    assert.ok(PAGE.includes('function noteQuoteLines(f)') && PAGE.includes("if (!(f && f.quote_verified)) return '';"),
      'only verified notes carry the inline quote');
    assert.ok(PAGE.includes('<span class="note-quote"><span class="quote">“'), 'quote renders as a small muted line');
    assert.ok(PAGE.includes('.note-quote { display: block;'), 'quote line sits under the note');
    assert.ok(PAGE.includes('be verified against the original and were left out (') &&
      PAGE.includes('esc(String(m.unverified_count))') && PAGE.includes('if (m.unverified_count > 0)'),
      'caution names the count');
    assert.ok(PAGE.includes('!f.quote_verified && String((f && f.source_text)'), 'older notes keep the Show sources toggle');
  });
});
