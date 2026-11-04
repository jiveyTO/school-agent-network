// The demo's skate fitting moved from Wed Nov 4 (already past at the demo's
// Thursday-evening moment) to Sat Nov 7. New databases seed it on Nov 7;
// an existing database is moved once at boot, quote and material text with
// it, and later boots leave it alone. Fictional demo data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ID = 'fact-u9-hockey-skate-fitting-2026-11-04';
const OLD_QUOTE = 'Skate fitting is Wednesday between 4:30 and 5:30 PM at the pro shop.';
const NEW_QUOTE = 'Skate fitting is Saturday between 4:30 and 5:30 PM at the pro shop.';

function boot(dbPath) {
  return execFileSync(process.execPath, ['-e', "require('./db').initDb().then(() => process.exit(0))"], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', APP_DB_PATH: dbPath, APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '' },
    encoding: 'utf8',
  });
}

test('the demo skate fitting lands on Sat Nov 7 and moves old databases once', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-skate-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const dbPath = path.join(tmpDir, 'app.db');
  const SQL = await require('sql.js')();
  const read = () => new SQL.Database(fs.readFileSync(dbPath));
  const row = (db) => db.exec(
    `SELECT f.date, f.source_text, m.raw_text FROM facts f JOIN materials m ON m.id = f.material_id WHERE f.id = '${ID}'`
  )[0].values[0];

  const first = boot(dbPath);
  assert.ok(!/skate fitting moved/.test(first), 'a fresh seed needs no move');
  let db = read();
  let [date, quote, raw] = row(db);
  assert.equal(date, '2026-11-07');
  assert.equal(quote, NEW_QUOTE);
  assert.ok(raw.includes(NEW_QUOTE), 'the schedule text carries the quote');
  db.close();

  // An existing hosted database still has the old Wednesday fitting.
  db = read();
  db.run(`UPDATE facts SET date = '2026-11-04', source_text = ? WHERE id = ?`, [OLD_QUOTE, ID]);
  db.run('UPDATE materials SET raw_text = REPLACE(raw_text, ?, ?)', [NEW_QUOTE, OLD_QUOTE]);
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();

  // Either the one-time move or the demo reset (which rebuilds the demo
  // from the seed) brings it to Saturday; the result is what counts.
  const second = boot(dbPath);
  assert.match(second, /demo update: skate fitting moved to 2026-11-07|demo reset:/);
  db = read();
  [date, quote, raw] = row(db);
  assert.equal(date, '2026-11-07');
  assert.equal(quote, NEW_QUOTE);
  assert.ok(raw.includes(NEW_QUOTE) && !raw.includes(OLD_QUOTE), 'material text moved with it');
  db.close();

  const third = boot(dbPath);
  assert.ok(!/skate fitting moved|demo reset:/.test(third), 'later boots leave it alone');
});
