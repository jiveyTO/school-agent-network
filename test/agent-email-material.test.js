// Brief 062: agents feed the hub. An agent token adds an email it found in
// its parent's mailbox (kind email: subject, from, date, body text), and
// every add is idempotent: the same normalized source text already in the
// hub answers { ok: true, duplicate: true, material: <existing> } with no
// new material and no new extraction. Fictional fixtures only; a stub
// model answers and counts its calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 40800 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

function fact(id, title, quote, date) {
  return {
    id, type: 'deadline', title, detail: title + '.', date: date || '', time: '',
    applies_to: 'all students', action_required: true, action: 'order', link: '',
    source_document: 'email', source_text: quote,
    published_at: '', extracted_at: '', confidence: 1, supersedes: '',
    group_label: '', group_summary: '',
  };
}

function makeClient(bearer) {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (bearer) opts.headers.Authorization = 'Bearer ' + bearer;
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
    patch: (p, body) => req(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    del: (p) => req(p, { method: 'DELETE' }),
    get: (p) => req(p),
  };
}

const PIZZA_EMAIL = {
  kind: 'email',
  subject: 'Fwd: lunch stuff',
  from: 'Ms. Ngo <office@maplegrove.example>',
  date: 'Mon, 02 Nov 2026 09:15:00 -0500',
  text: 'Dear Maple Grove families,\n\nPizza Lunch orders for November are due Friday, November 6, 2026. ' +
    'Order online through the school cash portal.\n\nThank you,\nMaple Grove Office',
};

const SKATE_EMAIL = {
  kind: 'email',
  subject: 'Family skate night',
  from: 'Maple Grove Parent Council',
  date: '2026-11-03T18:00:00Z',
  text: 'Family Skate Night is on Saturday, November 21, 2026 at Maple Grove Arena. Helmets are required for all skaters.',
};

test('agents feed the hub: email kind, idempotent adds', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-email-'));
  let modelCalls = 0;
  let modelDown = false;
  let reply = () => JSON.stringify({ material_title: '', facts: [] });
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      modelCalls += 1;
      if (modelDown) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'model unavailable' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply() }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), PARENTLOOP_TEST_AUTH: '1',
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const parent = makeClient();
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await parent.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const prof = await parent.post('/api/profile', {
    parent_name: 'Feed Parent', parent_email: 'feed.parent@example.com', children: [{ name: 'Feed Kid' }],
  });
  assert.equal(prof.res.status, 200, prof.text.slice(0, 300));
  assert.equal((await parent.post('/api/auth/test-complete', { sub: 'feed-parent-sub', email: 'feed.parent@example.com' })).res.status, 200);
  const hub = await parent.post('/api/hubs', { name: 'Feed Test Hub', kind: 'other' });
  assert.equal(hub.res.status, 200, hub.text.slice(0, 300));
  const hubId = hub.data.hub.id;
  const minted = await parent.post('/api/agent-tokens', { name: 'Mail helper' });
  assert.equal(minted.res.status, 200, minted.text.slice(0, 300));
  const agent = makeClient(minted.data.token);
  const materialsInHub = async () => (await parent.get(`/api/hubs/${hubId}`)).data.materials;

  let pizza = null;
  await t.test('an agent adds an email: provenance stored, facts extracted and quote-verified against the body', async () => {
    reply = () => JSON.stringify({
      material_title: 'Pizza Lunch orders due Friday',
      facts: [
        fact('pizza-orders', 'Pizza Lunch orders due', 'Pizza Lunch orders for November are due Friday, November 6, 2026.', '2026-11-06'),
        fact('pizza-invented', 'Pizza day moved', 'Pizza day has moved to Thursday this week.', ''),
      ],
    });
    const before = modelCalls;
    const up = await agent.post(`/api/hubs/${hubId}/materials`, PIZZA_EMAIL);
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.ok(modelCalls > before, 'extraction ran');
    assert.equal(up.data.duplicate, false);
    pizza = up.data.material;
    assert.equal(pizza.kind, 'email');
    assert.equal(pizza.email_from, 'Ms. Ngo <office@maplegrove.example>', 'sender kept as sent');
    assert.equal(pizza.email_date, '2026-11-02T14:15:00.000Z', 'a parseable date is stored as ISO');
    assert.equal(pizza.title, 'Pizza Lunch orders due Friday', 'titled from its content, not the forward subject');
    assert.deepEqual(up.data.facts.map((f) => f.id), ['pizza-orders'], 'only the quote found in the email body is kept');
    assert.equal(pizza.unverified_count, 1, 'the invented item is left out');
    const detail = (await parent.get(`/api/hubs/${hubId}`)).data;
    const listed = detail.materials.find((m) => m.id === pizza.id);
    assert.ok(listed && listed.kind === 'email', 'the email lists in the hub');
    assert.equal(listed.email_from, PIZZA_EMAIL.from);
    assert.equal(listed.email_date, '2026-11-02T14:15:00.000Z');
    const stored = detail.facts.filter((f) => f.material_id === pizza.id);
    assert.ok(stored.length === 1 && stored[0].quote_verified, 'the kept fact is stored as quote-verified');
  });

  await t.test('the same email sent twice yields one material; the second answer is duplicate:true', async () => {
    const before = modelCalls;
    const again = await agent.post(`/api/hubs/${hubId}/materials`, PIZZA_EMAIL);
    assert.equal(again.res.status, 200, again.text.slice(0, 400));
    assert.equal(again.data.ok, true);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.material.id, pizza.id, 'points at the first material');
    assert.equal(again.data.facts_added, 0);
    assert.equal(modelCalls, before, 'no second extraction');
    assert.equal((await materialsInHub()).filter((m) => m.kind === 'email').length, 1, 'one email material in the hub');
  });

  await t.test('the same text from a signed-in parent lands on the agent\'s material', async () => {
    const before = modelCalls;
    // Different spacing and case normalize to the same text.
    const pasted = PIZZA_EMAIL.text.toUpperCase().replace(/\n+/g, '\n   \n').replace(/ /g, '  ');
    const up = await parent.post(`/api/hubs/${hubId}/materials`, { kind: 'paste', text: pasted });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.duplicate, true);
    assert.equal(up.data.material.id, pizza.id);
    assert.equal(modelCalls, before, 'no extraction for the duplicate');
    assert.equal((await materialsInHub()).length, 1, 'still one material');
  });

  await t.test('a different email adds normally', async () => {
    reply = () => JSON.stringify({
      material_title: 'Family Skate Night',
      facts: [fact('skate', 'Family Skate Night', 'Family Skate Night is on Saturday, November 21, 2026 at Maple Grove Arena.', '2026-11-21')],
    });
    const up = await agent.post(`/api/hubs/${hubId}/materials`, SKATE_EMAIL);
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.duplicate, false);
    assert.notEqual(up.data.material.id, pizza.id);
    assert.equal(up.data.facts_added, 1);
    assert.equal(up.data.material.email_from, 'Maple Grove Parent Council');
    assert.equal((await materialsInHub()).length, 2);
  });

  await t.test('a re-send of an email whose read failed is read again in place, not duplicated', async () => {
    const notice = 'Picture Retake Day is Thursday, November 26, 2026. Retake forms go home Monday.';
    modelDown = true;
    const first = await agent.post(`/api/hubs/${hubId}/materials`, { kind: 'email', subject: 'Retakes', from: 'Office', date: '', text: notice });
    modelDown = false;
    assert.equal(first.res.status, 200, first.text.slice(0, 400));
    assert.equal(first.data.facts_pending, true, 'saved with its notes pending');
    reply = () => JSON.stringify({
      material_title: 'Picture Retake Day',
      facts: [fact('retake', 'Picture Retake Day', 'Picture Retake Day is Thursday, November 26, 2026.', '2026-11-26')],
    });
    const second = await agent.post(`/api/hubs/${hubId}/materials`, { kind: 'email', subject: 'Retakes', from: 'Office', date: '', text: notice });
    assert.equal(second.res.status, 200, second.text.slice(0, 400));
    assert.equal(second.data.duplicate, true, 'nothing new was added');
    assert.equal(second.data.material.id, first.data.material.id, 'the same material');
    assert.equal(second.data.facts_added, 1, 'its notes were read this time');
    assert.equal((await materialsInHub()).length, 3);
    const third = await agent.post(`/api/hubs/${hubId}/materials`, { kind: 'email', subject: 'Retakes', from: 'Office', date: '', text: notice });
    assert.equal(third.data.duplicate, true);
    assert.equal(third.data.facts_added, 0, 'once read, a re-send is a plain duplicate');
  });

  await t.test('an email needs its body text', async () => {
    const empty = await agent.post(`/api/hubs/${hubId}/materials`, { kind: 'email', subject: 'Nothing here', from: 'Office', text: '  ' });
    assert.equal(empty.res.status, 500);
    assert.match(empty.data.error, /body text/);
  });

  await t.test('the manifest tells agents how to keep the hub fed', async () => {
    const manifest = (await makeClient().get('/api/agent')).data;
    const feed = manifest.keep_hub_fed;
    assert.ok(Array.isArray(feed) && feed.length === 5, 'five-point section');
    const text = feed.join(' ');
    assert.match(text, /mailbox/);
    assert.match(text, /own child specifically stays out/);
    assert.match(text, /duplicate: true/);
    assert.match(text, /materials first/);
    assert.match(text, /Keep it tidy/);
    const add = manifest.endpoints.find((e) => e.name === 'add material');
    assert.equal(add.email_body.kind, 'email');
    assert.match(add.description, /idempotent/);
    const rename = manifest.endpoints.find((e) => e.name === 'rename material');
    assert.equal(rename.method, 'PATCH');
    assert.equal(rename.path, '/api/hubs/{hub_id}/materials/{material_id}');
    assert.equal(rename.auth, 'Bearer agent token');
    const remove = manifest.endpoints.find((e) => e.name === 'remove material');
    assert.equal(remove.method, 'DELETE');
    assert.equal(remove.path, '/api/hubs/{hub_id}/materials/{material_id}');
    assert.equal(remove.auth, 'Bearer agent token');
  });

  await t.test('an agent renames and removes material its family added; another family\'s token cannot', async () => {
    const other = makeClient();
    await other.post('/api/profile', { parent_name: 'Other Parent', parent_email: 'other.parent@example.com', children: [{ name: 'Other Kid' }] });
    await other.post('/api/auth/test-complete', { sub: 'other-parent-sub', email: 'other.parent@example.com' });
    const otherToken = (await other.post('/api/agent-tokens', { name: 'Other helper' })).data.token;
    const stranger = makeClient(otherToken);
    const target = (await materialsInHub()).find((m) => m.title === 'Family Skate Night');
    assert.ok(target, 'the skate email is in the hub');

    const refused = await stranger.patch(`/api/hubs/${hubId}/materials/${target.id}`, { title: 'Nope' });
    assert.equal(refused.res.status, 403, 'not a member of this hub');
    assert.equal((await stranger.del(`/api/hubs/${hubId}/materials/${target.id}`)).res.status, 403);

    const renamed = await agent.patch(`/api/hubs/${hubId}/materials/${target.id}`, { title: 'Skate Night — Nov 21' });
    assert.equal(renamed.res.status, 200, renamed.text.slice(0, 300));
    assert.equal(renamed.data.material.title, 'Skate Night — Nov 21');
    assert.ok((await materialsInHub()).some((m) => m.id === target.id && m.title === 'Skate Night — Nov 21'));

    const before = (await materialsInHub()).length;
    const removed = await agent.del(`/api/hubs/${hubId}/materials/${target.id}`);
    assert.equal(removed.res.status, 200, removed.text.slice(0, 300));
    const after = await materialsInHub();
    assert.equal(after.length, before - 1);
    assert.ok(!after.some((m) => m.id === target.id), 'gone from the hub');
    const facts = (await parent.get(`/api/hubs/${hubId}`)).data.facts;
    assert.ok(!facts.some((f) => f.material_id === target.id), 'its notes went with it');
  });
});
