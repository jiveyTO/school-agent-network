// Login OAuth state nonces expire. They used to be pruned by comparing ISO
// created_at text with sqlite datetime() text (same-day rows never matched)
// and were never age-checked on consume, so a login state stayed valid
// forever. Store level, with Date.now stubbed. No real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('login states are single-use, session-bound, and expire', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-loginstate-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  process.env.APP_DB_GCS_BUCKET = '';
  process.env.APP_DB_GCS_OBJECT = '';
  const db = require('../db');
  await db.initDb();
  const realNow = Date.now;
  const t0 = realNow();
  try {
    const ok = db.createLoginState('session-north');
    assert.equal(db.consumeLoginState(ok, 'session-north'), true);
    assert.equal(db.consumeLoginState(ok, 'session-north'), false, 'single use');

    const wrong = db.createLoginState('session-north');
    assert.equal(db.consumeLoginState(wrong, 'session-harbor'), false, 'other session');
    assert.equal(db.consumeLoginState(wrong, 'session-north'), false, 'burned by the mismatch');

    const fresh = db.createLoginState('session-north');
    Date.now = () => t0 + 14 * 60 * 1000;
    assert.equal(db.consumeLoginState(fresh, 'session-north'), true, 'still valid within 15 minutes');

    const stale = db.createLoginState('session-north');
    Date.now = () => t0 + 14 * 60 * 1000 + 16 * 60 * 1000;
    assert.equal(db.consumeLoginState(stale, 'session-north'), false, 'refused after 15 minutes');

    // Pruning: minting a new state deletes expired ones. Mint A, jump past
    // its expiry and mint B (prunes A), then step back inside A's lifetime:
    // A is gone, so it is refused even though it would not be expired then.
    Date.now = () => t0;
    const pruned = db.createLoginState('session-north');
    Date.now = () => t0 + 20 * 60 * 1000;
    db.createLoginState('session-north');
    Date.now = () => t0 + 60 * 1000;
    assert.equal(db.consumeLoginState(pruned, 'session-north'), false, 'expired state was pruned on mint');

    assert.equal(db.consumeLoginState('', 'session-north'), false);
  } finally {
    Date.now = realNow;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
