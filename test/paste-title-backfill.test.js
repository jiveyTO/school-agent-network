const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Brief 072: boot retitles pastes still carrying the old first-line cut
// (their notes' labels follow), leaves renamed pastes, other kinds and the
// demo hub alone, and changes nothing on a second run. Fixtures are fictional.

const GLUED = 'Hillside Public School — November Newsletter. Pizza Day: order by Monday, Nov 9 for Friday lunch. ' +
  'Photo retakes are Tuesday. Please send in permission forms for the Science Centre trip.';

test('legacy paste titles are retitled once, renames untouched', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-paste-backfill-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  process.env.APP_DB_GCS_BUCKET = '';
  const db = require('../db');
  await db.initDb();

  const hub = db.createHub('backfill-owner', 'Backfill Hub', 'other');
  assert.ok(hub && hub.id, 'a real (non-demo) hub');
  const legacy = db.legacyPasteTitle(GLUED);
  assert.ok(legacy.endsWith('…') && legacy.length > 61, 'the old cut: up to 80 characters and an ellipsis');

  const stale = db.createMaterial(hub.id, 'backfill-owner', 'paste', legacy, GLUED, 'extracted');
  db.insertFacts(hub.id, stale.id, [
    { id: 'bf-1', type: 'deadline', title: 'Pizza order', date: '2026-11-09', source_text: 'order by Monday, Nov 9', group_label: legacy, source_document: legacy },
  ]);
  const renamed = db.createMaterial(hub.id, 'backfill-owner', 'paste', 'Our November news', GLUED + ' Copy two.', 'extracted');
  const short = db.createMaterial(hub.id, 'backfill-owner', 'paste', 'Short heading', 'Short heading\nBody text here.', 'extracted');
  const pdf = db.createMaterial(hub.id, 'backfill-owner', 'pdf', db.legacyPasteTitle(GLUED + ' pdf'), GLUED + ' pdf', 'extracted');
  const demoHub = db.getDemoHub();
  const demoPaste = db.createMaterial(demoHub.id, '', 'paste', db.legacyPasteTitle(GLUED + ' demo'), GLUED + ' demo', 'extracted');

  await t.test('the stale paste and its notes take the new title', () => {
    assert.equal(db.retitleLegacyPastes(), 1);
    const title = db.getMaterial(stale.id).title;
    assert.equal(title, 'Hillside Public School — November Newsletter');
    const fact = db.listFacts(hub.id).find((f) => f.material_id === stale.id);
    assert.equal(fact.group_label, title);
    assert.equal(fact.source_document, title);
  });

  await t.test('renames, short titles, other kinds and the demo stay', () => {
    assert.equal(db.getMaterial(renamed.id).title, 'Our November news');
    assert.equal(db.getMaterial(short.id).title, 'Short heading');
    assert.equal(db.getMaterial(pdf.id).title, db.legacyPasteTitle(GLUED + ' pdf'));
    assert.equal(db.getMaterial(demoPaste.id).title, db.legacyPasteTitle(GLUED + ' demo'));
  });

  await t.test('a second run changes nothing', () => {
    assert.equal(db.retitleLegacyPastes(), 0);
  });
});

test('derivePasteTitle: one short line, never the whole paste', () => {
  const { derivePasteTitle } = require('../db');
  assert.equal(derivePasteTitle(GLUED), 'Hillside Public School — November Newsletter');
  const run = 'Dear families we have so much happening this month that it is hard to know where to start with all of it';
  const cut = derivePasteTitle(run);
  assert.ok(cut.length <= 61 && cut.endsWith('…') && !cut.includes('  '), cut);
  assert.equal(derivePasteTitle('St. Joseph news\nBody'), 'St. Joseph news');
  assert.match(derivePasteTitle(''), /^Newsletter — \d{4}-\d{2}-\d{2}$/);
});
