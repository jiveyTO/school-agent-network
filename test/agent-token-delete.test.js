const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// A revoked agent token can be deleted from the family's list for good.
// An active token must be revoked first (deleting is never the step that
// cuts access off), only the owning family's browser session can delete,
// and an agent holding a token never can. Fixtures are fictional. No real
// tokens.

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PORT = 41000 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;

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
    get: (p) => req(p),
    del: (p) => req(p, { method: 'DELETE' }),
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
  };
}

async function signedInFamily(name, sub) {
  const client = makeClient();
  const prof = await client.post('/api/profile', {
    parent_name: name, parent_email: sub + '@example.com', children: [{ name: name + ' Junior' }],
  });
  assert.equal(prof.res.status, 200, prof.text.slice(0, 300));
  const linked = await client.post('/api/auth/test-complete', { sub, email: sub + '@example.com' });
  assert.equal(linked.res.status, 200);
  return client;
}

test('revoked agent tokens can be deleted; active ones cannot', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-agent-delete-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'),
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '', PARENTLOOP_TEST_AUTH: '1',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const probe = makeClient();
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await probe.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  const amy = await signedInFamily('Delete Amy', 'delete-amy-sub');
  const ben = await signedInFamily('Delete Ben', 'delete-ben-sub');
  const keep = await amy.post('/api/agent-tokens', { name: 'Keep Helper' });
  const old = await amy.post('/api/agent-tokens', { name: 'Old Helper' });
  assert.equal(old.res.status, 200, old.text.slice(0, 300));
  const oldId = old.data.agent_token.id;
  const keepId = keep.data.agent_token.id;
  const names = async () => ((await amy.get('/api/agent-tokens')).data.tokens || []).map((tk) => tk.name).sort();

  await t.test('an active token must be revoked first', async () => {
    const out = await amy.del('/api/agent-tokens/' + encodeURIComponent(oldId));
    assert.equal(out.res.status, 409);
    assert.match(out.data.error, /Revoke this token first/);
    assert.deepEqual(await names(), ['Keep Helper', 'Old Helper'], 'nothing deleted');
  });

  await t.test('an agent holding a token can never delete one', async () => {
    await amy.post('/api/agent-tokens/' + encodeURIComponent(oldId) + '/revoke', {});
    const out = await fetch(`${BASE}/api/agent-tokens/${encodeURIComponent(oldId)}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + keep.data.token },
    });
    assert.equal(out.status, 403);
    assert.deepEqual(await names(), ['Keep Helper', 'Old Helper']);
  });

  await t.test("another family cannot delete it, and it reads as not found", async () => {
    const out = await ben.del('/api/agent-tokens/' + encodeURIComponent(oldId));
    assert.equal(out.res.status, 404);
    assert.deepEqual(await names(), ['Keep Helper', 'Old Helper'], "Amy's list untouched");
  });

  await t.test('the owning family deletes the revoked token for good', async () => {
    const out = await amy.del('/api/agent-tokens/' + encodeURIComponent(oldId));
    assert.equal(out.res.status, 200, out.text.slice(0, 300));
    assert.deepEqual(out.data.tokens.map((tk) => tk.name), ['Keep Helper'], 'reply carries the updated list');
    assert.deepEqual(await names(), ['Keep Helper']);
    const again = await amy.del('/api/agent-tokens/' + encodeURIComponent(oldId));
    assert.equal(again.res.status, 404, 'a deleted token is gone');
    const asAgent = await fetch(`${BASE}/api/hubs`, { headers: { Authorization: 'Bearer ' + old.data.token } });
    assert.equal(asAgent.status, 401, 'the deleted token grants nothing');
    assert.ok(keepId, 'the other token is untouched');
  });
});

function pageFnSource(name) {
  const start = PAGE.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' is defined on the page');
  const open = PAGE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}') {
      depth--;
      if (depth === 0) return PAGE.slice(start, i + 1);
    }
  }
  assert.fail(name + ' body never closes');
}

test('only a revoked token card offers Delete, behind an inline confirm', async () => {
  const vm = require('node:vm');
  const els = {};
  const el = () => ({ hidden: false, innerHTML: '', textContent: '', querySelectorAll() { return []; } });
  const tokens = [
    { id: 'tk-active', name: 'Live Helper', created_at: '2026-11-03T12:00:00Z', last_used_at: null, revoked_at: null, active: true },
    { id: 'tk-revoked', name: 'Old Helper', created_at: '2026-11-03T11:00:00Z', last_used_at: null, revoked_at: '2026-11-03T13:00:00Z', active: false },
  ];
  const sandbox = {
    document: { getElementById(id) { return els[id] || (els[id] = el()); } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, tokens, can_issue: true, needs_sign_in: false }) }),
    humanDate: (iso) => String(iso).slice(0, 10),
    currentProfile: { id: 'family-1', is_demo: false },
    agentOnceFor: '',
  };
  vm.runInNewContext(
    [pageFnSource('esc'), pageFnSource('agentWhen'), 'async ' + pageFnSource('loadAgentTokens')].join('\n') +
      ';globalThis.__done = loadAgentTokens();',
    sandbox
  );
  await sandbox.__done;
  const html = els.agentList.innerHTML;
  const cards = html.split('<div class="card agent-token-card"').slice(1);
  assert.equal(cards.length, 2);
  const [active, revoked] = cards;
  assert.ok(active.includes('data-revoke-agent="tk-active"') && !active.includes('data-delete-agent'), 'active: Revoke only');
  assert.ok(revoked.includes('data-delete-agent="tk-revoked"') && !revoked.includes('data-revoke-agent'), 'revoked: Delete only');
  assert.ok(revoked.includes('<div data-agent-delete-confirm hidden>'), 'confirm starts hidden');
  assert.ok(revoked.includes('Delete this token for good?') && revoked.includes('Yes, delete') && revoked.includes('Keep it'));
  assert.ok(PAGE.includes("fetch('/api/agent-tokens/' + encodeURIComponent(btn.getAttribute('data-agent-delete-yes')), { method: 'DELETE' })"),
    'Yes, delete calls the DELETE endpoint');
});
