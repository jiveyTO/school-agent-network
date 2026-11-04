// Brief 070: the challenge question is asked ONCE per join, and every
// submitted answer is checked when it is submitted. Live test, Nov 4: a
// brand-new parent answered on the invite landing (before having a family),
// the answer was never checked (the accept endpoint stopped at "set up your
// family first" without reading it), and the same question came back after
// setup. Now the landing only signposts the question; it is asked after
// sign-in or setup, right before the family joins. A wrong answer says so
// with tries left, the third becomes a request for the hub contact, a right
// answer joins and is never asked again, and no path grants membership in
// a question hub without one. Fictional fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 42600 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const Q = 'Where is the winter skate?';
const A = ['Birchwood Rink'];
const SECRET = /birchwood/i;

function slice(from, to) {
  const a = PAGE.indexOf(from);
  const b = PAGE.indexOf(to, a);
  assert.ok(a !== -1 && b !== -1, `page has ${from} … ${to}`);
  return PAGE.slice(a, b);
}

// --- Part 1: the page's real join-card code in a sandbox ------------------

function fakeDom() {
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, hidden: false, textContent: '', innerHTML: '', value: '',
    focus() {}, querySelectorAll: () => [],
  });
  return { els, el };
}

const LANDING_SRC = slice('function joinLandingMode(data, hasReal)', 'async function loadAuth()');
const FIELDS_SRC = slice('function challengePrompts(data)', 'function showJoinPending(message)');

function landing(joinInfo, status, pending) {
  const { el } = fakeDom();
  const calls = { accept: 0, choice: 0, question: 0 };
  const sandbox = {
    document: { getElementById: el },
    window: { location: { pathname: '/join/tok123' } },
    sessionStorage: { getItem: () => pending || null },
    fetch: async (url) => ({
      ok: true,
      json: async () => (String(url).startsWith('/api/join/') ? joinInfo : status),
    }),
    encodeURIComponent,
    decodeURIComponent,
    joinToken: '',
    showJoin() {},
    stashPendingJoin() {},
    showJoinChoice() { calls.choice += 1; },
    showJoinQuestion() { calls.question += 1; },
    acceptPendingJoin: async () => { calls.accept += 1; },
    renderChallengeFields() {},
  };
  const api = vm.runInNewContext(`${LANDING_SRC}\n({ loadJoinView, joinLandingMode });`, sandbox);
  return { api, el, calls };
}

const ONE_Q = {
  hub_name: 'Cedar Valley Skaters', inviter_first_name: 'Fia', member_count: 3,
  has_question: true, question: Q, questions: [Q],
  challenge_note: 'A quick question only families in this group would know, so a forwarded link alone can’t join.',
  challenge_signpost: 'You’ll answer a quick question only families in this group would know — right after you sign in or set up your family.',
  needs_admin_ok: false, admin_first_name: 'Fia',
};

test('page: a visitor with no family sees a signpost, not the question', async () => {
  const h = landing(ONE_Q, { hasActiveProfile: false, isDemo: false });
  await h.api.loadJoinView();
  assert.equal(h.el('joinQuestion').hidden, true, 'no answer field before there is a family');
  assert.equal(h.el('joinAdminNote').hidden, false);
  assert.match(h.el('joinAdminNote').textContent, /^You’ll answer a quick question .* right after you sign in or set up your family\.$/);
  assert.equal(h.calls.accept, 0);
});

test('page: a demo viewer also gets the signpost', async () => {
  const h = landing(ONE_Q, { hasActiveProfile: true, isDemo: true });
  await h.api.loadJoinView();
  assert.equal(h.el('joinQuestion').hidden, true);
});

test('page: a parent who already has a family is asked on the landing, once', async () => {
  const h = landing(ONE_Q, { hasActiveProfile: true, isDemo: false });
  await h.api.loadJoinView();
  assert.equal(h.el('joinQuestion').hidden, false, 'the question shows where it can be checked at once');
  assert.equal(h.calls.accept, 0, 'nothing is sent until the parent answers');
});

test('page: a hub with no question keeps its admin note and no field', async () => {
  const plain = Object.assign({}, ONE_Q, { has_question: false, questions: [], question: '', challenge_signpost: '', needs_admin_ok: true });
  const h = landing(plain, { hasActiveProfile: false });
  await h.api.loadJoinView();
  assert.equal(h.el('joinQuestion').hidden, true);
  assert.match(h.el('joinAdminNote').textContent, /^Joining sends a request — Fia will let you in\.$/);
});

test('page: back from setup with the invite saved, it is picked up once and its question shown', async () => {
  const h = landing(ONE_Q, { hasActiveProfile: true, isDemo: false }, 'tok123');
  await h.api.loadJoinView();
  assert.equal(h.calls.accept, 1, 'the saved invite is picked up once');
  // Mid-detour (still no family): the account choice, not the question.
  const mid = landing(ONE_Q, { hasActiveProfile: false }, 'tok123');
  await mid.api.loadJoinView();
  assert.equal(mid.calls.choice, 1);
  assert.equal(mid.calls.accept, 0);
  assert.equal(h.api.joinLandingMode(ONE_Q, true), 'question');
  assert.equal(h.api.joinLandingMode(ONE_Q, false), 'signpost');
  assert.equal(h.api.joinLandingMode({ has_question: false }, false), 'plain');
});

test('page: a saved invite whose hub asks a question shows it after setup', async () => {
  const { el } = fakeDom();
  let shown = 0;
  const sandbox = {
    document: { getElementById: el },
    window: { location: { pathname: '/join/tok123' } },
    sessionStorage: { getItem: () => 'tok123' },
    fetch: async (url) => ({ ok: true, json: async () => (String(url).startsWith('/api/join/') ? ONE_Q : { hasActiveProfile: true, isDemo: false }) }),
    encodeURIComponent, decodeURIComponent,
    joinToken: '',
    showJoin() {}, stashPendingJoin() {}, showJoinChoice() {}, renderChallengeFields() {},
    showJoinQuestion() { shown += 1; },
    acceptPendingJoin: async () => { const e = new Error('Answer the hub’s question to join.'); e.data = { needs_answer: true, questions: [Q] }; throw e; },
  };
  const api = vm.runInNewContext(`${LANDING_SRC}\n({ loadJoinView });`, sandbox);
  await api.loadJoinView();
  assert.equal(shown, 1, 'asked exactly once, not swallowed');
});

test('page: a wrong answer keeps the field and the typed text, with tries left', () => {
  const { el } = fakeDom();
  const sandbox = {
    document: { getElementById: el },
    esc: (v) => String(v),
    showJoin() {},
  };
  const api = vm.runInNewContext(`${FIELDS_SRC}\n({ showJoinQuestion });`, sandbox);
  api.showJoinQuestion({ questions: [Q], challenge_note: ONE_Q.challenge_note }, 'That doesn’t match — 2 tries left.', ['Scotia Arena']);
  assert.equal(el('joinQuestion').hidden, false, 'the field stays for another try');
  assert.equal(el('joinAnswerInput').value, 'Scotia Arena', 'the typed answer is kept to fix');
  assert.equal(el('joinStatus').textContent, 'That doesn’t match — 2 tries left.');
  assert.equal(el('joinAcceptBtn').hidden, false);
});

test('page: the Join button passes the typed answers back after a miss', () => {
  const handler = slice("document.getElementById('joinAcceptBtn').addEventListener", "document.getElementById('joinSetupBtn')");
  assert.match(handler, /showJoinQuestion\(e\.data, e\.data\.wrong_answer \? e\.message : '', e\.data\.wrong_answer \? collectChallengeAnswers\('join'\) : null\)/);
});

// --- Part 2: the real server ----------------------------------------------

function makeClient(ip) {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({ redirect: 'manual' }, options || {});
    opts.headers = Object.assign({ 'X-Forwarded-For': ip }, (options && options.headers) || {});
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
    post: (p, body, headers) => req(p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body || {}) }),
  };
}

async function setUpFamily(c, name) {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  const made = await c.post('/api/profile', { parent_name: name, parent_email: slug + '@example.com', children: [{ name: name + ' Kid' }] });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
}

function assertNoAnswers(r, label) {
  assert.ok(!SECRET.test(r.text), label + ': no accepted answer in the payload');
  assert.ok(!/v2:|[0-9a-f]{64}/.test(r.text), label + ': no answer hash in the payload');
}

test('the question is asked once, checked when answered, and enforced on the server', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-join-once-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), PARENTLOOP_TEST_AUTH: '1', APP_DB_GCS_BUCKET: '' },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const probe = makeClient('10.7.0.1');
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await probe.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  const fia = makeClient('10.7.0.2');
  await setUpFamily(fia, 'Founder Fia');
  const made = await fia.post('/api/hubs', { name: 'Cedar Valley Skaters', kind: 'other' });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
  const hubId = made.data.hub.id;
  const set = await fia.post(`/api/hubs/${hubId}/join-settings`, { questions: [{ question: Q, answers: A }] });
  assert.equal(set.res.status, 200, set.text.slice(0, 300));
  const invite = async () => (await fia.post(`/api/hubs/${hubId}/invites`, {})).data.token;
  const isMember = async (c) => (await c.get(`/api/hubs/${hubId}`)).res.status === 200;

  await t.test('one question: the copy says "a quick question", and the landing gets a signpost', async () => {
    const info = await makeClient('10.7.1.1').get(`/api/join/${await invite()}`);
    assert.equal(info.res.status, 200);
    assert.deepEqual(info.data.questions, [Q], 'the prompt still comes back');
    assert.equal(info.data.challenge_note, 'A quick question only families in this group would know, so a forwarded link alone can’t join.');
    assert.equal(info.data.challenge_signpost, 'You’ll answer a quick question only families in this group would know — right after you sign in or set up your family.');
    assert.ok(!/couple/.test(info.text), 'no "couple of questions" for one question');
    assertNoAnswers(info, 'join info');
  });

  await t.test('a new parent: an early answer is never silently accepted, then asked once after setup', async () => {
    const token = await invite();
    const nia = makeClient('10.7.2.1');
    // The live-test path: a wrong answer sent before there is a family.
    const early = await nia.post(`/api/join/${token}/accept`, { answers: ['Scotia Arena'] });
    assert.equal(early.res.status, 409);
    assert.equal(early.data.needs_account_choice, true);
    assert.equal(early.data.answer_checked, false, 'the reply says the answer was not checked');
    assert.equal(early.data.question_after_setup, true);
    assert.match(early.data.error, /wasn’t checked yet/);
    assert.ok(!early.data.ok, 'no success shape');
    await setUpFamily(nia, 'New Nia');
    assert.equal(await isMember(nia), false, 'setup alone grants nothing');
    // Back from setup: the page re-sends the saved invite with no answer.
    // This is where (and the only place) the question is asked.
    const asked = await nia.post(`/api/join/${token}/accept`, {});
    assert.equal(asked.res.status, 409);
    assert.equal(asked.data.needs_answer, true);
    assert.deepEqual(asked.data.questions, [Q]);
    assertNoAnswers(asked, 'needs-answer reply');
    // The early answer used no attempt: the first miss here leaves 2.
    const w1 = await nia.post(`/api/join/${token}/accept`, { answers: ['Scotia Arena'] });
    assert.equal(w1.res.status, 400);
    assert.equal(w1.data.error, 'That doesn’t match — 2 tries left.');
    assert.equal(w1.data.tries_left, 2);
    assert.equal(w1.data.needs_answer, true, 'the field stays for another try');
    assert.equal(await isMember(nia), false);
    // A right answer after a wrong one still passes.
    const right = await nia.post(`/api/join/${token}/accept`, { answers: ['  birchwood rink. '] });
    assert.equal(right.res.status, 200, right.text.slice(0, 300));
    assert.equal(right.data.membership, 'member');
    assert.equal(await isMember(nia), true);
    // Never asked again within (or after) that join.
    const again = await nia.post(`/api/join/${token}/accept`, {});
    assert.equal(again.res.status, 200);
    assert.ok(!again.data.needs_answer, 'not asked a second time');
  });

  await t.test('a parent with a family: right first time joins with exactly one ask', async () => {
    const token = await invite();
    const ola = makeClient('10.7.3.1');
    await setUpFamily(ola, 'Once Ola');
    const joined = await ola.post(`/api/join/${token}/accept`, { answers: ['Birchwood Rink'] });
    assert.equal(joined.res.status, 200, joined.text.slice(0, 300));
    assert.equal(await isMember(ola), true);
  });

  await t.test('wrong answers count down, and the third becomes a request with the note', async () => {
    const token = await invite();
    const wes = makeClient('10.7.4.1');
    await setUpFamily(wes, 'Wrong Wes');
    const w1 = await wes.post(`/api/join/${token}/accept`, { answers: ['a'] });
    assert.equal(w1.data.tries_left, 2);
    const w2 = await wes.post(`/api/join/${token}/accept`, { answers: ['b'] });
    assert.equal(w2.res.status, 400);
    assert.equal(w2.data.error, 'That doesn’t match — 1 try left.');
    assert.equal(w2.data.tries_left, 1);
    const w3 = await wes.post(`/api/join/${token}/accept`, { answers: ['c'] });
    assert.equal(w3.res.status, 202, 'the third miss becomes a request, not a lockout');
    assert.equal(w3.data.status, 'pending_approval');
    assert.match(w3.data.message, /^That doesn’t match\. We’ve asked Founder to let you in\.$/);
    assertNoAnswers(w3, 'request reply');
    assert.equal(await isMember(wes), false);
    const requests = await fia.get(`/api/hubs/${hubId}/join-requests`);
    const mine = requests.data.requests.find((r) => r.parent_name === 'Wrong Wes');
    assert.ok(mine, 'the hub contact sees the request');
    assert.equal(mine.status, 'pending');
    assert.equal(mine.note, 'Couldn’t answer the hub’s questions.');
  });

  await t.test('skipping the question never grants membership', async () => {
    const token = await invite();
    const sky = makeClient('10.7.5.1');
    await setUpFamily(sky, 'Skip Sky');
    for (const body of [{}, { answers: [] }, { answers: [''] }, { answer: '   ' }]) {
      const r = await sky.post(`/api/join/${token}/accept`, body);
      assert.equal(r.res.status, 409, JSON.stringify(body));
      assert.equal(r.data.needs_answer, true);
    }
    assert.equal(await isMember(sky), false);
  });

  await t.test('agent accept without a passed challenge is refused', async () => {
    const token = await invite();
    const amy = makeClient('10.7.6.1');
    await setUpFamily(amy, 'Agent Amy');
    const linked = await amy.post('/api/auth/test-complete', { sub: 'sub-agent-amy', email: 'agent.amy@example.com' });
    assert.equal(linked.res.status, 200, 'tokens hang off a signed-in family');
    const minted = await amy.post('/api/agent-tokens', { name: 'Helper' });
    assert.equal(minted.res.status, 200, minted.text.slice(0, 300));
    const agent = makeClient('10.7.6.2');
    const auth = { Authorization: 'Bearer ' + minted.data.token };
    for (const body of [{}, { answers: [''] }]) {
      const r = await agent.post(`/api/join/${token}/accept`, body, auth);
      assert.equal(r.res.status, 409);
      assert.equal(r.data.needs_answer, true);
      assertNoAnswers(r, 'agent reply');
    }
    const wrong = await agent.post(`/api/join/${token}/accept`, { answers: ['Scotia Arena'] }, auth);
    assert.equal(wrong.res.status, 400);
    assert.equal(wrong.data.tries_left, 2, 'an agent’s miss counts for that family too');
    assert.equal(await isMember(amy), false, 'no membership without a passed challenge');
  });

  await t.test('the copy follows the count: two and three questions', async () => {
    await fia.post(`/api/hubs/${hubId}/join-settings`, {
      questions: [{ question: Q, answers: A }, { question: 'What colour is the team jersey?', answers: ['green'] }],
    });
    const two = await makeClient('10.7.7.1').get(`/api/join/${await invite()}`);
    assert.match(two.data.challenge_note, /^A couple of quick questions /);
    assert.match(two.data.challenge_signpost, /^You’ll answer a couple of quick questions /);
    await fia.post(`/api/hubs/${hubId}/join-settings`, {
      questions: [{ question: Q, answers: A }, { question: 'What colour is the team jersey?', answers: ['green'] }, { question: 'Who drives the zamboni?', answers: ['Pat'] }],
    });
    const three = await makeClient('10.7.7.2').get(`/api/join/${await invite()}`);
    assert.match(three.data.challenge_note, /^A few quick questions /);
  });

  await t.test('a hub with no question still asks the admin, with no signpost', async () => {
    const cleared = await fia.post(`/api/hubs/${hubId}/join-settings`, { clear_question: true });
    assert.equal(cleared.res.status, 200, cleared.text.slice(0, 300));
    const token = await invite();
    const info = await makeClient('10.7.8.1').get(`/api/join/${token}`);
    assert.equal(info.data.has_question, false);
    assert.equal(info.data.challenge_signpost, '');
    assert.equal(info.data.needs_admin_ok, true);
    const pat = makeClient('10.7.8.2');
    const early = await pat.post(`/api/join/${token}/accept`, {});
    assert.equal(early.res.status, 409);
    assert.equal(early.data.question_after_setup, false);
    assert.match(early.data.error, /^To join this hub, sign in or set up your family first/);
    await setUpFamily(pat, 'Plain Pat');
    const asked = await pat.post(`/api/join/${token}/accept`, {});
    assert.equal(asked.res.status, 202, 'the request → admin approval path is unchanged');
  });
});
