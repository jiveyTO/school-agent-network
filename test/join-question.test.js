const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 067, Part A: joining by invite link. A hub with a join question
// admits a family that answers it; three wrong answers become a request
// for the admin, never a lockout. A hub with no question asks the admin.
// "Let anyone with a link join" admits straight away. Admins manage the
// question and their links. Fixtures are fictional.

const ROOT = path.join(__dirname, '..');
const PORT = 41400 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function makeClient(ip) {
  let cookie = '';
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

async function family(name, ip, opts) {
  const c = makeClient(ip);
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  const made = await c.post('/api/profile', { parent_name: name, parent_email: slug + '@example.com', children: [{ name: name + ' Kid' }] });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
  if (!opts || opts.google !== false) {
    const linked = await c.post('/api/auth/test-complete', { sub: 'sub-' + slug, email: slug + '@example.com' });
    assert.equal(linked.res.status, 200);
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

test('the page carries the join question, the manage panels, and the waiting badge', () => {
  for (const token of ['id="joinQuestion"', 'id="joinAnswerInput"', 'id="joinAdminNote"', 'id="hubMenuJoinQuestion"',
    'id="hubMenuInviteLinks"', 'id="hubJoinPanel"', 'id="hubLinksPanel"', 'data-invite-off=', 'asking to join',
    'This link works for 7 days.', 'Let anyone with a link join']) {
    assert.ok(PAGE.includes(token), `page has ${token}`);
  }
  assert.ok(PAGE.includes('isn’t on the school website'), 'the question guidance steers away from public facts');
});

test('joining by invite: question, admin OK, open links, expiry messages, limits', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-join-question-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), PARENTLOOP_TEST_AUTH: '1', APP_DB_GCS_BUCKET: '' },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  const fay = await family('Founder Fay', '10.0.1.1');
  const hub = await fay.post('/api/hubs', { name: 'Willow Creek Parents', kind: 'other' });
  assert.equal(hub.res.status, 200);
  const hubId = hub.data.hub.id;
  const invite = async () => (await fay.post(`/api/hubs/${hubId}/invites`, {})).data.token;

  await t.test('no question, not open: a link join asks the admin, who sees the badge and decides', async () => {
    const token = await invite();
    const info = await fay.get(`/api/join/${token}`);
    assert.equal(info.data.needs_admin_ok, true);
    assert.equal(info.data.has_question, false);
    const jo = await family('Joiner Jo', '10.0.2.1');
    const asked = await jo.post(`/api/join/${token}/accept`, {});
    assert.equal(asked.res.status, 202, asked.text.slice(0, 300));
    assert.equal(asked.data.status, 'pending_approval');
    assert.match(asked.data.message, /asked Founder to let you in/);
    const again = await jo.post(`/api/join/${token}/accept`, {});
    assert.equal(again.res.status, 202, 'asking twice reuses the same request');
    const mine = await jo.get('/api/hubs');
    assert.deepEqual(mine.data.hubs, [], 'not a member yet');
    assert.deepEqual(mine.data.pending_hubs.map((h) => h.id), [hubId], 'the family sees it is waiting');
    const fays = await fay.get('/api/hubs');
    assert.equal(fays.data.hubs.find((h) => h.id === hubId).pending_requests, 1, 'the admin sees 1 asking to join');
    const reqs = await fay.get(`/api/hubs/${hubId}/join-requests`);
    const pending = reqs.data.requests.filter((r) => r.status === 'pending');
    assert.equal(pending.length, 1);
    const ok = await fay.post(`/api/hubs/${hubId}/join-requests/${pending[0].id}/approve`, {});
    assert.equal(ok.res.status, 200);
    const now = await jo.get('/api/hubs');
    assert.deepEqual(now.data.hubs.map((h) => h.id), [hubId], 'approved: now a member');
    assert.deepEqual(now.data.pending_hubs, []);
  });

  await t.test('a declined family can’t ask again the same day', async () => {
    const token = await invite();
    const dee = await family('Declined Dee', '10.0.3.1');
    assert.equal((await dee.post(`/api/join/${token}/accept`, {})).res.status, 202);
    const reqs = await fay.get(`/api/hubs/${hubId}/join-requests`);
    const mine = reqs.data.requests.find((r) => r.status === 'pending' && r.parent_name === 'Declined Dee');
    assert.equal((await fay.post(`/api/hubs/${hubId}/join-requests/${mine.id}/decline`, {})).res.status, 200);
    const retry = await dee.post(`/api/join/${token}/accept`, {});
    assert.equal(retry.res.status, 403);
    assert.match(retry.data.error, /ask again tomorrow/);
  });

  await t.test('only the admin manages the question; answers never come back', async () => {
    const jo = await family('Plain Member Pat', '10.0.4.1');
    const token = await invite();
    const fayOpen = await fay.post(`/api/hubs/${hubId}/join-settings`, { open: true });
    assert.equal(fayOpen.res.status, 200);
    assert.equal((await jo.post(`/api/join/${token}/accept`, {})).res.status, 200, 'open: instant join');
    assert.equal((await fay.post(`/api/hubs/${hubId}/join-settings`, { open: false })).res.status, 200);
    const denied = await jo.post(`/api/hubs/${hubId}/join-settings`, { question: 'Q?', answers: ['a'] });
    assert.equal(denied.res.status, 403, 'a plain member can’t set the question');
    assert.equal((await jo.get(`/api/hubs/${hubId}/join-settings`)).res.status, 403);
    const set = await fay.post(`/api/hubs/${hubId}/join-settings`, {
      question: 'What do the kids call the lunch supervisor?', answers: ['Ms. Marigold', 'Marigold'],
    });
    assert.equal(set.res.status, 200, set.text.slice(0, 300));
    assert.equal(set.data.settings.has_question, true);
    assert.equal(set.data.settings.answer_count, 2);
    assert.ok(!/marigold/i.test(set.text.replace(set.data.settings.question, '')), 'no answer in the response');
    const read = await fay.get(`/api/hubs/${hubId}/join-settings`);
    assert.ok(!/marigold/i.test(read.text), 'answers are never read back');
    const bad = await fay.post(`/api/hubs/${hubId}/join-settings`, { question: 'Q?', answers: [] });
    assert.equal(bad.res.status, 400, 'a question needs an answer');
  });

  await t.test('with a question: right answer joins, wrong answers retry, 3 misses ask the admin', async () => {
    const token = await invite();
    const info = await fay.get(`/api/join/${token}`);
    assert.equal(info.data.has_question, true);
    assert.equal(info.data.question, 'What do the kids call the lunch supervisor?');
    assert.equal(info.data.needs_admin_ok, false);

    const ria = await family('Right Ria', '10.0.5.1');
    const noAnswer = await ria.post(`/api/join/${token}/accept`, {});
    assert.equal(noAnswer.res.status, 409);
    assert.equal(noAnswer.data.needs_answer, true);
    const right = await ria.post(`/api/join/${token}/accept`, { answer: '  marigold!' });
    assert.equal(right.res.status, 200, right.text.slice(0, 300));
    assert.equal(right.data.membership, 'member');

    const wes = await family('Wrong Wes', '10.0.6.1');
    const w1 = await wes.post(`/api/join/${token}/accept`, { answer: 'Lunch Lady' });
    assert.equal(w1.res.status, 400);
    assert.equal(w1.data.wrong_answer, true);
    assert.equal(w1.data.tries_left, 2);
    assert.ok(!/marigold/i.test(w1.text), 'a wrong answer gets no hint');
    assert.equal((await wes.post(`/api/join/${token}/accept`, { answer: 'nope' })).data.tries_left, 1);
    const w3 = await wes.post(`/api/join/${token}/accept`, { answer: 'still no' });
    assert.equal(w3.res.status, 202, 'the third miss becomes a request, not a lockout');
    assert.match(w3.data.message, /That doesn’t match\. We’ve asked Founder to let you in\./);
    const w4 = await wes.post(`/api/join/${token}/accept`, { answer: 'marigold' });
    assert.equal(w4.res.status, 202, 'after three misses the admin decides, even with the right answer');
  });

  await t.test('an agent with a token on a question hub is told to ask its parent', async () => {
    const amy = await family('Agent Amy', '10.0.7.1');
    const minted = await amy.post('/api/agent-tokens', { name: 'Helper' });
    assert.equal(minted.res.status, 200);
    const token = await invite();
    const bearer = (urlPath, body) => fetch(`${BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + minted.data.token, 'X-Forwarded-For': '10.0.7.2' },
      body: JSON.stringify(body || {}),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    const asked = await bearer(`/api/join/${token}/accept`, {});
    assert.equal(asked.status, 409);
    assert.equal(asked.data.needs_answer, true);
    assert.equal(asked.data.question, 'What do the kids call the lunch supervisor?');
    const joined = await bearer(`/api/join/${token}/accept`, { answer: 'Ms Marigold' });
    assert.equal(joined.status, 200);
  });

  await t.test('invite links: listed by last 4, turned off by the admin only', async () => {
    const token = await invite();
    const list = await fay.get(`/api/hubs/${hubId}/join-settings`);
    const mine = list.data.invites.find((i) => i.last4 === token.slice(-4));
    assert.ok(mine, 'the new link is listed');
    assert.equal(mine.made_by, 'Founder');
    assert.ok(!list.text.includes(token), 'the full link never appears in the list');
    const pat = await family('Not Admin Ned', '10.0.8.1');
    assert.equal((await pat.post(`/api/hubs/${hubId}/invites/${mine.ref}/turn-off`, {})).res.status, 403);
    const off = await fay.post(`/api/hubs/${hubId}/invites/${mine.ref}/turn-off`, {});
    assert.equal(off.res.status, 200);
    const gone = await fay.get(`/api/join/${token}`);
    assert.equal(gone.res.status, 404);
    assert.equal(gone.data.error, 'That invite link is no longer available.');
  });

  await t.test('a hub holds at most 20 families waiting', async () => {
    const other = await fay.post('/api/hubs', { name: 'Busy Hub', kind: 'other' });
    const busyId = other.data.hub.id;
    const token = (await fay.post(`/api/hubs/${busyId}/invites`, {})).data.token;
    for (let i = 0; i < 20; i++) {
      const c = await family('Waiting Parent ' + String.fromCharCode(65 + i), '10.1.0.' + i, { google: false });
      assert.equal((await c.post(`/api/join/${token}/accept`, {})).res.status, 202);
    }
    const late = await family('Late Parent', '10.1.1.1', { google: false });
    const capped = await late.post(`/api/join/${token}/accept`, {});
    assert.equal(capped.res.status, 429);
  });

  await t.test('wrong answers are limited per address', async () => {
    const token = await invite();
    let last = null;
    for (let i = 0; i < 4; i++) {
      const c = await family('Guesser ' + String.fromCharCode(65 + i), '10.9.9.9');
      for (let k = 0; k < 3 && !(last && last.res.status === 429); k++) {
        last = await c.post(`/api/join/${token}/accept`, { answer: 'guess ' + k });
      }
    }
    assert.equal(last.res.status, 429, 'the eleventh wrong answer from one address in an hour is refused');
  });
});
