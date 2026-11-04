// Brief 050: remove a single material from a hub.
//
// Fictional fixtures only (Cedar Valley). Nothing here comes from a real
// school newsletter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');

// Part A: store layer — deleting a material takes its facts and its
// retained file with it, and leaves sibling materials alone.
test('deleteMaterial removes the material, its facts, and its retained file', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-matremove-db-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  const db = require('../db');
  await db.initDb();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const profile = db.createProfile({ parent_name: 'Remove Rita', children: [{ name: 'Rita Kid' }] });
  const hub = db.createHub(profile.id, 'Cedar Valley Elementary — Cedar Valley', 'school', {
    school_name: 'Cedar Valley Elementary', city: 'Cedar Valley', province: 'Ontario', country: 'Canada',
  });
  const keep = db.createMaterial(hub.id, profile.id, 'paste', 'Keep me (mock)', 'keep text', 'stored');
  const drop = db.createMaterial(
    hub.id, profile.id, 'pdf', 'Drop me (mock)', 'drop text', 'stored',
    undefined, undefined, { data: Buffer.from('%PDF-fake'), name: 'drop.pdf', mime: 'application/pdf' }
  );
  const fact = (id, title) => ({
    id, type: 'event', title, detail: title, date: '2026-11-20', time: '',
    applies_to: 'all students', action_required: false, action: '', link: '',
    source_document: 'mock', source_text: 'quote ' + id, published_at: '',
    extracted_at: '', confidence: 1, supersedes: '', scope: 'school', scope_value: '',
    group_label: 'G', group_summary: '',
  });
  db.insertFacts(hub.id, keep.id, [fact('mr-keep', 'Keep fact')], false);
  db.insertFacts(hub.id, drop.id, [fact('mr-drop', 'Drop fact')], false);
  assert.ok(db.getMaterialFile(drop.id, profile.id), 'retained file present before removal');

  assert.equal(db.deleteMaterial(drop.id), true);
  assert.equal(db.getMaterial(drop.id), null, 'material row gone');
  assert.equal(db.getMaterialFile(drop.id, profile.id), null, 'retained file gone with the row');
  assert.deepEqual(db.listFacts(hub.id).map((f) => f.id), ['mr-keep'], 'only the dropped facts went');
  assert.deepEqual(db.listMaterials(hub.id).map((m) => m.id), [keep.id], 'sibling material stays');
  assert.equal(db.deleteMaterial(drop.id), false, 'second delete is a no-op');
  assert.equal(db.deleteMaterial('no-such-material'), false);
});

// Part B: API + UI contract.
const PORT = 37100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
let tmpDir = null;
let fakeModel = null;
let extractCount = 0;

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
    del: (p) => req(p, { method: 'DELETE' }),
    patch: (p, body) => req(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
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

test('material removal API: permissions, demo protection, evening check', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-matremove-api-'));
  const dbPath = path.join(tmpDir, 'app.db');

  fakeModel = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let content;
      if (raw.includes('relevant_facts, nudges')) {
        // Evening check: keep every fact the server sent.
        let facts = [];
        try {
          const body = JSON.parse(raw);
          const user = body.messages.map((m) => m.content || '').join('\n');
          facts = JSON.parse(user.split('School Agent facts:\n')[1] || '[]');
        } catch { facts = []; }
        content = JSON.stringify({
          relevant_facts: facts.map((f) => ({ id: f.id })),
          nudges: [], calendar_hold: null, filtered_out_count: 0,
          filtering_summary: 'Everything here applies to your family.',
        });
      } else {
        extractCount += 1;
        // Quote verification: like a well-behaved model, quote the
        // material's own first sentence so the server can verify it.
        let quote = 'Stub notice text ' + extractCount + '.';
        try {
          const body = JSON.parse(raw);
          const user = body.messages.find((m) => m.role === 'user');
          const text = String((user && user.content) || '').split('Newsletter text:\n\n')[1] || '';
          if (text) quote = text.split(/(?<=\.)\s/)[0];
        } catch { /* keep the fallback */ }
        content = JSON.stringify([{
          id: 'mr-stub-' + extractCount, type: 'event', title: 'Stub notice ' + extractCount,
          detail: 'A fictional notice.', date: '2026-11-20', time: '',
          applies_to: 'all students', action_required: false, action: '', link: '',
          source_document: 'stub', source_text: quote,
          published_at: '', extracted_at: '', confidence: 1, supersedes: '',
          group_label: 'Notices', group_summary: '',
        }]);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath,
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (fakeModel) fakeModel.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const founder = makeClient();
  await waitForServer(founder);

  const memberA = makeClient();
  const memberB = makeClient();
  const outsider = makeClient();
  let hubId = '';
  let mat1 = null;
  let mat1FactIds = [];
  let mat2 = null;

  await t.test('setup: founder hub, two members join, member A adds a material', async () => {
    const prof = await founder.post('/api/profile', {
      parent_name: 'Founder Fran', parent_email: 'fran@example.com', children: [{ name: 'Fran Kid' }],
    });
    assert.equal(prof.res.status, 200);
    const made = await founder.post('/api/hubs', {
      school_name: 'Cedar Valley Elementary', city: 'Cedar Valley', province: 'Ontario', country: 'Canada', kind: 'school',
    });
    assert.equal(made.res.status, 200);
    hubId = made.data.hub.id;

    for (const [client, name, email] of [
      [memberA, 'Uploader Uma', 'uma@example.com'],
      [memberB, 'Member Mel', 'mel@example.com'],
    ]) {
      const p = await client.post('/api/profile', { parent_name: name, parent_email: email, children: [{ name: name + ' Kid' }] });
      assert.equal(p.res.status, 200);
      const invite = await founder.post(`/api/hubs/${hubId}/invites`, {});
      // Brief 067: this hub lets anyone with a link join (the default asks the admin).
      assert.equal((await founder.post(`/api/hubs/${hubId}/join-settings`, { open: true })).res.status, 200);
      assert.equal(invite.res.status, 200);
      const joined = await client.post(`/api/join/${invite.data.token}/accept`, {});
      assert.equal(joined.res.status, 200);
    }
    await outsider.post('/api/profile', {
      parent_name: 'Outsider Ola', parent_email: 'ola@example.com', children: [{ name: 'Ola Kid' }],
    });

    const added = await memberA.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', title: 'Cedar Valley corrected newsletter (mock)',
      text: 'Cedar Valley notice: the corrected newsletter supersedes the earlier one. Stub notice text.',
    });
    assert.equal(added.res.status, 200, added.text.slice(0, 300));
    mat1 = added.data.material;
    assert.ok(mat1 && mat1.id);
    mat1FactIds = (added.data.facts || []).map((f) => f.id);
    assert.ok(mat1FactIds.length > 0, 'stubbed facts saved against the material');

    const detailA = await memberA.get(`/api/hubs/${hubId}`);
    assert.ok(detailA.data.materials.some((m) => m.id === mat1.id));
    assert.ok(detailA.data.facts.some((f) => f.material_id === mat1.id), 'material facts listed');
    assert.equal(detailA.data.materials.find((m) => m.id === mat1.id).can_remove, true, 'uploader may remove');
    const detailFounder = await founder.get(`/api/hubs/${hubId}`);
    assert.equal(detailFounder.data.materials.find((m) => m.id === mat1.id).can_remove, true, 'hub admin may remove');
    const detailB = await memberB.get(`/api/hubs/${hubId}`);
    assert.equal(detailB.data.materials.find((m) => m.id === mat1.id).can_remove, false, 'ordinary member may not remove another’s');
  });

  await t.test('ordinary member cannot remove another member’s material', async () => {
    const denied = await memberB.del(`/api/hubs/${hubId}/materials/${mat1.id}`);
    assert.equal(denied.res.status, 403);
    const detail = await founder.get(`/api/hubs/${hubId}`);
    assert.ok(detail.data.materials.some((m) => m.id === mat1.id), 'material intact after refusal');
    assert.ok(detail.data.facts.some((f) => f.material_id === mat1.id), 'facts intact after refusal');
  });

  await t.test('non-member is refused without leaking material existence', async () => {
    const existing = await outsider.del(`/api/hubs/${hubId}/materials/${mat1.id}`);
    assert.equal(existing.res.status, 403);
    assert.equal(existing.data.error, 'Only members can read this hub.');
    const missing = await outsider.del(`/api/hubs/${hubId}/materials/no-such-material`);
    assert.equal(missing.res.status, 403, 'same refusal for a material that does not exist');
    assert.equal(missing.data.error, existing.data.error, 'no existence leak in the refusal');
    const detail = await founder.get(`/api/hubs/${hubId}`);
    assert.ok(detail.data.materials.some((m) => m.id === mat1.id), 'material intact');
  });

  await t.test('member removing a missing or foreign-hub material gets 404', async () => {
    const missing = await memberA.del(`/api/hubs/${hubId}/materials/no-such-material`);
    assert.equal(missing.res.status, 404);
    assert.equal(missing.data.error, 'That material is not available.');
    const noHub = await memberA.del(`/api/hubs/no-such-hub/materials/${mat1.id}`);
    assert.equal(noHub.res.status, 404);
  });

  // Rename (the material card's ⋯ menu): the same people who may remove.
  await t.test('rename: uploader and admin may, an ordinary member may not; notes follow the new name', async () => {
    const detailA = await memberA.get(`/api/hubs/${hubId}`);
    assert.equal(detailA.data.materials.find((m) => m.id === mat1.id).can_rename, true, 'uploader may rename');
    const detailB = await memberB.get(`/api/hubs/${hubId}`);
    assert.equal(detailB.data.materials.find((m) => m.id === mat1.id).can_rename, false, 'ordinary member may not');
    const stampedBefore = detailA.data.facts.filter((f) => f.material_id === mat1.id && f.group_label === mat1.title).length;

    const denied = await memberB.patch(`/api/hubs/${hubId}/materials/${mat1.id}`, { title: 'Not yours' });
    assert.equal(denied.res.status, 403);
    const outside = await outsider.patch(`/api/hubs/${hubId}/materials/${mat1.id}`, { title: 'Nope' });
    assert.equal(outside.res.status, 403);
    const blank = await memberA.patch(`/api/hubs/${hubId}/materials/${mat1.id}`, { title: '   ' });
    assert.equal(blank.res.status, 400);
    const long = await memberA.patch(`/api/hubs/${hubId}/materials/${mat1.id}`, { title: 'x'.repeat(121) });
    assert.equal(long.res.status, 400);
    const missing = await memberA.patch(`/api/hubs/${hubId}/materials/no-such-material`, { title: 'Ghost' });
    assert.equal(missing.res.status, 404);

    const renamed = await memberA.patch(`/api/hubs/${hubId}/materials/${mat1.id}`, { title: '  Cedar Valley — corrected   newsletter ' });
    assert.equal(renamed.res.status, 200, renamed.text.slice(0, 300));
    assert.equal(renamed.data.material.title, 'Cedar Valley — corrected newsletter', 'trimmed, spaces collapsed');
    const after = await memberA.get(`/api/hubs/${hubId}`);
    assert.equal(after.data.materials.find((m) => m.id === mat1.id).title, 'Cedar Valley — corrected newsletter');
    const stampedAfter = after.data.facts.filter((f) => f.material_id === mat1.id && f.group_label === 'Cedar Valley — corrected newsletter').length;
    assert.equal(stampedAfter, stampedBefore, 'notes headed by the old name now carry the new one');

    const byAdmin = await founder.patch(`/api/hubs/${hubId}/materials/${mat1.id}`, { title: mat1.title });
    assert.equal(byAdmin.res.status, 200, 'hub admin may rename another member’s material');
    mat1 = byAdmin.data.material;
  });

  await t.test('uploader removes their own material; facts and evening check follow', async () => {
    const before = await memberA.post('/api/parent/run', {});
    assert.equal(before.res.status, 200, before.text.slice(0, 300));
    assert.ok(before.data.relevant_facts.some((f) => mat1FactIds.includes(f.id)), 'evening check sees the fact before removal');

    const removed = await memberA.del(`/api/hubs/${hubId}/materials/${mat1.id}`);
    assert.equal(removed.res.status, 200, removed.text.slice(0, 300));
    assert.equal(removed.data.ok, true);

    const detail = await memberA.get(`/api/hubs/${hubId}`);
    assert.ok(!detail.data.materials.some((m) => m.id === mat1.id), 'material leaves the hub list');
    assert.ok(!detail.data.facts.some((f) => f.material_id === mat1.id), 'its facts leave the hub list');

    const after = await memberA.post('/api/parent/run', {});
    assert.equal(after.res.status, 200, after.text.slice(0, 300));
    assert.ok(!after.data.relevant_facts.some((f) => mat1FactIds.includes(f.id)), 'evening check no longer includes its facts');
    const logs = (after.data.logs || []).map((l) => l.message).join('\n');
    assert.ok(logs.includes('PRIVACY CHECK:'), 'privacy line still present');
  });

  await t.test('hub admin removes another member’s material', async () => {
    const added = await memberA.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', title: 'Cedar Valley second notice (mock)',
      text: 'Cedar Valley notice: a second fictional notice for the admin removal case.',
    });
    assert.equal(added.res.status, 200, added.text.slice(0, 300));
    mat2 = added.data.material;
    const removed = await founder.del(`/api/hubs/${hubId}/materials/${mat2.id}`);
    assert.equal(removed.res.status, 200, removed.text.slice(0, 300));
    const detail = await founder.get(`/api/hubs/${hubId}`);
    assert.ok(!detail.data.materials.some((m) => m.id === mat2.id), 'admin removal clears the list');
    assert.ok(!detail.data.facts.some((f) => f.material_id === mat2.id), 'admin removal clears its facts');
  });

  await t.test('demo hub materials refuse removal and hide the action', async () => {
    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    const hubs = await demo.get('/api/hubs');
    const demoHub = hubs.data.hubs.find((h) => h.is_demo);
    assert.ok(demoHub, 'seeded demo hub exists');
    const detail = await demo.get(`/api/hubs/${demoHub.id}`);
    assert.ok(detail.data.materials.length > 0, 'demo hub has seeded materials');
    assert.ok(detail.data.materials.every((m) => m.can_remove === false), 'no Remove action in the demo');
    assert.ok(detail.data.materials.every((m) => m.can_rename === false), 'no Rename action in the demo');
    const target = detail.data.materials[0];
    const refused = await demo.del(`/api/hubs/${demoHub.id}/materials/${target.id}`);
    assert.equal(refused.res.status, 403, 'server refuses demo removal even for its admin/uploader');
    const noRename = await demo.patch(`/api/hubs/${demoHub.id}/materials/${target.id}`, { title: 'Renamed demo' });
    assert.equal(noRename.res.status, 403, 'server refuses demo renames too');
    const after = await demo.get(`/api/hubs/${demoHub.id}`);
    assert.ok(after.data.materials.some((m) => m.id === target.id), 'demo material intact');
  });

  await t.test('page carries the Remove action with the hub-delete style confirm', async () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(page.includes('Remove this material? This cannot be undone.'), 'confirm copy present');
    assert.ok(page.includes('data-remove-material'), 'remove action rendered per material');
    assert.ok(page.includes("method: 'DELETE'"), 'remove calls the DELETE endpoint');
  });
});
