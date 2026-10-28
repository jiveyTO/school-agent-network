// Small SQLite store for profiles, sources, settings, and Gmail tokens.
// Uses sql.js (WASM SQLite) so there is no native build step on node:20-alpine.
// All database access for the app goes through this module.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const ROOT = __dirname;
const DB_PATH = process.env.APP_DB_PATH
  ? path.isAbsolute(process.env.APP_DB_PATH)
    ? process.env.APP_DB_PATH
    : path.join(ROOT, process.env.APP_DB_PATH)
  : path.join(ROOT, 'data', 'app.db');
const SEED_PATH = path.join(ROOT, 'data', 'family-profile.json');
const SHARED_CORE = [
  'I work for this family alone.',
  "I never share this family's private information anywhere.",
  'I say where my facts came from.',
  'I am a secretary, not a decision-maker: I surface, remind, and prepare; the parent decides.',
];

let db = null;

function persist() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, params) {
  db.run(sql, params || []);
}

function all(sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function one(sql, params) {
  return all(sql, params)[0] || null;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    profile_id: row.id,
    id: row.id,
    is_demo: Boolean(row.is_demo),
    is_fictional_demo: Boolean(row.is_demo),
    school: row.school_name || '',
    parent: { name: row.parent_name || '' },
    child: {
      name: row.child_name || '',
      grade: row.grade || '',
      class: row.class_name || '',
    },
    soul: {
      shared_core: SHARED_CORE.slice(),
      priorities: parseJson(row.priorities, []),
      nudge_style: row.nudge_style || 'one short message in the evening',
      wishes: [],
    },
    actions: parseJson(row.actions, {}),
    created_at: row.created_at || '',
  };
}

function getSetting(key) {
  const row = one('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

function setSetting(key, value) {
  if (value == null || value === '') {
    run('DELETE FROM settings WHERE key = ?', [key]);
  } else {
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    );
  }
  persist();
}

function getProfileRowById(id) {
  if (!id) return null;
  return one('SELECT * FROM profiles WHERE id = ?', [id]);
}

function getDemoRow() {
  return one('SELECT * FROM profiles WHERE is_demo = 1 ORDER BY created_at ASC LIMIT 1');
}

function seedDemoIfNeeded() {
  const count = one('SELECT COUNT(*) AS n FROM profiles');
  if (count && Number(count.n) > 0) return;
  if (!fs.existsSync(SEED_PATH)) return;
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const now = new Date().toISOString();
  run(
    `INSERT INTO profiles
       (id, parent_name, child_name, grade, class_name, school_name, priorities, nudge_style, actions, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      crypto.randomUUID(),
      (seed.parent && seed.parent.name) || 'Alex Rivera',
      (seed.child && seed.child.name) || 'Maya Rivera',
      (seed.child && seed.child.grade) || 'Grade 3',
      (seed.child && seed.child.class) || '3B',
      seed.school || 'Maple Grove Elementary',
      JSON.stringify((seed.soul && seed.soul.priorities) || []),
      (seed.soul && seed.soul.nudge_style) || 'one short message in the evening',
      JSON.stringify(seed.actions || {}),
      now,
    ]
  );
  persist();
}

async function initDb() {
  if (db) return;
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', file),
  });
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  run(`CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    parent_name TEXT NOT NULL,
    child_name TEXT NOT NULL,
    grade TEXT,
    class_name TEXT,
    school_name TEXT,
    priorities TEXT,
    nudge_style TEXT,
    actions TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT,
    url TEXT,
    username TEXT,
    secret TEXT,
    status TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(profile_id, type)
  )`);
  run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS gmail_tokens (
    profile_id TEXT PRIMARY KEY,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    updated_at TEXT
  )`);
  persist();
  seedDemoIfNeeded();
}

function getActiveProfile() {
  const activeId = getSetting('active_profile_id');
  const row = getProfileRowById(activeId) || null;
  return rowToProfile(row);
}

function getDemoProfile() {
  return rowToProfile(getDemoRow());
}

function getProfileForRun() {
  return getActiveProfile() || getDemoProfile();
}

function setActiveProfile(id) {
  setSetting('active_profile_id', id || null);
  return getActiveProfile();
}

function clearActiveProfile() {
  setSetting('active_profile_id', null);
}

function activateDemoProfile() {
  seedDemoIfNeeded();
  const demo = getDemoRow();
  if (!demo) return null;
  setSetting('active_profile_id', demo.id);
  return rowToProfile(demo);
}

function createProfile(input) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  run(
    `INSERT INTO profiles
       (id, parent_name, child_name, grade, class_name, school_name, priorities, nudge_style, actions, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      String(input.parent_name || '').trim(),
      String(input.child_name || '').trim(),
      String(input.grade || '').trim(),
      String(input.class_name || '').trim(),
      String(input.school_name || '').trim(),
      JSON.stringify(Array.isArray(input.priorities) ? input.priorities : []),
      String(input.nudge_style || 'one short message in the evening').trim(),
      JSON.stringify(input.actions && typeof input.actions === 'object' ? input.actions : {}),
      now,
    ]
  );
  setSetting('active_profile_id', id);
  persist();
  return rowToProfile(getProfileRowById(id));
}

function updateProfileActions(profileId, actions) {
  const row = getProfileRowById(profileId);
  if (!row) return null;
  run('UPDATE profiles SET actions = ? WHERE id = ?', [
    JSON.stringify(actions || {}),
    profileId,
  ]);
  persist();
  return rowToProfile(getProfileRowById(profileId));
}

function sanitizeSource(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    label: row.label || '',
    url: row.url || '',
    username: row.username || '',
    status: row.status || '',
  };
}

function listSources(profileId) {
  return all('SELECT * FROM sources WHERE profile_id = ? ORDER BY created_at ASC', [
    profileId,
  ]).map(sanitizeSource);
}

function saveSource(profileId, input) {
  const now = new Date().toISOString();
  const existing = one('SELECT * FROM sources WHERE profile_id = ? AND type = ?', [
    profileId,
    input.type,
  ]);
  if (existing) {
    run(
      'UPDATE sources SET label = ?, url = ?, username = ?, secret = ?, status = ? WHERE id = ?',
      [
        String(input.label || ''),
        String(input.url || ''),
        String(input.username || ''),
        String(input.secret || ''),
        String(input.status || 'saved'),
        existing.id,
      ]
    );
    persist();
    return sanitizeSource(one('SELECT * FROM sources WHERE id = ?', [existing.id]));
  }
  const id = crypto.randomUUID();
  run(
    `INSERT INTO sources (id, profile_id, type, label, url, username, secret, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      profileId,
      String(input.type || ''),
      String(input.label || ''),
      String(input.url || ''),
      String(input.username || ''),
      String(input.secret || ''),
      String(input.status || 'saved'),
      now,
    ]
  );
  persist();
  return sanitizeSource(one('SELECT * FROM sources WHERE id = ?', [id]));
}

function setSourceStatus(profileId, type, status, username) {
  const existing = one('SELECT * FROM sources WHERE profile_id = ? AND type = ?', [
    profileId,
    type,
  ]);
  const now = new Date().toISOString();
  if (existing) {
    run('UPDATE sources SET status = ?, username = COALESCE(NULLIF(?, \'\'), username) WHERE id = ?', [
      status,
      username || '',
      existing.id,
    ]);
  } else {
    run(
      `INSERT INTO sources (id, profile_id, type, label, url, username, secret, status, created_at)
       VALUES (?, ?, ?, 'Gmail', '', ?, '', ?, ?)`,
      [crypto.randomUUID(), profileId, type, username || '', status, now]
    );
  }
  persist();
}

function saveGmailTokens(profileId, tokens) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO gmail_tokens (profile_id, email, access_token, refresh_token, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       email = excluded.email,
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, gmail_tokens.refresh_token),
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
    [
      profileId,
      tokens.email || '',
      tokens.access_token || '',
      tokens.refresh_token || null,
      tokens.expires_at || 0,
      now,
    ]
  );
  persist();
}

function getGmailTokens(profileId) {
  if (!profileId) return null;
  return one('SELECT * FROM gmail_tokens WHERE profile_id = ?', [profileId]);
}

function deleteGmailTokens(profileId) {
  run('DELETE FROM gmail_tokens WHERE profile_id = ?', [profileId]);
  persist();
}

module.exports = {
  DB_PATH,
  initDb,
  getActiveProfile,
  getDemoProfile,
  getProfileForRun,
  setActiveProfile,
  clearActiveProfile,
  activateDemoProfile,
  createProfile,
  updateProfileActions,
  listSources,
  saveSource,
  setSourceStatus,
  saveGmailTokens,
  getGmailTokens,
  deleteGmailTokens,
  rowToProfile,
};
