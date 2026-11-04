// Brief 044: paste/pick an image into Add material. The image is read by
// the same extraction pipeline (vision), retained with its material, and
// served back to hub members only. Text + image form ONE material.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 37900 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);
const NOTICE_TEXT =
  'Maple Grove Elementary notice: The school picnic is on Friday, November 20, 2026. ' +
  'Please bring a water bottle. Reply forms are due Wednesday, November 18, 2026.';
const GOOD_FACTS = JSON.stringify([
  {
    id: 'img-picnic-1', type: 'event', title: 'School picnic',
    detail: 'School picnic.', date: '2026-11-20', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'notice', source_text: 'The school picnic is on Friday, November 20, 2026.',
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  },
]);

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
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  }
  return {
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    get: (p) => req(p),
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
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

test('image material: vision extraction, retention, member-only view', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-img-'));
  const modelRequests = [];
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      modelRequests.push(body);
      // Quote verification: an image read also returns its transcript (the
      // pictured notice), and the facts' quotes are checked against it.
      const system = String(((body && body.messages) || [])[0] && body.messages[0].content || '');
      const content = /source_transcript/.test(system)
        ? JSON.stringify({ material_title: 'School picnic notice', source_transcript: NOTICE_TEXT, facts: JSON.parse(GOOD_FACTS) })
        : GOOD_FACTS;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
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

  const founder = makeClient();
  await waitForServer(founder);
  let hubId = '';
  let imageMaterialId = '';

  await t.test('setup: founder and hub', async () => {
    const prof = await founder.post('/api/profile', {
      parent_name: 'Image Founder', parent_email: 'image.founder@example.com',
      children: [{ name: 'Founder Kid' }],
    });
    assert.equal(prof.res.status, 200);
    const hub = await founder.post('/api/hubs', { name: 'Image Test Hub', kind: 'other' });
    assert.equal(hub.res.status, 200);
    hubId = hub.data.hub.id;
  });

  await t.test('image alone: stored, vision-read, facts extracted', async () => {
    modelRequests.length = 0;
    const up = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image',
      fileName: 'picnic-screenshot.png',
      mimeType: 'image/png',
      imageBase64: PNG_BYTES.toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    imageMaterialId = up.data.material.id;
    assert.ok(imageMaterialId);
    assert.equal(up.data.material.kind, 'image');
    assert.equal(up.data.material.has_file, true);
    assert.ok(up.data.facts_added >= 1, 'vision extraction produced facts');
    // The model request must carry the image as a vision (image_url) part.
    assert.equal(modelRequests.length >= 1, true);
    const body = modelRequests[modelRequests.length - 1];
    const userContent = body.messages.find((m) => m.role === 'user').content;
    const parts = Array.isArray(userContent) ? userContent : [];
    const imagePart = parts.find((p) => p && p.type === 'image_url');
    assert.ok(imagePart, 'model request carries an image_url part');
    assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);

    const detail = await founder.get(`/api/hubs/${hubId}`);
    const mat = detail.data.materials.find((m) => m.id === imageMaterialId);
    assert.ok(mat, 'image material is listed');
    assert.equal(mat.kind, 'image');
    assert.equal(mat.has_file, true);

    const file = await founder.getFile(`/api/hubs/${hubId}/materials/${imageMaterialId}/file`);
    assert.equal(file.res.status, 200);
    assert.match(file.res.headers.get('content-type') || '', /image\/png/);
    assert.deepEqual(file.buf, PNG_BYTES, 'served bytes are the uploaded image, byte for byte');
  });

  await t.test('text + image together form ONE material covering both', async () => {
    const before = await founder.get(`/api/hubs/${hubId}`);
    const countBefore = before.data.materials.length;
    modelRequests.length = 0;
    const up = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image',
      text: NOTICE_TEXT,
      fileName: 'notice-photo.png',
      mimeType: 'image/png',
      imageBase64: PNG_BYTES.toString('base64'),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    const after = await founder.get(`/api/hubs/${hubId}`);
    assert.equal(after.data.materials.length, countBefore + 1, 'exactly one new material');
    const mat = after.data.materials.find((m) => m.id === up.data.material.id);
    assert.equal(mat.kind, 'image');
    assert.equal(mat.has_file, true);
    const doc = await founder.get(`/api/hubs/${hubId}/materials/${up.data.material.id}/text`);
    assert.equal(doc.res.status, 200);
    assert.match(doc.data.text || '', /school picnic/i, 'accompanying text is kept with the material');
    const body = modelRequests[modelRequests.length - 1];
    const userContent = body.messages.find((m) => m.role === 'user').content;
    const textPart = (Array.isArray(userContent) ? userContent : []).find((p) => p && p.type === 'text');
    assert.ok(textPart && /school picnic/i.test(textPart.text), 'vision request also carries the pasted text');
  });

  await t.test('another hub member can view it; a non-member cannot', async () => {
    const invite = await founder.post(`/api/hubs/${hubId}/invites`, {});
    // Brief 067: this hub lets anyone with a link join (the default asks the admin).
    assert.equal((await founder.post(`/api/hubs/${hubId}/join-settings`, { open: true })).res.status, 200);
    assert.equal(invite.res.status, 200);
    const member = makeClient();
    await member.post('/api/profile', {
      parent_name: 'Image Member', parent_email: 'image.member@example.com',
      children: [{ name: 'Member Kid' }],
    });
    const accepted = await member.post(`/api/join/${invite.data.token}/accept`, {});
    assert.equal(accepted.res.status, 200);
    const memberFile = await member.getFile(`/api/hubs/${hubId}/materials/${imageMaterialId}/file`);
    assert.equal(memberFile.res.status, 200, 'hub member can fetch the image');
    assert.deepEqual(memberFile.buf, PNG_BYTES);

    const outsider = makeClient();
    await outsider.post('/api/profile', {
      parent_name: 'Image Outsider', parent_email: 'image.outsider@example.com',
      children: [{ name: 'Outsider Kid' }],
    });
    const denied = await outsider.getFile(`/api/hubs/${hubId}/materials/${imageMaterialId}/file`);
    assert.equal(denied.res.status, 403, 'non-member is refused');
    assert.ok(!denied.buf.equals(PNG_BYTES), 'non-member never receives the bytes');

    const anon = makeClient();
    const anonDenied = await anon.getFile(`/api/hubs/${hubId}/materials/${imageMaterialId}/file`);
    assert.equal(anonDenied.res.status, 403, 'no family session is refused');

    const otherHub = await founder.post('/api/hubs', { name: 'Image Other Hub', kind: 'other' });
    const wrongHub = await founder.getFile(`/api/hubs/${otherHub.data.hub.id}/materials/${imageMaterialId}/file`);
    assert.equal(wrongHub.res.status, 404, 'material file is hub-bound');
  });

  await t.test('bad type and oversize images are rejected and save nothing', async () => {
    const before = await founder.get(`/api/hubs/${hubId}`);
    const countBefore = before.data.materials.length;

    const notImage = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image', fileName: 'notes.png', mimeType: 'image/png',
      imageBase64: Buffer.from('this is plain text, not an image').toString('base64'),
    });
    assert.notEqual(notImage.res.status, 200, notImage.text.slice(0, 300));
    assert.match(notImage.text, /image/i);

    const gif = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image', fileName: 'anim.gif', mimeType: 'image/gif',
      imageBase64: Buffer.from('GIF89a').toString('base64'),
    });
    assert.notEqual(gif.res.status, 200, 'gif is not an accepted image type');

    const big = await founder.post(`/api/hubs/${hubId}/materials`, {
      kind: 'image', fileName: 'huge.png', mimeType: 'image/png',
      imageBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 0x89).toString('base64'),
    });
    assert.notEqual(big.res.status, 200);
    assert.match(big.text, /too large/i);

    const after = await founder.get(`/api/hubs/${hubId}`);
    assert.equal(after.data.materials.length, countBefore, 'rejected uploads created no material');
  });

  await t.test('paste handler, picker and source view offer image support', async () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(page, /addEventListener\('paste'/, 'add-material box listens for paste');
    assert.ok(page.includes('clipboardData'), 'paste handler reads the clipboard');
    assert.ok(page.includes('materialImageChip'), 'attached-image preview chip exists');
    assert.ok(page.includes('materialImageRemove'), 'preview chip has a remove affordance');
    assert.match(page, /accept="[^"]*image\/png/, 'file picker also accepts images');
    assert.ok(page.includes('View original image'), 'source view can open the retained image');
  });
});
