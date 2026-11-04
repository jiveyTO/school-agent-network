const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Brief 066: boot removes one named test material from a demo hub, with its
// facts and any saved demo evening check that shows them, and nothing else.
// Fixtures are fictional.

test('demo test-material cleanup removes exactly the named material', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-demo-cleanup-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  const db = require('../db');
  await db.initDb();

  const hub = db.getDemoHub();
  const demo = db.getDemoProfile();
  assert.ok(hub && demo, 'demo hub and family are seeded');
  const before = db.listMaterials(hub.id).map((m) => m.id);
  const factsBefore = db.listFacts(hub.id).length;
  assert.ok(factsBefore > 0, 'the seed has facts');

  const title = 'Fictional Weekly — test copy';
  const testMaterial = db.createMaterial(hub.id, demo.id, 'paste', title, 'Fictional text.', 'extracted');
  db.insertFacts(hub.id, testMaterial.id, [
    { id: 'cleanup-fact-1', type: 'event', title: 'Pumpkin parade', date: '2026-11-12', source_text: 'Pumpkin parade Thursday.' },
    { id: 'cleanup-fact-2', type: 'deadline', title: 'Library books due', date: '2026-11-13', source_text: 'Library books due Friday.' },
  ]);
  db.saveEveningCheck(demo.id, { result: { nudges: [{ fact_id: 'cleanup-fact-1' }] } });

  const target = { hubId: hub.id, materialId: testMaterial.id, title };

  await t.test('a wrong title or a non-demo hub is refused', () => {
    assert.equal(db.removeDemoTestMaterial({ ...target, title: 'Something else' }), null);
    assert.equal(db.removeDemoTestMaterial({ ...target, hubId: 'not-a-hub' }), null);
    assert.ok(db.getMaterial(testMaterial.id), 'the material is still there');
  });

  await t.test('the named material, its facts and the stale check go', () => {
    const out = db.removeDemoTestMaterial(target);
    assert.deepEqual(out, { facts_removed: 2, checks_cleared: 1 });
    assert.equal(db.getMaterial(testMaterial.id), null);
    assert.deepEqual(db.listMaterials(hub.id).map((m) => m.id), before, 'seed materials untouched');
    assert.equal(db.listFacts(hub.id).length, factsBefore, 'seed facts untouched');
    assert.equal(db.getEveningCheck(demo.id), null, 'the stale demo check is cleared');
  });

  await t.test('running it again is a no-op', () => {
    assert.equal(db.removeDemoTestMaterial(target), null);
  });

  await t.test('a demo check that does not show the material is kept', () => {
    const other = db.createMaterial(hub.id, demo.id, 'paste', title, 'Other fictional text.', 'extracted');
    db.saveEveningCheck(demo.id, { result: { nudges: [{ fact_id: 'seed-only' }] } });
    const out = db.removeDemoTestMaterial({ ...target, materialId: other.id });
    assert.deepEqual(out, { facts_removed: 0, checks_cleared: 0 });
    assert.ok(db.getEveningCheck(demo.id), 'unrelated saved check stays');
  });
});
