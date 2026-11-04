const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Brief 067, store level: invite links expire 7 days after they're made
// (old links too), join answers are kept only as hashes and compared in a
// forgiving form, and an agent's join request expires. Fixtures fictional.

const DAY = 24 * 60 * 60 * 1000;

test('invite expiry, hashed join answers, and agent request expiry', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-join-links-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const dbPath = path.join(tmpDir, 'app.db');

  // A database from before expiry existed: one link made 3 days ago, one
  // made 10 days ago, both on a real hub.
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run('CREATE TABLE hubs (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, created_by TEXT, created_at TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0)');
  legacy.run("INSERT INTO hubs (id, name, kind, created_by, created_at, is_demo) VALUES ('hub-old', 'Willow Creek PS', 'school', 'nobody', '2026-10-01T00:00:00.000Z', 0)");
  legacy.run('CREATE TABLE invites (token TEXT PRIMARY KEY, hub_id TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)');
  const recent = new Date(Date.now() - 3 * DAY).toISOString();
  const stale = new Date(Date.now() - 10 * DAY).toISOString();
  legacy.run("INSERT INTO invites (token, hub_id, created_by, created_at, revoked) VALUES ('recentlink0001', 'hub-old', 'nobody', ?, 0)", [recent]);
  legacy.run("INSERT INTO invites (token, hub_id, created_by, created_at, revoked) VALUES ('stalelink00002', 'hub-old', 'nobody', ?, 0)", [stale]);
  fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
  legacy.close();

  process.env.APP_DB_PATH = dbPath;
  delete process.env.APP_DB_GCS_BUCKET;
  const db = require('../db');
  await db.initDb();

  await t.test('old links expire 7 days after they were made', () => {
    assert.equal(db.inviteState('recentlink0001'), 'ok', 'a 3-day-old link still works');
    assert.ok(db.getInvite('recentlink0001'));
    assert.equal(db.inviteState('stalelink00002'), 'expired', 'a 10-day-old link has expired');
    assert.equal(db.getInvite('stalelink00002'), null);
    assert.equal(db.inviteState('no-such-link'), 'missing');
    const active = db.listActiveInvites('hub-old');
    assert.deepEqual(active.map((i) => i.last4), ['0001'], 'only the live link is listed, by its last 4');
    assert.ok(!JSON.stringify(active).includes('recentlink0001'), 'the full link is never listed');
  });

  await t.test('a new link lasts 7 days, then expires; turning one off works by ref', () => {
    const token = db.createInvite('hub-old', 'nobody');
    assert.equal(db.inviteState(token), 'ok');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6 * DAY;
      assert.equal(db.inviteState(token), 'ok', 'still fine on day 6');
      Date.now = () => realNow() + 7 * DAY + 60000;
      assert.equal(db.inviteState(token), 'expired', 'expired after 7 days');
    } finally {
      Date.now = realNow;
    }
    const ref = db.listActiveInvites('hub-old').find((i) => i.last4 === token.slice(-4)).ref;
    assert.equal(db.turnOffInvite('hub-old', ref), true);
    assert.equal(db.inviteState(token), 'missing', 'a turned-off link no longer works');
    assert.equal(db.turnOffInvite('hub-old', ref), false, 'turning it off twice is a miss');
  });

  await t.test('join answers: hashed, never readable, forgiving to type', () => {
    assert.throws(() => db.setJoinQuestion('hub-old', '', ['x']), /question/);
    assert.throws(() => db.setJoinQuestion('hub-old', 'What is the class pet called?', []), /answer/);
    const saved = db.setJoinQuestion('hub-old', 'What is the class pet called?', ['Mr. Biscuit', 'Biscuit']);
    assert.equal(saved.has_question, true);
    assert.equal(saved.answer_count, 2);
    assert.ok(!JSON.stringify(saved).includes('Biscuit'), 'settings never carry an answer');
    const bytes = fs.readFileSync(dbPath).toString('latin1');
    assert.ok(!/biscuit/i.test(bytes), 'no answer is stored in plain text anywhere in the database');
    for (const ok of ['mr biscuit', 'MR. BISCUIT', '  Mr   Biscuit!! ', 'biscuit', 'Mr. Bíscuit']) {
      assert.equal(db.checkJoinAnswer('hub-old', ok), true, `"${ok}" is accepted`);
    }
    for (const no of ['', '   ', 'cookie', 'mr biscuits']) {
      assert.equal(db.checkJoinAnswer('hub-old', no), false, `"${no}" is refused`);
    }
    const cleared = db.clearJoinQuestion('hub-old');
    assert.equal(cleared.has_question, false);
    assert.equal(db.checkJoinAnswer('hub-old', 'biscuit'), false);
  });

  await t.test('an agent join request expires after 10 minutes and never stores a token', () => {
    const token = db.createInvite('hub-old', 'nobody');
    const made = db.createAgentConnect(token, 'hub-old', '  Muse  ');
    assert.equal(made.connect.agent_name, 'Muse');
    assert.match(made.connect.user_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(!JSON.stringify(made.connect).includes(made.pollSecret), 'only a hash of the poll secret is kept');
    assert.equal(db.collectAgentConnect(made.connect.id, 'wrong-secret').status, 'unknown');
    assert.equal(db.collectAgentConnect(made.connect.id, made.pollSecret).status, 'pending');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11 * 60 * 1000;
      assert.equal(db.getAgentConnect(made.connect.id).status, 'expired');
      assert.equal(db.decideAgentConnect(made.connect.id, { approve: false }), null, 'an expired request can’t be decided');
      assert.equal(db.collectAgentConnect(made.connect.id, made.pollSecret).status, 'expired');
    } finally {
      Date.now = realNow;
    }
  });
});
