const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Brief 046: agent tokens. A signed-in parent issues a named, revocable
// `pl_agent_…` token in the browser; the agent then works through the
// normal API with `Authorization: Bearer <token>`, scoped to that one
// family. Only the SHA-256 hash is stored (brief 041 pattern). The demo
// family can never issue or be resolved by a token.
// Fixtures are fictional. No real data, no real tokens.

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PORT = 38100 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

// Part A: store level — hashing, demo refusal, resolve/revoke, last-used.
test('agent token store: hash-only, demo refusal, lifecycle', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-store-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  const db = require('../db');
  await db.initDb();
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const demo = db.getDemoProfile();
  assert.ok(demo && demo.is_demo, 'demo family exists');

  await t.test('the demo profile can never hold a token', async () => {
    assert.equal(db.createAgentToken(demo.id, 'Demo Agent'), null);
    assert.deepEqual(db.listAgentTokens(demo.id), []);
    assert.equal(db.createAgentToken('no-such-profile', 'Ghost'), null);
    assert.throws(() => db.createAgentToken(demo.id, '   '), /Give this token a name/);
  });

  const amy = db.createProfile({
    parent_name: 'Store Amy',
    parent_email: 'store.amy@example.com',
    children: [{ name: 'Amy Junior' }],
  });
  const ben = db.createProfile({
    parent_name: 'Store Ben',
    parent_email: 'store.ben@example.com',
    children: [{ name: 'Ben Junior' }],
  });

  let raw = '';
  let record = null;
  await t.test('issue: prefixed once-shown token, only its hash is stored', async () => {
    const created = db.createAgentToken(amy.id, 'Homework Helper');
    assert.ok(created, 'token issued for a real family');
    raw = created.token;
    record = created.record;
    assert.ok(raw.startsWith(db.AGENT_TOKEN_PREFIX), 'recognizable prefix');
    assert.ok(raw.length >= 40, 'high-entropy token');
    assert.equal(record.name, 'Homework Helper');
    assert.equal(record.active, true);
    assert.equal(record.last_used_at, null);
    assert.equal(record.revoked_at, null);

    const row = db.agentTokenMeta(record.id);
    assert.ok(row, 'stored row exists');
    assert.notEqual(row.token_hash, raw, 'raw token is not stored');
    assert.equal(
      row.token_hash,
      crypto.createHash('sha256').update(raw).digest('hex'),
      'stored value is the SHA-256 hash of the token'
    );
    assert.ok(!JSON.stringify(row).includes(raw), 'raw token appears nowhere in the row');

    const listed = db.listAgentTokens(amy.id);
    assert.equal(listed.length, 1);
    assert.ok(!('token_hash' in listed[0]), 'listings never carry the hash');
    // Brief 060: the last 4 characters, captured at creation as a label.
    assert.equal(record.hint, raw.slice(-4), 'the new record carries the last-4 hint');
    assert.equal(listed[0].hint, raw.slice(-4), 'the listing carries the last-4 hint');
    assert.equal(row.display_hint, raw.slice(-4), 'only the last 4 characters are stored');
    assert.ok(!JSON.stringify(listed).includes(raw), 'listings never carry the raw token');
    assert.deepEqual(db.listAgentTokens(ben.id), [], 'tokens are per-family');
  });

  await t.test('resolve: acts as its own family and touches last_used_at', async () => {
    const resolved = db.resolveAgentToken(raw);
    assert.ok(resolved, 'token resolves');
    assert.equal(resolved.profile.id, amy.id);
    assert.equal(resolved.profile.is_demo, false);
    assert.equal(resolved.token.name, 'Homework Helper');
    assert.ok(resolved.token.last_used_at, 'resolution stamps last_used_at');
    const row = db.agentTokenMeta(record.id);
    assert.equal(row.last_used_at, resolved.token.last_used_at, 'touch is persisted');
    assert.equal(db.resolveAgentToken('pl_agent_not-a-real-token'), null, 'unknown token refused');
    assert.equal(db.resolveAgentToken('some-other-bearer'), null, 'unprefixed bearer refused');
    assert.equal(db.resolveAgentToken(''), null, 'empty bearer refused');
  });

  await t.test('revoke: only the owning family, then resolution refuses', async () => {
    assert.equal(db.revokeAgentToken(ben.id, record.id), null, 'another family cannot revoke it');
    assert.ok(db.resolveAgentToken(raw), 'still live after a foreign revoke attempt');
    const updated = db.revokeAgentToken(amy.id, record.id);
    assert.ok(updated, 'owner revoke succeeds');
    assert.equal(updated.active, false);
    assert.ok(updated.revoked_at, 'revoked_at is stamped');
    assert.equal(db.resolveAgentToken(raw), null, 'revoked token no longer resolves');
    const again = db.revokeAgentToken(amy.id, record.id);
    assert.equal(again.active, false, 'revoking twice stays revoked');
    assert.equal(db.revokeAgentToken(amy.id, 'no-such-token'), null, 'unknown id is a miss');
  });
});

// Part B: HTTP — issuance UI copy, full agent lifecycle, isolation, guards.
function makeClient() {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({ redirect: 'manual' }, options || {});
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
    req,
    get: (p, opts) => req(p, opts),
    post: (p, body, opts) => req(p, Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }, opts || {})),
  };
}

// Agent calls carry no session cookie at all — the bearer token is the
// only identity, exactly like a real agent process.
async function agent(urlPath, token, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, (options && options.headers) || {});
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  const res = await fetch(`${BASE}${urlPath}`, opts);
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data, text };
}

function agentPost(urlPath, token, body) {
  return agent(urlPath, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
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

test('Agent access section is on the My family page', () => {
  for (const token of [
    'Agent access',
    'id="agentSection"',
    'id="agentNameInput"',
    'id="agentCreateBtn"',
    'id="agentOnceValue"',
    'id="agentCopyBtn"',
    'Copy token',
    'Treat this like a password',
    'shown only this once',
    '/api/agent-tokens',
    'data-revoke-agent',
    'Revoke',
  ]) {
    assert.ok(PAGE.includes(token), `${token} must be present in the page`);
  }
  assert.ok(PAGE.includes('id="agentSignInNotice"'), 'anonymous families get the sign-in guidance');
  assert.ok(PAGE.includes('Sign in with Google'), 'guidance points at Google sign-in');
  assert.ok(!PAGE.includes('pl_agent_'), 'no real token value is baked into the page');
});

test('agent tokens over HTTP: lifecycle, scope, and guards', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-http-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: dbPath, PARENTLOOP_TEST_AUTH: '1' },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const probe = makeClient();
  await waitForServer(probe);

  // Amy: real family, signed in with Google (test completion path).
  const amy = makeClient();
  const amyProfile = await amy.post('/api/profile', {
    parent_name: 'Agent Amy',
    parent_email: 'agent.amy@example.com',
    children: [{ name: 'Amy Junior' }],
  });
  assert.equal(amyProfile.res.status, 200, amyProfile.text.slice(0, 300));
  const amyId = amyProfile.data.profile.id;
  const amyKidId = amyProfile.data.profile.children[0].id;
  const linked = await amy.post('/api/auth/test-complete', { sub: 'agent-amy-sub', email: 'agent.amy@example.com' });
  assert.equal(linked.res.status, 200);

  // Ben: a second family with its own hub and (later) its own token.
  const ben = makeClient();
  const benProfile = await ben.post('/api/profile', {
    parent_name: 'Agent Ben',
    parent_email: 'agent.ben@example.com',
    children: [{ name: 'Ben Junior' }],
  });
  assert.equal(benProfile.res.status, 200);
  const benId = benProfile.data.profile.id;
  await ben.post('/api/auth/test-complete', { sub: 'agent-ben-sub', email: 'agent.ben@example.com' });
  const benHub = await ben.post('/api/hubs', {
    school_name: 'Benbrook School', city: 'Benbrook', province: 'Ontario', country: 'Canada', kind: 'school',
  });
  assert.equal(benHub.res.status, 200);
  const benHubId = benHub.data.hub.id;

  let raw = '';
  let record = null;
  await t.test('issue: signed-in family mints a token, shown once', async () => {
    const empty = await amy.get('/api/agent-tokens');
    assert.equal(empty.res.status, 200);
    assert.deepEqual(empty.data.tokens, []);
    assert.equal(empty.data.can_issue, true);
    assert.equal(empty.data.needs_sign_in, false);

    const noName = await amy.post('/api/agent-tokens', { name: '   ' });
    assert.equal(noName.res.status, 400, 'a nameless token is refused');

    const created = await amy.post('/api/agent-tokens', { name: 'Homework Helper' });
    assert.equal(created.res.status, 200, created.text.slice(0, 300));
    raw = created.data.token;
    record = created.data.agent_token;
    assert.ok(raw.startsWith('pl_agent_'), 'issued token carries the prefix');
    assert.equal(record.name, 'Homework Helper');
    assert.equal(record.active, true);
    assert.equal(record.last_used_at, null);

    const listed = await amy.get('/api/agent-tokens');
    assert.equal(listed.data.tokens.length, 1);
    assert.equal(record.hint, raw.slice(-4), 'brief 060: the issued record carries the last-4 hint');
    assert.equal(listed.data.tokens[0].hint, raw.slice(-4), 'brief 060: GET lists the last-4 hint');
    assert.ok(!listed.text.includes(raw), 'the raw token is never listed again');
    assert.ok(!listed.text.includes('token_hash'), 'the hash is never listed');
  });

  let hubId = '';
  await t.test('agent works every in-scope endpoint as its own family', { timeout: 180000 }, async () => {
    const profile = await agent('/api/family-profile', raw);
    assert.equal(profile.res.status, 200);
    assert.equal(profile.data.profile.id, amyId, 'token resolves to Amy’s family');
    assert.equal(profile.data.profile.parent.name, 'Agent Amy');
    assert.equal(profile.data.profile.is_demo, false);

    const created = await agentPost('/api/hubs', raw, {
      school_name: 'Agentville School', city: 'Agentville', province: 'Ontario', country: 'Canada', kind: 'school',
    });
    assert.equal(created.res.status, 200, created.text.slice(0, 300));
    hubId = created.data.hub.id;
    assert.equal(created.data.hub.name, 'Agentville School — Agentville');

    const hubs = await agent('/api/hubs', raw);
    assert.equal(hubs.res.status, 200);
    assert.deepEqual(hubs.data.hubs.map((h) => h.id), [hubId], 'agent sees only its own family’s hubs');

    const detail = await agent(`/api/hubs/${hubId}`, raw);
    assert.equal(detail.res.status, 200);
    assert.equal(detail.data.hub.id, hubId);
    assert.equal(detail.data.needs_placement, true);

    const placed = await agentPost(`/api/hubs/${hubId}/placements`, raw, {
      placements: [{ child_id: amyKidId, grade: 'Grade 3', class: '3B' }],
    });
    assert.equal(placed.res.status, 200, placed.text.slice(0, 300));
    assert.equal(placed.data.needs_placement, false);

    const added = await agentPost(`/api/hubs/${hubId}/materials`, raw, {
      kind: 'paste',
      title: 'Agentville picnic notice',
      text: 'Agentville School notice: The school picnic is on Friday, November 20, 2026. Please bring a water bottle. Reply forms are due Wednesday, November 18, 2026.',
    });
    assert.equal(added.res.status, 200, added.text.slice(0, 400));
    assert.ok(added.data.facts_added >= 1, 'newsletter material is extracted');
    assert.ok(
      (added.data.logs || []).some((l) => String(l.message).includes('via agent: Homework Helper')),
      'material activity attributes the token by name'
    );

    const after = await agent(`/api/hubs/${hubId}`, raw);
    assert.ok(after.data.materials.some((m) => m.id === added.data.material.id), 'material is on the hub');
  });

  await t.test('find-or-create: a duplicate school is a 409, never a second hub', async () => {
    const dupe = await agentPost('/api/hubs', raw, {
      school_name: 'Agentville School', city: 'Agentville', province: 'Ontario', country: 'Canada', kind: 'school',
    });
    assert.equal(dupe.res.status, 409, 'existing school_key returns the conflict, not a duplicate');
    assert.equal(dupe.data.match_type, 'exact');
    assert.equal(dupe.data.existing_hub.id, hubId, 'the 409 names the existing hub');
    const hubs = await agent('/api/hubs', raw);
    assert.equal(hubs.data.hubs.filter((h) => h.id === hubId).length, 1);
    assert.equal(hubs.data.hubs.length, 1, 'no duplicate hub was created');
  });

  await t.test('invite redemption via token joins the token’s family', async () => {
    const invite = await ben.post(`/api/hubs/${benHubId}/invites`, {});
    // Brief 067: this hub lets anyone with a link join (the default asks the admin).
    assert.equal((await ben.post(`/api/hubs/${benHubId}/join-settings`, { open: true })).res.status, 200);
    assert.equal(invite.res.status, 200);
    const accepted = await agentPost(`/api/join/${invite.data.token}/accept`, raw, {});
    assert.equal(accepted.res.status, 200, accepted.text.slice(0, 300));
    assert.equal(accepted.data.hub.id, benHubId);

    const agentHubs = await agent('/api/hubs', raw);
    assert.ok(agentHubs.data.hubs.some((h) => h.id === benHubId), 'agent sees the joined hub');
    const detail = await agent(`/api/hubs/${benHubId}`, raw);
    assert.equal(detail.res.status, 200, 'agent reads the hub it joined');

    const browserHubs = await amy.get('/api/hubs');
    assert.ok(browserHubs.data.hubs.some((h) => h.id === benHubId), 'the browser session’s family joined too');
  });

  let benRaw = '';
  await t.test('family B’s token cannot reach family A’s hub or profile', async () => {
    const created = await ben.post('/api/agent-tokens', { name: 'Ben Agent' });
    assert.equal(created.res.status, 200);
    benRaw = created.data.token;

    const profile = await agent('/api/family-profile', benRaw);
    assert.equal(profile.data.profile.id, benId, 'Ben’s token resolves to Ben’s family');
    assert.notEqual(profile.data.profile.id, amyId);

    const detail = await agent(`/api/hubs/${hubId}`, benRaw);
    assert.equal(detail.res.status, 403, 'member gate refuses another family’s hub');
    assert.ok(!detail.text.includes('Agentville'), 'no hub data leaks to the other family');

    const hubs = await agent('/api/hubs', benRaw);
    assert.ok(!hubs.data.hubs.some((h) => h.id === hubId), 'Amy’s hub is not in Ben’s list');
    assert.ok(hubs.data.hubs.some((h) => h.id === benHubId), 'Ben’s own hub is listed');
  });

  await t.test('a token can never manage tokens', async () => {
    const listed = await agent('/api/agent-tokens', raw);
    assert.equal(listed.res.status, 403);
    const minted = await agentPost('/api/agent-tokens', raw, { name: 'Sneaky' });
    assert.equal(minted.res.status, 403);
    const revoked = await agentPost(`/api/agent-tokens/${record.id}/revoke`, raw, {});
    assert.equal(revoked.res.status, 403);
    const still = await agent('/api/family-profile', raw);
    assert.equal(still.res.status, 200, 'refused management attempts do not disturb the token');
  });

  await t.test('wrong or malformed tokens are 401 everywhere', async () => {
    for (const bad of ['pl_agent_not-a-real-token', 'pl_agent_', 'plain-garbage', '']) {
      const res = await agent('/api/family-profile', bad || null);
      if (!bad) continue; // empty header is covered by the no-bearer case below
      assert.equal(res.res.status, 401, `bearer ${JSON.stringify(bad)} is refused`);
    }
    const wrongHub = await agent(`/api/hubs/${hubId}`, 'pl_agent_not-a-real-token');
    assert.equal(wrongHub.res.status, 401);
    const noBearer = await agent('/api/family-profile', null);
    assert.equal(noBearer.res.status, 200, 'session (demo) view is untouched without a bearer');
    assert.equal(noBearer.data.profile.is_demo, true, 'cookieless session still lands on demo');
  });

  await t.test('brief 064: an Authorization header with no token is 401, never the demo', async () => {
    // The Nov 3 failure: `-H "Authorization: Bearer $TOKEN"` with $TOKEN unset
    // was read as "no header" and got the demo family's hubs with a 200.
    for (const header of ['', 'Bearer', 'Bearer ', 'Bearer    ', 'Basic dXNlcjpwYXNz', 'Token pl_agent_x', 'pl_agent_x']) {
      for (const urlPath of ['/api/hubs', '/api/family-profile']) {
        const res = await agent(urlPath, null, { headers: { Authorization: header } });
        assert.equal(res.res.status, 401, `Authorization ${JSON.stringify(header)} on ${urlPath} is refused`);
        assert.match(res.data.error, /didn’t carry a token/, 'the message says the header carried no token');
        assert.equal(res.data.hubs, undefined, 'no hub data comes back');
        assert.equal(res.data.profile, undefined, 'no family data comes back');
      }
    }
    const invalid = await agent('/api/hubs', null, { headers: { Authorization: 'Bearer pl_agent_not-a-real-token' } });
    assert.equal(invalid.res.status, 401);
    assert.match(invalid.data.error, /not valid/, 'a sent-but-wrong token keeps its own message');

    const lower = await agent('/api/hubs', null, { headers: { Authorization: 'bearer   ' + raw + '  ' } });
    assert.equal(lower.res.status, 200, 'scheme case and surrounding spaces are tolerated');
    assert.ok(lower.data.hubs.some((h) => h.id === hubId), 'a valid token still returns its family’s hubs');
    assert.ok(lower.data.hubs.every((h) => !h.is_demo), 'and never a demo hub');

    const page = await fetch(`${BASE}/`, { headers: { Authorization: 'Bearer' } });
    assert.equal(page.status, 200, 'the page itself is not an API route and stays reachable');
  });

  await t.test('last_used_at is stamped after agent use', async () => {
    const listed = await amy.get('/api/agent-tokens');
    const mine = listed.data.tokens.find((tk) => tk.id === record.id);
    assert.ok(mine, 'token is listed for its family');
    assert.ok(mine.last_used_at, 'agent use was recorded');
    assert.equal(mine.active, true);
  });

  await t.test('revoke cuts the agent off the moment the parent revokes it', async () => {
    const foreign = await ben.post(`/api/agent-tokens/${record.id}/revoke`, {});
    assert.equal(foreign.res.status, 404, 'another family cannot revoke (or find) this token');

    const revoked = await amy.post(`/api/agent-tokens/${record.id}/revoke`, {});
    assert.equal(revoked.res.status, 200);
    assert.equal(revoked.data.agent_token.active, false);
    assert.ok(revoked.data.agent_token.revoked_at);

    const profile = await agent('/api/family-profile', raw);
    assert.equal(profile.res.status, 401, 'revoked token is refused');
    const hubs = await agent('/api/hubs', raw);
    assert.equal(hubs.res.status, 401);

    const listed = await amy.get('/api/agent-tokens');
    const mine = listed.data.tokens.find((tk) => tk.id === record.id);
    assert.equal(mine.active, false, 'listing shows the token revoked');
  });

  await t.test('demo and anonymous families cannot issue', async () => {
    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    const demoList = await demo.get('/api/agent-tokens');
    assert.equal(demoList.res.status, 403, 'no token surface in demo state');
    const demoIssue = await demo.post('/api/agent-tokens', { name: 'Demo Agent' });
    assert.equal(demoIssue.res.status, 403, 'the demo family can never issue');

    const anon = makeClient();
    const anonProfile = await anon.post('/api/profile', {
      parent_name: 'Anon Annie',
      parent_email: 'anon.annie@example.com',
      children: [{ name: 'Annie Junior' }],
    });
    assert.equal(anonProfile.res.status, 200);
    const anonList = await anon.get('/api/agent-tokens');
    assert.equal(anonList.res.status, 200, 'anonymous families can see the section state');
    assert.equal(anonList.data.can_issue, false);
    assert.equal(anonList.data.needs_sign_in, true, 'issuance first points at sign-in');
    const anonIssue = await anon.post('/api/agent-tokens', { name: 'Anon Agent' });
    assert.equal(anonIssue.res.status, 403);
    assert.equal(anonIssue.data.needs_sign_in, true);
  });

  await t.test('demo evening check regression unchanged', { timeout: 180000 }, async () => {
    const demo = makeClient();
    await demo.post('/api/profile/demo', {});
    const run = await demo.post('/api/parent/run', {});
    assert.equal(run.res.status, 200, run.text.slice(0, 300));
    assert.equal(run.data.nudges.length, 3);
    assert.equal(run.data.conflicts.length, 3);
    assert.equal(run.data.relevant_count, 28);
    assert.equal(run.data.filtered_out_count, 1);
    const lastLog = run.data.logs[run.data.logs.length - 1].message;
    assert.ok(lastLog.startsWith('PRIVACY CHECK: family profile data used only inside this Parent Agent run'));
  });
});
