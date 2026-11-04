// Brief 068, glitch 1: Tonight never spins forever for a family that has
// just joined a hub. Joining lands on the hub page, so the first evening
// check used to wait for a Tonight visit that found the page "loading" and
// never started it. Now a family with no saved check is told to tap "Run my
// evening check" (since 2026-11-04 the check never runs on its own), and a
// failed or slow read shows an error with Try again.
// Part 1 drives the page's real loadEveningHome in a sandbox; part 2 has a
// brand-new family join an invite and run its first check. Fictional data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 42200 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function slice(from, to) {
  const a = PAGE.indexOf(from);
  const b = PAGE.indexOf(to, a);
  assert.ok(a !== -1 && b !== -1, `page has ${from} … ${to}`);
  return PAGE.slice(a, b);
}

const TIMEOUT_SRC = slice('const EVENING_LATEST_TIMEOUT_MS', 'async function fetchWithEveningRetry');
const LOAD_SRC = slice('let eveningLoading = false;', "document.getElementById('createProfileBtn')");

// The page's loadEveningHome (and its showEveningPlaceholder) with a fake
// DOM. `latest` answers GET /api/parent/latest; runEveningCheck only
// records its calls.
function harness(latest, tonightHidden) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, hidden: false, textContent: '', innerHTML: '' });
  el('viewEvening').hidden = tonightHidden;
  const results = el('parentResults');
  results.innerHTML = '<p class="facts-empty">Loading tonight’s check…</p>';
  Object.defineProperty(results, 'firstElementChild', {
    get() { return results.innerHTML ? { textContent: results.innerHTML.replace(/<[^>]+>/g, '') } : null; },
  });
  const runs = [];
  const sandbox = {
    document: { getElementById: el },
    fetch: latest,
    // The 15s read limit fires at once here.
    setTimeout: (cb, ms) => setTimeout(cb, ms >= 15000 ? 5 : ms),
    clearTimeout,
    esc: (v) => String(v),
    eveningCanMarkDone: false,
    parentRunBtn: { disabled: false },
    parentResultsEl: results,
    parentStatus: el('parentStatus'),
    // Copied out of the sandbox realm so deepEqual compares plain values.
    runEveningCheck: async (opts) => { runs.push(opts ? JSON.parse(JSON.stringify(opts)) : null); },
    renderParentResult: () => { results.innerHTML = '<div>saved check</div>'; },
    eveningUpdatedText: () => 'Updated 6:42 PM',
  };
  const api = vm.runInNewContext(`${TIMEOUT_SRC}\n${LOAD_SRC}\n({ loadEveningHome, loading: () => eveningLoading });`, sandbox);
  return { api, runs, el };
}

const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });

test('page: a family with no saved check is told to tap the button, never "Loading…", and nothing runs', async () => {
  const joined = () => json(200, { ok: true, check: null, ran_at: '', stale: true });
  for (const hidden of [true, false]) {
    const h = harness(joined, hidden);
    await h.api.loadEveningHome();
    assert.deepEqual(h.runs, [], 'the check runs only from the button (owner request, 2026-11-04)');
    assert.match(h.el('parentResults').innerHTML, /No evening check yet — tap “Run my evening check”/);
    assert.equal(h.api.loading(), false, 'the next visit is not blocked');
  }
});

test('page: a saved check shows at once; a stale one says so and is never re-run on its own', async () => {
  const stale = harness(() => json(200, { ok: true, check: { nudges: [] }, ran_at: 'x', stale: true }), false);
  await stale.api.loadEveningHome();
  assert.equal(stale.el('parentResults').innerHTML, '<div>saved check</div>');
  assert.deepEqual(stale.runs, [], 'an out-of-date check is not refreshed automatically');
  assert.equal(stale.el('parentStatus').textContent, 'Updated 6:42 PM — there’s news since. Tap “Run my evening check” to refresh it.');
  const fresh = harness(() => json(200, { ok: true, check: { nudges: [] }, ran_at: 'x', stale: false }), false);
  await fresh.api.loadEveningHome();
  assert.deepEqual(fresh.runs, []);
  assert.equal(fresh.el('parentStatus').textContent, 'Updated 6:42 PM');
  // Only the button's click handler calls runEveningCheck anywhere on the page.
  const callers = PAGE.match(/runEveningCheck\(/g) || [];
  assert.equal(callers.length, 2, 'the definition and the Run button handler');
  assert.ok(PAGE.includes("parentRunBtn.addEventListener('click', function () { runEveningCheck(); });"));
});

test('page: a failed or hung read says so instead of "Loading…"', async () => {
  for (const [label, latest] of [
    ['network drop', () => Promise.reject(new TypeError('Load failed'))],
    ['server error', () => json(500, { ok: false, error: 'Something broke.' })],
    ['hung request', () => new Promise(() => {})],
  ]) {
    const h = harness(latest, false);
    await h.api.loadEveningHome();
    assert.match(h.el('parentResults').innerHTML, /couldn’t load tonight’s check\. Tap “Run my evening check” to try again/, label);
    assert.equal(h.api.loading(), false, label + ': a second attempt is not blocked');
  }
});

test('page: a run that hangs gives up and shows the error card with Try again', () => {
  assert.ok(PAGE.includes("withTimeout(fetchWithEveningRetry('/api/parent/run', { method: 'POST' }),"));
  assert.ok(PAGE.includes('id="parentRetry"'));
});

test('server: a brand-new member who just joined can load and run Tonight', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-first-check-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  process.env.APP_DB_GCS_BUCKET = '';
  const db = require('../db');
  await db.initDb();
  const founder = db.createProfile({ parent_name: 'Contact Cora', children: [{ name: 'Cora Kid' }] });
  const hub = db.createHub(founder.id, 'Birchwood Public — Birchwood', 'school', {
    school_name: 'Birchwood Public', city: 'Birchwood', province: 'Ontario', country: 'Canada',
  });
  const fact = (id, title, date, extra) => Object.assign({
    id, type: 'event', title, detail: title + '.', date, time: '', applies_to: 'all students', action_required: false,
    action: '', link: '', source_document: 'mock', source_text: title, published_at: '', extracted_at: '',
    confidence: 1, supersedes: '', scope: 'school', scope_value: '', group_label: '', group_summary: '',
  }, extra || {});
  const m1 = db.createMaterial(hub.id, founder.id, 'paste', 'Pizza day (mock)', 'Pizza day Nov 4.', 'extracted');
  db.insertFacts(hub.id, m1.id, [fact('bw-pizza', 'Pizza day', '2026-11-04')], false);
  const m2 = db.createMaterial(hub.id, founder.id, 'paste', 'Quilt square (mock)', 'Bring a quilt square by Nov 4.', 'extracted');
  db.insertFacts(hub.id, m2.id, [fact('bw-quilt', 'Prepare quilt square', '2026-11-04', { type: 'deadline', action_required: true, action: 'Bring a quilt square' })], false);
  db.setJoinOpen(hub.id, true);
  const inviteToken = db.createInvite(hub.id, founder.id);

  const fakeModel = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let facts = [];
      try {
        const body = JSON.parse(raw);
        const user = body.messages.find((m) => m.role === 'user').content;
        facts = JSON.parse(user.split('School Agent facts:\n')[1] || '[]');
      } catch { facts = []; }
      const content = JSON.stringify({
        relevant_facts: facts.map((f) => ({ id: f.id, title: f.title })),
        nudges: [], calendar_hold: null, filtered_out_count: 0, filtering_summary: 'All of it applies.',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath, APP_DB_GCS_BUCKET: '', SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let jar = '';
  const call = async (method, p, body) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, jar ? { Cookie: jar } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set && /parentloop_session=/.test(set)) jar = set.split(';')[0];
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  };
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await call('GET', '/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  const made = await call('POST', '/api/profile', {
    parent_name: 'Newcomer Nia', parent_email: 'newcomer.nia@example.com', children: [{ name: 'Nia Kid' }],
  });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
  const joined = await call('POST', `/api/join/${inviteToken}/accept`, {});
  assert.equal(joined.res.status, 200, joined.text.slice(0, 300));
  assert.equal(joined.data.membership, 'member');

  const before = await call('GET', '/api/parent/latest');
  assert.equal(before.res.status, 200, before.text.slice(0, 300));
  assert.equal(before.data.ok, true);
  assert.equal(before.data.check, null, 'no history yet');
  assert.equal(before.data.stale, true, 'so Tonight says there is news since');

  const run = await call('POST', '/api/parent/run', {});
  assert.equal(run.res.status, 200, run.text.slice(0, 300));
  assert.equal(run.data.ok, true);
  assert.equal(run.data.relevant_count, 2, 'both hub items reach the new member');

  const after = await call('GET', '/api/parent/latest');
  assert.ok(after.data.check, 'the first check is saved');
  assert.equal(after.data.stale, false);
});
