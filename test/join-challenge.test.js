// Brief 068: invite challenge questions. A hub's admin sets one to three
// questions (a belonging check, not a password); a family joining by link
// answers every one. Matching is forgiving (case, punctuation, accents,
// "St."/"Saint", "Ste."/"Sainte", "&"/"and", a leading "the"). Only the
// prompts ever leave the server. Three misses become a request to the
// admin, noted "Couldn't answer the hub's questions." Hubs saved with one
// 067 question keep working. Fixtures are fictional.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 42000 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const Q1 = 'What do the kids call the crossing guard?';
const Q2 = 'What is the school team called?';
const A1 = ['Mr. Okafor', 'Okafor'];
const A2 = ['St. Brigid’s Otters & Friends'];
// Every accepted answer and every way it could leak.
const SECRET_WORDS = /okafor|brigid|otters/i;

function makeClient(ip, cookie0) {
  let cookie = cookie0 || '';
  async function req(urlPath, options) {
    const opts = Object.assign({ redirect: 'manual' }, options || {});
    opts.headers = Object.assign({ 'X-Forwarded-For': ip || '10.0.0.1' }, (options && options.headers) || {});
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
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
  };
}

async function family(name, ip) {
  const c = makeClient(ip);
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  const made = await c.post('/api/profile', { parent_name: name, parent_email: slug + '@example.com', children: [{ name: name + ' Kid' }] });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
  const linked = await c.post('/api/auth/test-complete', { sub: 'sub-' + slug, email: slug + '@example.com' });
  assert.equal(linked.res.status, 200);
  return c;
}

// No accepted answer, and nothing shaped like a stored hash, in a payload.
function assertNoAnswers(r, label) {
  assert.ok(!SECRET_WORDS.test(r.text), label + ': no accepted answer in the payload');
  assert.ok(!/v2:|[0-9a-f]{64}/.test(r.text), label + ': no answer hash in the payload');
}

test('the page carries the challenge copy, up to three question rows, and the share nudge', () => {
  for (const token of ['id="joinChallengeNote"', 'id="joinQuestionMore"', 'id="approveQuestionMore"',
    'data-join-q-row="2"', 'id="hubJoinAddQuestionBtn"', 'id="inviteNudge"',
    'Add a challenge question so a forwarded link alone can’t join this hub.']) {
    assert.ok(PAGE.includes(token), `page has ${token}`);
  }
  assert.ok(!PAGE.includes('data-join-q-row="3"'), 'three questions at most');
});

test('challenge questions at the invite link', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-join-challenge-'));
  const dbPath = path.join(tmpDir, 'app.db');

  // A hub saved by Brief 067 (one question, one old-style answer hash),
  // made before the server starts: it must keep admitting the right answer.
  process.env.APP_DB_PATH = dbPath;
  process.env.APP_DB_GCS_BUCKET = '';
  const db = require('../db');
  await db.initDb();
  const legacyFounder = db.createProfile({ parent_name: 'Legacy Lee', children: [{ name: 'Legacy Kid' }] });
  const legacyHub = db.createHub(legacyFounder.id, 'Old Oak Parents', 'other', {});
  const legacySession = db.createSession();
  db.setSessionProfile(legacySession.id, legacyFounder.id);
  // db.js writes its file synchronously; set the 067 columns directly on it.
  const SQL = await require('sql.js')();
  const fileDb = new SQL.Database(fs.readFileSync(dbPath));
  const v1Hash = crypto.createHash('sha256').update(legacyHub.id + ':ms marigold').digest('hex');
  fileDb.run('UPDATE hubs SET join_question = ?, join_answers = ? WHERE id = ?',
    ['What do the kids call the lunch supervisor?', JSON.stringify([v1Hash]), legacyHub.id]);
  fs.writeFileSync(dbPath, Buffer.from(fileDb.export()));
  fileDb.close();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath, PARENTLOOP_TEST_AUTH: '1', APP_DB_GCS_BUCKET: '' },
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

  const fay = await family('Founder Fia', '10.2.1.1');
  const made = await fay.post('/api/hubs', { name: 'Cedar Lane Public', kind: 'other' });
  assert.equal(made.res.status, 200);
  const hubId = made.data.hub.id;
  const invite = async () => (await fay.post(`/api/hubs/${hubId}/invites`, {})).data;

  await t.test('an invite from a hub with no question nudges the admin only', async () => {
    const asAdmin = await invite();
    assert.equal(asAdmin.has_question, false);
    assert.equal(asAdmin.can_set_question, true, 'the admin is offered the question editor');
    const ola = await family('Open Ola', '10.2.1.2');
    await fay.post(`/api/hubs/${hubId}/join-settings`, { open: true });
    assert.equal((await ola.post(`/api/join/${asAdmin.token}/accept`, {})).res.status, 200);
    await fay.post(`/api/hubs/${hubId}/join-settings`, { open: false });
    const asMember = await ola.post(`/api/hubs/${hubId}/invites`, {});
    assert.equal(asMember.data.can_set_question, false, 'a plain member gets no nudge');
  });

  await t.test('the admin sets two questions; answers never come back', async () => {
    const set = await fay.post(`/api/hubs/${hubId}/join-settings`, {
      questions: [{ question: Q1, answers: A1 }, { question: Q2, answers: A2 }],
    });
    assert.equal(set.res.status, 200, set.text.slice(0, 300));
    assert.deepEqual(set.data.settings.questions, [Q1, Q2]);
    assert.equal(set.data.settings.question_count, 2);
    assertNoAnswers(set, 'save response');
    const read = await fay.get(`/api/hubs/${hubId}/join-settings`);
    assertNoAnswers(read, 'manage view');
    const four = await fay.post(`/api/hubs/${hubId}/join-settings`, {
      questions: [1, 2, 3, 4].map((n) => ({ question: 'Q' + n + '?', answers: ['a'] })),
    });
    assert.equal(four.res.status, 400, 'four questions are refused');
    const noAnswers = await fay.post(`/api/hubs/${hubId}/join-settings`, { questions: [{ question: 'New?', answers: [] }] });
    assert.equal(noAnswers.res.status, 400, 'a new question needs answers');
    assert.equal((await invite()).has_question, true, 'no nudge once a question is set');
  });

  await t.test('the join card gets the prompts and the belonging-check note, never answers', async () => {
    const { token } = await invite();
    const info = await makeClient('10.2.2.1').get(`/api/join/${token}`);
    assert.equal(info.res.status, 200);
    assert.deepEqual(info.data.questions, [Q1, Q2]);
    assert.equal(info.data.question, Q1, '067 clients still get the first prompt');
    assert.match(info.data.challenge_note, /forwarded link alone can’t join/);
    assert.ok(!('materials' in info.data) && !('members' in info.data) && !('facts' in info.data), 'no hub content before passing');
    assertNoAnswers(info, 'join info');
    const agentCard = await fetch(`${BASE}/api/join/${token}/agent`).then((r) => r.text());
    assert.ok(!SECRET_WORDS.test(agentCard), 'agent card: no answers');
  });

  await t.test('forgiving answers to every question join; one missing asks again', async () => {
    const { token } = await invite();
    const ria = await family('Right Ria', '10.2.3.1');
    const half = await ria.post(`/api/join/${token}/accept`, { answers: ['okafor'] });
    assert.equal(half.res.status, 409);
    assert.equal(half.data.needs_answer, true);
    assert.deepEqual(half.data.questions, [Q1, Q2]);
    assertNoAnswers(half, 'needs-answer reply');
    const right = await ria.post(`/api/join/${token}/accept`, { answers: ['  MR OKAFOR!', 'the Saint Brigids otters and friends'] });
    assert.equal(right.res.status, 200, right.text.slice(0, 300));
    assert.equal(right.data.membership, 'member');
    const hubView = await ria.get(`/api/hubs/${hubId}`);
    assert.equal(hubView.res.status, 200, 'in the hub straight away');
    const again = await ria.post(`/api/join/${token}/accept`, {});
    assert.equal(again.res.status, 200, 'an existing member skips the questions');
    assert.equal(again.data.membership, 'member');
  });

  await t.test('wrong answers: generic, counted, and the third asks the admin with a note', async () => {
    const { token } = await invite();
    const wes = await family('Wrong Wen', '10.2.4.1');
    const w1 = await wes.post(`/api/join/${token}/accept`, { answers: ['Okafor', 'Beavers'] });
    assert.equal(w1.res.status, 400);
    assert.equal(w1.data.error, 'That doesn’t match — 2 tries left.');
    assert.equal(w1.data.tries_left, 2);
    assertNoAnswers(w1, 'wrong-answer reply');
    const blocked = await wes.get(`/api/hubs/${hubId}`);
    assert.equal(blocked.res.status, 403, 'no hub content after a miss');
    assert.equal((await wes.post(`/api/join/${token}/accept`, { answers: ['x', 'y'] })).data.tries_left, 1);
    const w3 = await wes.post(`/api/join/${token}/accept`, { answers: ['x', 'y'] });
    assert.equal(w3.res.status, 202, 'the third miss becomes a request');
    assert.match(w3.data.message, /^That doesn’t match\. We’ve asked Founder to let you in\./);
    assertNoAnswers(w3, 'request reply');
    const requests = await fay.get(`/api/hubs/${hubId}/join-requests`);
    const mine = requests.data.requests.find((r) => r.parent_name === 'Wrong Wen');
    assert.equal(mine.status, 'pending');
    assert.equal(mine.note, 'Couldn’t answer the hub’s questions.');
  });

  await t.test('editing keeps saved answers by place; removing a question drops its answers', async () => {
    // Reword question 1 and keep both saved answer lists.
    const reworded = await fay.post(`/api/hubs/${hubId}/join-settings`, {
      questions: [{ question: 'Who helps the kids cross the road?', answers: [], from: 0 }, { question: Q2, answers: [], from: 1 }],
    });
    assert.equal(reworded.res.status, 200, reworded.text.slice(0, 300));
    const { token } = await invite();
    const kit = await family('Keep Kit', '10.2.5.1');
    assert.equal((await kit.post(`/api/join/${token}/accept`, { answers: ['okafor', 'St Brigid’s Otters & Friends'] })).res.status, 200);
    // Drop question 1; question 2 moves up with its own answers.
    const dropped = await fay.post(`/api/hubs/${hubId}/join-settings`, { questions: [{ question: Q2, answers: [], from: 1 }] });
    assert.deepEqual(dropped.data.settings.questions, [Q2]);
    const t2 = (await invite()).token;
    const dan = await family('Drop Dan', '10.2.5.2');
    const old = await dan.post(`/api/join/${t2}/accept`, { answers: ['okafor'] });
    assert.equal(old.res.status, 400, 'question 1’s answer no longer opens question 2');
    assert.equal((await dan.post(`/api/join/${t2}/accept`, { answers: ['Saint Brigids Otters and Friends'] })).res.status, 200);
  });

  await t.test('a hub saved with one 067 question still admits its answer', async () => {
    const lee = makeClient('10.2.6.1', 'parentloop_session=' + legacySession.id);
    const inv = await lee.post(`/api/hubs/${legacyHub.id}/invites`, {});
    assert.equal(inv.res.status, 200, inv.text.slice(0, 300));
    const info = await makeClient('10.2.6.2').get(`/api/join/${inv.data.token}`);
    assert.deepEqual(info.data.questions, ['What do the kids call the lunch supervisor?']);
    const mo = await family('Legacy Mo', '10.2.6.3');
    const joined = await mo.post(`/api/join/${inv.data.token}/accept`, { answer: 'Ms Marigold' });
    assert.equal(joined.res.status, 200, joined.text.slice(0, 300));
  });

  await t.test('the demo hub never takes a question', async () => {
    const demo = await makeClient('10.2.7.1').get('/api/hubs');
    const demoHub = (demo.data.hubs || []).find((h) => h.is_demo);
    if (demoHub) {
      const r = await makeClient('10.2.7.1').post(`/api/hubs/${demoHub.id}/join-settings`, { questions: [{ question: 'Q?', answers: ['a'] }] });
      assert.equal(r.res.status, 403);
    }
  });
});
