// The public demo returns to its seed at boot: anything added to a demo hub
// (a live add on camera, a visitor's paste), including notes it merged into
// the seed's own notes, is undone, and the demo's saved evening check goes
// with it. A boot with nothing to undo writes nothing, so an unchanged
// hosted database is still not uploaded. Fictional demo data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Boots the store in a child process; prints the boot log, then one JSON line
// with what the test needs.
function boot(dbPath) {
  const script = `
    const db = require('./db');
    db.initDb().then(() => {
      console.log('RESULT ' + JSON.stringify({ changes: db.totalRowChanges(), signature: db.demoContentSignature() }));
      process.exit(0);
    });`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, APP_DB_PATH: dbPath, APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '' },
    encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  return { log: out, ...JSON.parse(line.slice(7)) };
}

test('the demo resets to its seed at boot, and only when it changed', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-demo-reset-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const dbPath = path.join(tmpDir, 'app.db');
  const SQL = await require('sql.js')();
  const open = () => new SQL.Database(fs.readFileSync(dbPath));
  const save = (db) => { fs.writeFileSync(dbPath, Buffer.from(db.export())); db.close(); };
  const scalar = (db, sql, args) => db.exec(sql, args || [])[0].values[0][0];
  const demoHubA = (db) => scalar(db, "SELECT id FROM hubs WHERE is_demo = 1 AND name = 'Grade 3 — Maple Grove Elementary'");

  const first = boot(dbPath);
  const seeded = first.signature;
  assert.ok(seeded, 'the seeded demo has a signature');
  let db = open();
  assert.equal(scalar(db, "SELECT value FROM settings WHERE key = 'demo_seed_signature'"), seeded, 'recorded after seeding');
  const seedMaterials = scalar(db, 'SELECT COUNT(*) FROM materials m JOIN hubs h ON h.id = m.hub_id AND h.is_demo = 1');
  const seedFacts = scalar(db, 'SELECT COUNT(*) FROM facts f JOIN hubs h ON h.id = f.hub_id AND h.is_demo = 1');
  db.close();

  await t.test('a boot with nothing to undo writes nothing', () => {
    const again = boot(dbPath);
    assert.ok(!/demo reset/.test(again.log));
    assert.equal(again.changes, 0, 'no row changes, so the hosted copy is not uploaded');
    assert.equal(again.signature, seeded);
  });

  await t.test('a live add, its merge into a seed note, and the saved check are undone', () => {
    db = open();
    const hubA = demoHubA(db);
    const demoId = scalar(db, 'SELECT id FROM profiles WHERE is_demo = 1 ORDER BY created_at ASC LIMIT 1');
    db.run(
      "INSERT INTO materials (id, hub_id, uploaded_by, kind, title, raw_text, created_at, status) VALUES ('live-add', ?, ?, 'paste', 'Maple Grove Elementary — Parent Preview', 'MOCK DATA', '2026-11-05T00:00:00Z', 'extracted')",
      [hubA, demoId]
    );
    db.run(
      "INSERT INTO facts (id, hub_id, material_id, type, title, date, group_label) VALUES ('live-fact', ?, 'live-add', 'event', 'Live note', '2026-11-12', 'HELPING HANDS CLUB')",
      [hubA]
    );
    const seedFact = scalar(db, "SELECT id FROM facts WHERE hub_id = ? AND id != 'live-fact' ORDER BY id LIMIT 1", [hubA]);
    db.run("UPDATE facts SET group_label = 'The Week Ahead / merged' WHERE id = ?", [seedFact]);
    db.run("INSERT OR REPLACE INTO evening_checks (profile_id, result_json, ran_at) VALUES (?, '{}', '2026-11-05T00:00:00Z')", [demoId]);
    save(db);

    const reset = boot(dbPath);
    assert.match(reset.log, /demo reset: the demo hubs changed since their seed; cleared 3 material\(s\) and reseeding/);
    assert.equal(reset.signature, seeded, 'back to exactly the seed');
    db = open();
    assert.equal(scalar(db, "SELECT COUNT(*) FROM materials WHERE id = 'live-add'"), 0);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM facts WHERE id = 'live-fact'"), 0);
    assert.notEqual(scalar(db, 'SELECT group_label FROM facts WHERE id = ?', [seedFact]), 'The Week Ahead / merged', 'the merged seed note is restored');
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM materials m JOIN hubs h ON h.id = m.hub_id AND h.is_demo = 1'), seedMaterials);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM facts f JOIN hubs h ON h.id = f.hub_id AND h.is_demo = 1'), seedFacts);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM evening_checks WHERE profile_id IN (SELECT id FROM profiles WHERE is_demo = 1)'), 0, 'the stale demo check is cleared');
    db.close();

    const after = boot(dbPath);
    assert.ok(!/demo reset/.test(after.log), 'the next boot leaves it alone');
    assert.equal(after.changes, 0);
  });

  await t.test('first boot with the reset adopts a clean demo, but not one with a stray material', () => {
    db = open();
    db.run("DELETE FROM settings WHERE key = 'demo_seed_signature'");
    save(db);
    const adopt = boot(dbPath);
    assert.ok(!/demo reset/.test(adopt.log), 'a clean demo is adopted as is');
    assert.equal(adopt.signature, seeded);

    db = open();
    db.run("DELETE FROM settings WHERE key = 'demo_seed_signature'");
    db.run(
      "INSERT INTO materials (id, hub_id, uploaded_by, kind, title, raw_text, created_at, status) VALUES ('stray', ?, '', 'paste', 'Visitor paste', 'text', '2026-11-05T00:00:00Z', 'extracted')",
      [demoHubA(db)]
    );
    save(db);
    const stray = boot(dbPath);
    assert.match(stray.log, /demo reset/);
    assert.equal(stray.signature, seeded);
  });
});
