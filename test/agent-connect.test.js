const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 067, Part B: an agent with only an invite link asks to join; its
// parent approves once in their browser (answering any join question
// there); the agent collects its own family-scoped token exactly once.
// No raw token is ever shown anywhere else. Fixtures are fictional.

const ROOT = path.join(__dirname, '..');
const PORT = 41600 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function makeClient(ip) {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({ redirect: 'manual' }, options || {});
    opts.headers = Object.assign({ 'X-Forwarded-For': ip || '10.2.0.1' }, (options && options.headers) || {});
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
    get: (p, headers) => req(p, { headers: headers || {} }),
    post: (p, body, headers) => req(p, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: JSON.stringify(body || {}),
    }),
  };
}

async function family(name, ip, opts) {
  const c = makeClient(ip);
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  const made = await c.post('/api/profile', { parent_name: name, parent_email: slug + '@example.com', children: [{ name: name + ' Kid' }] });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
  if (!opts || opts.google !== false) {
    assert.equal((await c.post('/api/auth/test-complete', { sub: 'sub-' + slug, email: slug + '@example.com' })).res.status, 200);
  }
  c.id = made.data.profile.id;
  return c;
}

async function waitForServer() {
  const probe = makeClient();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      if ((await probe.get('/api/onboarding/status')).res.ok) return;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

test('the approval page and the agent note are on the page', () => {
  for (const token of ['id="approveView"', 'id="approveCode"', 'Check that your agent shows the same code',
    'id="approveYesBtn"', 'id="approveNoBtn"', 'id="approveQuestion"', 'pendingApproveId',
    'Using an AI agent? It can join for you — it should read /api/agent.', 'Joined via invite approval']) {
    assert.ok(PAGE.includes(token), `page has ${token}`);
  }
  assert.ok(!PAGE.includes('pl_agent_'), 'no token value is baked into the page');
});

test('agent joins by invite with one parent approval', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-connect-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), PARENTLOOP_TEST_AUTH: '1', APP_DB_GCS_BUCKET: '' },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  const fay = await family('Founder Fay', '10.3.0.1');
  const hub = await fay.post('/api/hubs', { name: 'Willow Creek Parents', kind: 'other' });
  const hubId = hub.data.hub.id;
  assert.equal((await fay.post(`/api/hubs/${hubId}/join-settings`, {
    question: 'What is the class pet called?', answers: ['Biscuit'],
  })).res.status, 200);
  const invite = async () => (await fay.post(`/api/hubs/${hubId}/invites`, {})).data.token;
  const agent = makeClient('10.4.0.1'); // cookie-less, like a real agent process
  const connect = async (token, name) => agent.post(`/api/join/${token}/connect`, { agent_name: name || 'Muse' });
  const collect = (id, secret) => agent.post(`/api/agent-connect/${id}/token`, { poll_secret: secret });

  await t.test('discovery: the link answers an agent in JSON and points the page at it', async () => {
    const token = await invite();
    const json = await agent.get(`/join/${token}`, { Accept: 'application/json' });
    assert.equal(json.res.status, 200);
    assert.deepEqual(Object.keys(json.data).sort(), ['guide', 'has_question', 'how_to_join', 'hub', 'invited_by_first_name', 'needs_admin_ok']);
    assert.equal(json.data.hub.name, 'Willow Creek Parents');
    assert.equal(json.data.has_question, true);
    assert.equal(json.data.guide, '/api/agent');
    assert.equal(json.data.how_to_join, `POST /api/join/${token}/connect`);
    assert.ok(!/biscuit/i.test(json.text), 'never the answer');
    assert.ok(!json.text.includes('Founder Fay'), 'first names only');
    const alt = await agent.get(`/api/join/${token}/agent`);
    assert.deepEqual(alt.data, json.data, 'the alternate JSON URL says the same');
    const html = await agent.get(`/join/${token}`, { Accept: 'text/html' });
    assert.ok(html.text.includes(`<link rel="alternate" type="application/json" href="/api/join/${token}/agent">`));
    assert.ok(html.text.includes('Using an AI agent? It can join for you'));
    const bad = await agent.get('/join/not-a-real-invite', { Accept: 'application/json' });
    assert.equal(bad.res.status, 404);
    assert.equal(bad.data.error, 'That invite link is no longer available.');
  });

  await t.test('connect: approval link, code, and a secret only the agent keeps', async () => {
    const token = await invite();
    const made = await connect(token);
    assert.equal(made.res.status, 200, made.text.slice(0, 300));
    for (const key of ['approval_url', 'user_code', 'request_id', 'poll_secret', 'expires_in', 'interval']) {
      assert.ok(made.data[key], `connect returns ${key}`);
    }
    assert.match(made.data.approval_url, new RegExp(`/approve/${made.data.request_id}$`));
    assert.match(made.data.user_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(made.data.expires_in, 600);
    const pending = await collect(made.data.request_id, made.data.poll_secret);
    assert.equal(pending.res.status, 202);
    assert.equal(pending.data.status, 'pending');
    assert.equal((await collect(made.data.request_id, 'wrong')).res.status, 404, 'a wrong secret learns nothing');
    const page = await agent.get(`/api/agent-connect/${made.data.request_id}`);
    assert.equal(page.data.user_code, made.data.user_code, 'the approval page shows the same code');
    assert.equal(page.data.agent_name, 'Muse');
    assert.ok(!page.text.includes(made.data.poll_secret), 'the approval page never sees the secret');
    assert.equal(page.data.viewer.can_approve, false, 'a cookie-less visitor can’t approve');
    assert.equal((await agent.post('/api/join/not-a-real-invite/connect', {})).res.status, 404);
  });

  await t.test('approve needs the parent, signed in with Google, in their own browser', async () => {
    const token = await invite();
    const made = await connect(token);
    const id = made.data.request_id;
    const anon = await agent.post(`/api/agent-connect/${id}/approve`, { answer: 'Biscuit' });
    assert.equal(anon.res.status, 403);
    assert.equal(anon.data.needs_sign_in, true);
    const noGoogle = await family('No Google Nia', '10.3.1.1', { google: false });
    assert.equal((await noGoogle.post(`/api/agent-connect/${id}/approve`, { answer: 'Biscuit' })).res.status, 403);
    const amy = await family('Bearer Amy', '10.3.2.1');
    const minted = await amy.post('/api/agent-tokens', { name: 'Old Helper' });
    const viaBearer = await agent.post(`/api/agent-connect/${id}/approve`, { answer: 'Biscuit' }, { Authorization: 'Bearer ' + minted.data.token });
    assert.equal(viaBearer.res.status, 403, 'a token can never approve');
    assert.equal((await collect(id, made.data.poll_secret)).res.status, 202, 'still waiting');
  });

  await t.test('the parent answers the question on the approval page; the agent collects once', async () => {
    const token = await invite();
    const made = await connect(token, 'Muse');
    const id = made.data.request_id;
    const wren = await family('Parent Wren', '10.3.3.1');
    const view = await wren.get(`/api/agent-connect/${id}`);
    assert.equal(view.data.viewer.can_approve, true);
    assert.equal(view.data.has_question, true);
    assert.equal(view.data.question, 'What is the class pet called?');
    const missing = await wren.post(`/api/agent-connect/${id}/approve`, {});
    assert.equal(missing.res.status, 409);
    const wrong = await wren.post(`/api/agent-connect/${id}/approve`, { answer: 'Rex' });
    assert.equal(wrong.res.status, 400);
    assert.equal(wrong.data.tries_left, 2);
    const ok = await wren.post(`/api/agent-connect/${id}/approve`, { answer: 'biscuit' });
    assert.equal(ok.res.status, 200, ok.text.slice(0, 300));
    assert.equal(ok.data.membership, 'member');
    assert.ok(!/pl_agent_/.test(ok.text), 'the browser never sees a token');
    assert.equal((await wren.post(`/api/agent-connect/${id}/approve`, { answer: 'biscuit' })).res.status, 409, 'single-use');

    const got = await collect(id, made.data.poll_secret);
    assert.equal(got.res.status, 200, got.text.slice(0, 300));
    assert.match(got.data.token, /^pl_agent_/);
    assert.equal(got.data.membership, 'member');
    assert.equal(got.data.hub.id, hubId);
    assert.equal(got.data.family_first_name, 'Parent');
    assert.equal((await collect(id, made.data.poll_secret)).res.status, 410, 'collected only once');

    const bearer = { Authorization: 'Bearer ' + got.data.token };
    const me = await agent.get('/api/family-profile', bearer);
    assert.equal(me.data.profile.id, wren.id, 'the token acts as the approving family');
    const hubs = await agent.get('/api/hubs', bearer);
    assert.deepEqual(hubs.data.hubs.map((h) => h.id), [hubId]);
    const tokens = await wren.get('/api/agent-tokens');
    const muse = tokens.data.tokens.find((tk) => tk.name === 'Muse');
    assert.equal(muse.via, 'invite approval', 'the Agent access list says how it joined');
    assert.equal(muse.hint, got.data.token.slice(-4));
  });

  await t.test('decline: the agent hears no and gets nothing', async () => {
    const made = await connect(await invite());
    const quinn = await family('Parent Quinn', '10.3.4.1');
    assert.equal((await quinn.post(`/api/agent-connect/${made.data.request_id}/decline`, {})).res.status, 200);
    const no = await collect(made.data.request_id, made.data.poll_secret);
    assert.equal(no.res.status, 403);
    assert.equal(no.data.token, undefined);
  });

  await t.test('no question: approval connects the agent and the admin lets the family in', async () => {
    const other = await fay.post('/api/hubs', {
      school_name: 'Cedar Falls School', city: 'Cedar Falls', province: 'Ontario', country: 'Canada', kind: 'school',
    });
    assert.equal(other.res.status, 200, other.text.slice(0, 300));
    const cedarId = other.data.hub.id;
    const token = (await fay.post(`/api/hubs/${cedarId}/invites`, {})).data.token;
    const made = await connect(token, 'Muse');
    const rory = await family('Parent Rory', '10.3.5.1');
    const view = await rory.get(`/api/agent-connect/${made.data.request_id}`);
    assert.equal(view.data.needs_admin_ok, true);
    const ok = await rory.post(`/api/agent-connect/${made.data.request_id}/approve`, {});
    assert.equal(ok.res.status, 200, ok.text.slice(0, 300));
    assert.equal(ok.data.membership, 'pending_approval');
    const got = await collect(made.data.request_id, made.data.poll_secret);
    assert.equal(got.res.status, 200);
    assert.equal(got.data.membership, 'pending_approval');
    const bearer = { Authorization: 'Bearer ' + got.data.token };
    const waiting = await agent.get('/api/hubs', bearer);
    assert.deepEqual(waiting.data.hubs, []);
    assert.deepEqual(waiting.data.pending_hubs.map((h) => h.id), [cedarId], 'the agent can see it is waiting');
    const reqs = await fay.get(`/api/hubs/${cedarId}/join-requests`);
    const pending = reqs.data.requests.find((r) => r.status === 'pending');
    assert.equal((await fay.post(`/api/hubs/${cedarId}/join-requests/${pending.id}/approve`, {})).res.status, 200);
    const inNow = await agent.get('/api/hubs', bearer);
    assert.deepEqual(inNow.data.hubs.map((h) => h.id), [cedarId]);
    const kid = (await agent.get('/api/family-profile', bearer)).data.profile.children[0].id;
    const placed = await agent.post(`/api/hubs/${cedarId}/placements`, { placements: [{ child_id: kid, grade: 'Grade 3' }] }, bearer);
    assert.equal(placed.res.status, 200, 'the agent finishes with placements');
  });

  await t.test('demo hubs and busy invites are refused', async () => {
    const demo = makeClient('10.3.6.1');
    await demo.post('/api/profile/demo', {});
    const demoHubs = await demo.get('/api/hubs');
    const demoHub = demoHubs.data.hubs[0];
    assert.ok(demoHub && demoHub.is_demo);
    const demoInvite = await demo.post(`/api/hubs/${demoHub.id}/invites`, {});
    if (demoInvite.res.status === 200) {
      assert.equal((await connect(demoInvite.data.token)).res.status, 403, 'a demo hub can’t be joined by an agent');
    }
    const token = await invite();
    for (let i = 0; i < 5; i++) assert.equal((await connect(token)).res.status, 200);
    assert.equal((await connect(token)).res.status, 429, 'at most 5 agents waiting on one invite');
  });
});
