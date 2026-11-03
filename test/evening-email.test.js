// Evening email: opt-in per family, sent once per local day at the family's
// chosen time by a scheduler tick (POST /api/cron/evening-emails with the
// shared secret), never to the demo, with a signed one-click unsubscribe.
// Fictional fixtures; mail goes to a test capture file, never out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39300 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CRON_SECRET = 'test-cron-secret-0123456789abcdef';
const PUBLIC = 'https://parentloop.example.test';

function client(cookie) {
  let jar = cookie || '';
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (jar) opts.headers.Cookie = jar;
    const res = await fetch(`${BASE}${urlPath}`, opts);
    const set = res.headers.get('set-cookie');
    if (set && /parentloop_session=/.test(set)) jar = set.split(';')[0];
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

test('evening email: opt-in, on time, once a day, unsubscribable', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-evening-email-'));
  const dbPath = path.join(tmpDir, 'app.db');
  const mailFile = path.join(tmpDir, 'mail.jsonl');
  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();
  const family = db.createProfile({ parent_name: 'Mail Parent', parent_email: 'mail.parent@example.com', children: [{ name: 'Sky Fictional' }] });
  const noEmail = db.createProfile({ parent_name: 'Quiet Parent', children: [{ name: 'Quiet Kid' }] });
  const hub = db.createHub(family.id, 'Elm Park Public — Elm Park', 'school', {
    school_name: 'Elm Park Public', city: 'Elm Park', province: 'Ontario', country: 'Canada',
  });
  const material = db.createMaterial(hub.id, family.id, 'paste', 'Elm Park weekly (mock)', 'Field trip forms are due Thursday. Pajama day is Friday.', 'extracted');
  const fact = (id, title, date, action) => ({
    id, type: action ? 'deadline' : 'event', title, detail: title + '.', date, time: '',
    applies_to: 'all students', action_required: Boolean(action), action: action || '', link: '', source_document: 'mock',
    source_text: title, published_at: '', extracted_at: '', confidence: 1, supersedes: '', scope: 'school', scope_value: '',
    group_label: '', group_summary: '',
  });
  db.insertFacts(hub.id, material.id, [
    fact('ep-trip', 'Field trip forms due', '2026-11-05', 'Return the signed form'),
    fact('ep-pj', 'Pajama day', '2026-11-06', ''),
  ], false);
  const s = db.createSession();
  db.setSessionProfile(s.id, family.id);
  const s2 = db.createSession();
  db.setSessionProfile(s2.id, noEmail.id);

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
        nudges: facts.filter((f) => f.action_required).map((f) => ({ fact_id: f.id, title: f.title, action: f.action, deadline: f.date, source: 'mock' })),
        calendar_hold: null, filtered_out_count: 0, filtering_summary: 'All of it applies.',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath, SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
      PARENTLOOP_TEST_AUTH: '1', PARENTLOOP_TEST_MAIL_FILE: mailFile,
      EVENING_EMAIL_CRON_SECRET: CRON_SECRET, PUBLIC_BASE_URL: PUBLIC,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const parent = client('parentloop_session=' + s.id);
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await parent.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const mails = () => (fs.existsSync(mailFile) ? fs.readFileSync(mailFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const tick = (now, secret) => parent.post('/api/cron/evening-emails', { now }, { 'X-ParentLoop-Cron': secret === undefined ? CRON_SECRET : secret });
  // Toronto wall-clock time on a November 2026 day (EST, UTC-5) as an ISO
  // instant, e.g. 18:00 on Nov 3 is 23:00 UTC.
  const AT = (hhmm, day) => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 10, Number(day || '03'), h + 5, m)).toISOString();
  };

  await t.test('preferences: off by default; validated; demo and no-email families cannot turn it on', async () => {
    const start = await parent.get('/api/evening-email');
    assert.equal(start.data.available, true);
    assert.equal(start.data.enabled, false, 'opt-in: off until the parent turns it on');
    assert.ok(start.data.times.includes('19:00') && start.data.times[0] === '16:00' && start.data.times.includes('21:30'));
    assert.equal((await parent.post('/api/evening-email', { enabled: true, time: '03:00' })).res.status, 400, 'time outside the evening');
    const quiet = client('parentloop_session=' + s2.id);
    assert.equal((await quiet.post('/api/evening-email', { enabled: true, time: '19:00' })).res.status, 400, 'needs an email first');
    const demo = client();
    await demo.post('/api/profile/demo', {});
    assert.equal((await demo.get('/api/evening-email')).data.available, false, 'not offered to the demo');
    assert.equal((await demo.post('/api/evening-email', { enabled: true, time: '19:00' })).res.status, 400);
    const on = await parent.post('/api/evening-email', { enabled: true, time: '18:00' });
    assert.equal(on.res.status, 200, on.text);
    assert.equal(on.data.enabled, true);
    assert.equal(on.data.time, '18:00');
  });

  await t.test('the scheduler endpoint refuses without the secret', async () => {
    assert.equal((await tick(AT('18:30'), '')).res.status, 403);
    assert.equal((await tick(AT('18:30'), 'wrong-secret-wrong-secret-xx')).res.status, 403);
    assert.equal(mails().length, 0);
  });

  await t.test('before the chosen time nothing is sent; at the time, one email with the check', async () => {
    const early = await tick(AT('17:45'));
    assert.equal(early.data.sent, 0);
    const due = await tick(AT('18:15'));
    assert.equal(due.res.status, 200, due.text);
    assert.equal(due.data.sent, 1);
    assert.ok(!/mail\.parent@example\.com/.test(due.text), 'the scheduler reply carries counts, never addresses');
    const [mail] = mails();
    assert.equal(mail.to, 'mail.parent@example.com');
    assert.equal(mail.subject, 'Tonight: 1 thing to do');
    assert.ok(mail.text.includes('Field trip forms due — Return the signed form (by Thu, Nov 5)'), 'the to-do with its deadline');
    assert.ok(mail.text.includes('Coming up this week:') && mail.text.includes('Fri, Nov 6: Pajama day'), 'the week ahead');
    assert.ok(mail.text.includes('Open ParentLoop: ' + PUBLIC + '/'));
    const unsub = (mail.text.match(/Stop these emails: (\S+)/) || [])[1];
    assert.ok(unsub && unsub.startsWith(PUBLIC + '/evening-email/off?t='), 'one-click unsubscribe link');
    assert.ok(!unsub.includes(family.id), 'the link carries a signature, not the profile id');
    assert.equal(mail.headers['List-Unsubscribe'], '<' + unsub + '>');
    assert.ok(mail.html.includes('<b>To do</b>') && mail.html.includes('Stop these emails'));
  });

  await t.test('once a day: a later tick the same evening sends nothing more', async () => {
    const again = await tick(AT('18:45'));
    assert.equal(again.data.sent, 0);
    assert.equal(mails().length, 1);
  });

  await t.test('a missed window is skipped rather than sent late', async () => {
    const late = await tick(AT('21:30', '04'));
    assert.equal(late.data.sent, 0, 'more than three hours after the chosen time');
    const next = await tick(AT('18:05', '05'));
    assert.equal(next.data.sent, 1, 'the next evening it goes out on time');
  });

  await t.test('unsubscribe link turns it off; a wrong token changes nothing', async () => {
    const unsub = mails()[0].text.match(/Stop these emails: (\S+)/)[1].replace(PUBLIC, BASE);
    const wrong = await fetch(BASE + '/evening-email/off?t=not-a-real-token');
    assert.equal(wrong.status, 200);
    assert.equal((await parent.get('/api/evening-email')).data.enabled, true, 'wrong token: still on');
    const off = await fetch(unsub);
    assert.equal(off.status, 200);
    assert.match(await off.text(), /You’re unsubscribed/);
    assert.equal((await parent.get('/api/evening-email')).data.enabled, false, 'right token: off');
    const tickAfter = await tick(AT('18:10', '06'));
    assert.equal(tickAfter.data.sent, 0, 'no more emails');
  });

  await t.test('page: evening email card on My family, nudge on Tonight', () => {
    for (const token of ['id="eveningEmailBox"', 'id="eveningEmailOn"', 'id="eveningEmailTime"', 'id="eveningEmailSaveBtn"',
      'id="eveningEmailHint"', "fetch('/api/evening-email')", "postJson('/api/evening-email'"]) {
      assert.ok(PAGE.includes(token), `${token} present`);
    }
    assert.ok(PAGE.includes("if (view === 'family') { loadFamilyPlacements(); loadAgentTokens(); loadEveningEmail(); }"));
  });
});
