const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Brief 060: agent token cards show a last-4 hint. Tokens are stored only
// as hashes, so the hint is captured at creation; a token row from before
// the column existed lists and renders with no hint at all (never one
// derived from the hash). Fixtures are fictional. No real tokens.

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('a token minted before hints existed lists without one', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-token-hint-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const dbPath = path.join(tmpDir, 'app.db');

  // An existing database file whose agent_tokens table has the
  // pre-brief-060 shape and one row in it.
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  legacy.run(
    'INSERT INTO agent_tokens (id, profile_id, name, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
    ['legacy-token', 'legacy-family', 'Old Helper', 'a'.repeat(64), '2026-11-03T12:00:00.000Z']
  );
  fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
  legacy.close();

  process.env.APP_DB_PATH = dbPath;
  const db = require('../db');
  await db.initDb();

  const row = db.agentTokenMeta('legacy-token');
  assert.ok(row, 'the old row survives the migration');
  assert.equal(row.display_hint, '', 'existing rows get an empty hint');
  const listed = db.listAgentTokens('legacy-family');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Old Helper');
  assert.equal(listed[0].active, true);
  assert.ok(!('hint' in listed[0]), 'no hint key for a token minted before hints');
  assert.ok(!JSON.stringify(listed).includes('aaaa'), 'nothing from the hash is offered as a hint');
});

function pageFnSource(name) {
  const start = PAGE.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' is defined on the page');
  const open = PAGE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}') {
      depth--;
      if (depth === 0) return PAGE.slice(start, i + 1);
    }
  }
  assert.fail(name + ' body never closes');
}

// Runs the page's real loadAgentTokens against a stubbed GET and returns
// the rendered token list.
async function renderTokenCards(tokens) {
  const vm = require('node:vm');
  const els = {};
  const el = () => ({ hidden: false, innerHTML: '', textContent: '', querySelectorAll() { return []; } });
  const sandbox = {
    document: { getElementById(id) { return els[id] || (els[id] = el()); } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, tokens, can_issue: true, needs_sign_in: false }) }),
    humanDate: (iso) => String(iso).slice(0, 10),
    currentProfile: { id: 'family-1', is_demo: false },
    agentOnceFor: '',
  };
  vm.runInNewContext(
    [pageFnSource('esc'), pageFnSource('agentWhen'), 'async ' + pageFnSource('loadAgentTokens')].join('\n') +
      ';globalThis.__done = loadAgentTokens();',
    sandbox
  );
  await sandbox.__done;
  return els.agentList.innerHTML;
}

test('token card shows the hint only when the token has one', async () => {
  const base = { id: 't1', name: 'Muse Nov 3', created_at: '2026-11-03T12:00:00Z', last_used_at: null, revoked_at: null, active: true };
  const withHint = await renderTokenCards([Object.assign({ hint: 'egMs' }, base)]);
  assert.ok(withHint.includes('<b>Muse Nov 3</b> · ····egMs · Active'), withHint);
  const without = await renderTokenCards([base]);
  assert.ok(without.includes('<b>Muse Nov 3</b> · Active'), 'a token minted before hints renders as before');
  assert.ok(!without.includes('····'), 'no stand-in hint');
});
