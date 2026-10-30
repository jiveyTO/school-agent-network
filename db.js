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
const FACTS_SEED_PATH = path.join(ROOT, 'data', 'facts.json');
const DEMO_HUB_A_NAME = 'Grade 3 — Maple Grove Elementary';
const DEMO_HUB_B_NAME = 'U9 Hockey — Maple Grove';
const HOCKEY_FACTS = [
  { id: 'fact-u9-hockey-practice-2026-11-03', type: 'event', title: 'U9 Hockey practice', detail: 'Weekly practice at Maple Grove Arena, Rink 2.', date: '2026-11-03', time: '6:00 PM–7:00 PM', applies_to: 'U9 Hockey players', action_required: false, action: '', link: '', source_document: 'U9 Hockey — Maple Grove (fictional schedule)', source_text: 'Practice is Tuesday at 6:00 PM on Rink 2.', published_at: '2026-11-01T09:00:00.000Z', confidence: 0.98, group_label: 'Weekly schedule' },
  { id: 'fact-u9-hockey-skate-fitting-2026-11-04', type: 'event', title: 'Skate fitting', detail: 'Skate fitting at the arena pro shop before the season opener.', date: '2026-11-04', time: '4:30 PM–5:30 PM', applies_to: 'U9 Hockey players', action_required: true, action: 'Bring skates for fitting', link: '', source_document: 'U9 Hockey — Maple Grove (fictional schedule)', source_text: 'Skate fitting is Wednesday between 4:30 and 5:30 PM at the pro shop.', published_at: '2026-11-01T09:00:00.000Z', confidence: 0.97, group_label: 'Season prep' },
  { id: 'fact-u9-hockey-game-2026-11-06', type: 'event', title: 'U9 Hockey game', detail: 'Home game against the fictional Riverdale Rockets at Maple Grove Arena.', date: '2026-11-06', time: '6:30 PM–7:30 PM', applies_to: 'U9 Hockey players', action_required: false, action: '', link: '', source_document: 'U9 Hockey — Maple Grove (fictional schedule)', source_text: 'Our first home game is Friday at 6:30 PM against Riverdale.', published_at: '2026-11-01T09:00:00.000Z', confidence: 0.99, group_label: 'Games' },
  { id: 'fact-u9-hockey-photo-day-2026-11-14', type: 'event', title: 'Team photo day', detail: 'Team photos in full uniform at Maple Grove Arena.', date: '2026-11-14', time: '10:00 AM–11:00 AM', applies_to: 'U9 Hockey players', action_required: true, action: 'Wear full uniform for photos', link: '', source_document: 'U9 Hockey — Maple Grove (fictional schedule)', source_text: 'Team photo day is Saturday, November 14 at 10:00 AM. Wear your full uniform.', published_at: '2026-11-01T09:00:00.000Z', confidence: 0.98, group_label: 'Team photo' },
  { id: 'fact-u9-hockey-snack-schedule', type: 'announcement', title: 'Team snack schedule posted', detail: 'The rotating snack schedule is posted at the arena. No action needed tonight.', date: '', time: '', applies_to: 'U9 Hockey players', action_required: false, action: '', link: '', source_document: 'U9 Hockey — Maple Grove (fictional schedule)', source_text: 'The team snack schedule is posted at the arena.', published_at: '2026-11-01T09:00:00.000Z', confidence: 0.95, group_label: 'Team snacks', group_summary: 'Team snack schedule is posted at the arena.' },
];
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

function getChildren(profileId) {
  if (!db || !profileId) return [];
  try {
    return all('SELECT * FROM children WHERE profile_id = ? ORDER BY created_at ASC', [
      profileId,
    ]).map((r) => ({
      id: r.id,
      name: r.name || '',
      grade: r.grade || '',
      class: r.class_name || '',
    }));
  } catch {
    return [];
  }
}

function rowToProfile(row) {
  if (!row) return null;
  const children = getChildren(row.id);
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
    children: children.length
      ? children
      : [{ name: row.child_name || '', grade: row.grade || '', class: row.class_name || '' }],
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
  run(`CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    name TEXT,
    grade TEXT,
    class_name TEXT,
    created_at TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS hubs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0
  )`);
  run(`CREATE TABLE IF NOT EXISTS hub_members (
    hub_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    role TEXT,
    joined_via TEXT,
    joined_at TEXT,
    PRIMARY KEY (hub_id, profile_id)
  )`);
  run(`CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  )`);
  run(`CREATE TABLE IF NOT EXISTS join_requests (
    id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    status TEXT,
    created_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL,
    uploaded_by TEXT,
    kind TEXT,
    title TEXT,
    raw_text TEXT,
    created_at TEXT NOT NULL,
    status TEXT,
    scope TEXT,
    scope_value TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    hub_id TEXT,
    material_id TEXT,
    type TEXT,
    title TEXT,
    detail TEXT,
    date TEXT,
    time TEXT,
    applies_to TEXT,
    action_required INTEGER,
    action TEXT,
    link TEXT,
    source_document TEXT,
    source_text TEXT,
    published_at TEXT,
    extracted_at TEXT,
    confidence REAL,
    supersedes TEXT,
    scope TEXT,
    scope_value TEXT,
    group_label TEXT,
    group_summary TEXT
  )`);
  persist();
  seedDemoIfNeeded();
  migrateChildren();
  rebuildSourcesWithoutCredentials();
  addColumnIfMissing('materials', 'scope', "scope TEXT DEFAULT 'school'");
  addColumnIfMissing('materials', 'scope_value', "scope_value TEXT DEFAULT ''");
  addColumnIfMissing('facts', 'scope', "scope TEXT DEFAULT 'school'");
  addColumnIfMissing('facts', 'scope_value', "scope_value TEXT DEFAULT ''");
  addColumnIfMissing('facts', 'group_label', "group_label TEXT DEFAULT ''");
  addColumnIfMissing('facts', 'group_summary', "group_summary TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'sport', "sport TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'level', "level TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'school_key', "school_key TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'school_name', "school_name TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'city', "city TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'province', "province TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'country', "country TEXT DEFAULT ''");
  backfillSchoolKeys();
  persist();
  seedDemoHubs();
  restampDemoFactScopes();
  backfillSeedGroups();
}

function migrateChildren() {
  const profiles = all('SELECT * FROM profiles');
  const now = new Date().toISOString();
  for (const p of profiles) {
    const existing = one('SELECT id FROM children WHERE profile_id = ? LIMIT 1', [p.id]);
    if (!existing) {
      run(
        'INSERT INTO children (id, profile_id, name, grade, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), p.id, p.child_name || '', p.grade || '', p.class_name || '', p.created_at || now]
      );
    }
  }
  persist();
}

function tableColumns(table) {
  return all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

function addColumnIfMissing(table, column, ddl) {
  if (!tableColumns(table).includes(column)) {
    run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

const SCHOOL_WORD_EXPANSIONS = {
  st: 'saint',
  ste: 'sainte',
  ces: 'catholic elementary school',
  css: 'catholic secondary school',
  joe: 'joseph',
  mike: 'michael',
  nick: 'nicholas',
  chris: 'christopher',
  liz: 'elizabeth',
};

function normalizeSchoolName(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => (SCHOOL_WORD_EXPANSIONS[t] || t).split(' '));
  return tokens.join(' ');
}

function normalizeCityName(city) {
  return String(city || '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PROVINCE_ALIASES = {
  on: 'ontario',
  ont: 'ontario',
  qc: 'quebec',
  que: 'quebec',
  bc: 'british columbia',
  co: 'colorado',
  colo: 'colorado',
  il: 'illinois',
  ill: 'illinois',
};

const COUNTRY_ALIASES = {
  ca: 'canada',
  can: 'canada',
  us: 'united states',
  usa: 'united states',
  'u s a': 'united states',
  'united states of america': 'united states',
};

function normalizeRegion(value, aliases) {
  const base = String(value || '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return aliases[base] || base;
}

function normalizeProvince(province) {
  return normalizeRegion(province, PROVINCE_ALIASES);
}

function normalizeCountry(country) {
  return normalizeRegion(country, COUNTRY_ALIASES);
}

function schoolKey(schoolName, city, province, country) {
  return [
    normalizeSchoolName(schoolName),
    normalizeCityName(city),
    normalizeProvince(province),
    normalizeCountry(country),
  ].join('|');
}

function regionMatches(want, have) {
  return want === '' || have === '' || want === have;
}

function splitComposedName(name) {
  const text = String(name || '').trim();
  const idx = text.lastIndexOf('—');
  if (idx === -1) return { school_name: text, city: '' };
  return { school_name: text.slice(0, idx).trim(), city: text.slice(idx + 1).trim() };
}

function backfillSchoolKeys() {
  const rows = all("SELECT id, name, school_name, city, province, country FROM hubs WHERE kind = 'school'");
  for (const row of rows) {
    let schoolName = row.school_name;
    let city = row.city;
    if (!schoolName) {
      const parts = splitComposedName(row.name);
      schoolName = parts.school_name;
      city = parts.city || '';
    }
    run('UPDATE hubs SET school_name = ?, city = ?, school_key = ? WHERE id = ?', [
      schoolName || '',
      city || '',
      schoolKey(schoolName, city, row.province, row.country),
      row.id,
    ]);
  }
}

function schoolNameTokens(schoolName) {
  return new Set(normalizeSchoolName(schoolName).split(' ').filter(Boolean));
}

function tokenSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function isSubset(a, b) {
  if (!a.size || !b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

function normalizeGrade(value) {
  const m = /(\d{1,2})/.exec(String(value || ''));
  return m ? Number(m[1]) : null;
}

function normalizeClass(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^class\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

function gradeMatchesScope(scopeValue, childGrade) {
  const a = String(scopeValue || '').trim().toLowerCase();
  const b = String(childGrade || '').trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const childNum = normalizeGrade(b);
  if (childNum == null) return false;
  const range = /(\d{1,2})\s*-\s*(\d{1,2})/.exec(a);
  if (range) {
    return childNum >= Number(range[1]) && childNum <= Number(range[2]);
  }
  return normalizeGrade(a) === childNum;
}

function profileScopeSets(profileId) {
  const kids = getChildren(profileId);
  return {
    grades: kids.map((k) => k.grade || '').filter(Boolean),
    classes: kids.map((k) => normalizeClass(k.class)).filter(Boolean),
  };
}

function rowInScope(row, sets) {
  const scope = String((row && row.scope) || 'school').toLowerCase();
  if (scope === '' || scope === 'school') return true;
  const value = row.scope_value || '';
  if (scope === 'grade') {
    return sets.grades.some((g) => gradeMatchesScope(value, g));
  }
  if (scope === 'class') {
    const want = normalizeClass(value);
    return want !== '' && sets.classes.includes(want);
  }
  return true;
}

function rebuildSourcesWithoutCredentials() {
  const cols = tableColumns('sources');
  if (!cols.includes('username') && !cols.includes('secret')) return;
  run(`CREATE TABLE IF NOT EXISTS sources_new (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT,
    url TEXT,
    status TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(profile_id, type)
  )`);
  run(
    'INSERT OR IGNORE INTO sources_new (id, profile_id, type, label, url, status, created_at) SELECT id, profile_id, type, label, url, status, created_at FROM sources'
  );
  run('DROP TABLE sources');
  run('ALTER TABLE sources_new RENAME TO sources');
  persist();
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
  const kids = Array.isArray(input.children) && input.children.length
    ? input.children
    : [{ name: input.child_name, grade: input.grade, class: input.class_name }];
  for (const kid of kids) {
    run(
      'INSERT INTO children (id, profile_id, name, grade, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), id, String(kid.name || ''), String(kid.grade || ''), String(kid.class || kid.class_name || ''), now]
    );
  }
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
    status: row.status || '',
  };
}

function listSources(profileId) {
  return all('SELECT * FROM sources WHERE profile_id = ? ORDER BY created_at ASC', [
    profileId,
  ]).map(sanitizeSource);
}

function saveSource(profileId, input) {
  // Bookmarks only: any username/password/secret fields sent are ignored.
  const now = new Date().toISOString();
  const existing = one('SELECT * FROM sources WHERE profile_id = ? AND type = ?', [
    profileId,
    input.type,
  ]);
  if (existing) {
    run('UPDATE sources SET label = ?, url = ?, status = ? WHERE id = ?', [
      String(input.label || ''),
      String(input.url || ''),
      String(input.status || 'saved'),
      existing.id,
    ]);
    persist();
    return sanitizeSource(one('SELECT * FROM sources WHERE id = ?', [existing.id]));
  }
  const id = crypto.randomUUID();
  run(
    `INSERT INTO sources (id, profile_id, type, label, url, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      profileId,
      String(input.type || ''),
      String(input.label || ''),
      String(input.url || ''),
      String(input.status || 'saved'),
      now,
    ]
  );
  persist();
  return sanitizeSource(one('SELECT * FROM sources WHERE id = ?', [id]));
}

function setSourceStatus(profileId, type, status) {
  const existing = one('SELECT * FROM sources WHERE profile_id = ? AND type = ?', [
    profileId,
    type,
  ]);
  const now = new Date().toISOString();
  if (existing) {
    run('UPDATE sources SET status = ? WHERE id = ?', [status, existing.id]);
  } else {
    run(
      `INSERT INTO sources (id, profile_id, type, label, url, status, created_at)
       VALUES (?, ?, ?, 'Gmail', '', ?, ?)`,
      [crypto.randomUUID(), profileId, type, status, now]
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

function rowToHub(row) {
  if (!row) return null;
  const countRow = one('SELECT COUNT(*) AS n FROM hub_members WHERE hub_id = ?', [row.id]);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind || 'other',
    school_name: row.school_name || '',
    city: row.city || '',
    province: row.province || '',
    country: row.country || '',
    sport: row.sport || '',
    level: row.level || '',
    created_by: row.created_by || '',
    created_at: row.created_at,
    is_demo: Boolean(row.is_demo),
    member_count: countRow ? Number(countRow.n) : 0,
    memberCount: countRow ? Number(countRow.n) : 0,
  };
}

function getHubRow(id) {
  return id ? one('SELECT * FROM hubs WHERE id = ?', [id]) : null;
}

function getHub(id) {
  return rowToHub(getHubRow(id));
}

function getMaterialText(materialId, profileId) {
  const row = materialId ? one('SELECT * FROM materials WHERE id = ?', [materialId]) : null;
  if (!row) return null;
  if (profileId && !rowInScope(row, profileScopeSets(profileId))) return null;
  return { id: row.id, hub_id: row.hub_id, kind: row.kind, title: row.title, text: row.raw_text || '' };
}

function deleteHub(hubId) {
  if (!hubId) return false;
  if (!getHubRow(hubId)) return false;
  run('DELETE FROM facts WHERE hub_id = ?', [hubId]);
  run('DELETE FROM materials WHERE hub_id = ?', [hubId]);
  run('DELETE FROM hub_members WHERE hub_id = ?', [hubId]);
  run('DELETE FROM invites WHERE hub_id = ?', [hubId]);
  run('DELETE FROM join_requests WHERE hub_id = ?', [hubId]);
  run('DELETE FROM hubs WHERE id = ?', [hubId]);
  persist();
  return true;
}

function conflictPayload(row) {
  const hub = rowToHub(row);
  const founder = getProfileRowById(row.created_by);
  return {
    id: hub.id,
    name: hub.name,
    province: row.province || '',
    country: row.country || '',
    member_count: hub.member_count,
    founder_first_name: founder ? String(founder.parent_name || '').trim().split(' ')[0] : '',
  };
}

function rowSchoolParts(row) {
  if (row.school_name) {
    return { school_name: row.school_name, city: row.city || '', province: row.province || '', country: row.country || '' };
  }
  const parts = splitComposedName(row.name);
  return { school_name: parts.school_name, city: parts.city || row.city || '', province: row.province || '', country: row.country || '' };
}

function findSchoolHubConflict(schoolName, city, province, country) {
  if (normalizeSchoolName(schoolName) === '') return null;
  const want = {
    school: normalizeSchoolName(schoolName),
    city: normalizeCityName(city),
    province: normalizeProvince(province),
    country: normalizeCountry(country),
  };
  let best = null;
  let bestScore = 0;
  const rows = all("SELECT * FROM hubs WHERE kind = 'school'");
  for (const row of rows) {
    const parts = rowSchoolParts(row);
    const have = {
      school: normalizeSchoolName(parts.school_name),
      city: normalizeCityName(parts.city),
      province: normalizeProvince(parts.province),
      country: normalizeCountry(parts.country),
    };
    if (have.school !== want.school || have.city !== want.city) continue;
    if (!regionMatches(want.province, have.province)) continue;
    if (!regionMatches(want.country, have.country)) continue;
    return { match_type: 'exact', ...conflictPayload(row) };
  }
  const wantTokens = schoolNameTokens(schoolName);
  if (!wantTokens.size) return null;
  for (const row of rows) {
    const parts = rowSchoolParts(row);
    if (normalizeCityName(parts.city) !== want.city) continue;
    if (!regionMatches(want.province, normalizeProvince(parts.province))) continue;
    if (!regionMatches(want.country, normalizeCountry(parts.country))) continue;
    const rowTokens = schoolNameTokens(parts.school_name);
    const score = tokenSimilarity(wantTokens, rowTokens);
    const near = score >= 0.5 || isSubset(wantTokens, rowTokens) || isSubset(rowTokens, wantTokens);
    if (near && score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  if (best) return { match_type: 'similar', ...conflictPayload(best) };
  return null;
}

function getDemoHub() {
  return rowToHub(one('SELECT * FROM hubs WHERE is_demo = 1 AND name = ? LIMIT 1', [DEMO_HUB_A_NAME]));
}

function addMember(hubId, profileId, role, joinedVia) {
  run(
    'INSERT OR IGNORE INTO hub_members (hub_id, profile_id, role, joined_via, joined_at) VALUES (?, ?, ?, ?, ?)',
    [hubId, profileId, role || 'member', joinedVia || 'invite', new Date().toISOString()]
  );
  persist();
}

function isMember(hubId, profileId) {
  if (!hubId || !profileId) return false;
  return Boolean(one('SELECT hub_id FROM hub_members WHERE hub_id = ? AND profile_id = ?', [hubId, profileId]));
}

function getMemberRole(hubId, profileId) {
  const row = one('SELECT role FROM hub_members WHERE hub_id = ? AND profile_id = ?', [hubId, profileId]);
  return row ? row.role : null;
}

function createHub(profileId, name, kind, extra) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const kinds = ['school', 'team', 'activity', 'other'];
  const cleanKind = kinds.includes(kind) ? kind : 'other';
  let schoolName = '';
  let city = '';
  let province = '';
  let country = '';
  let sport = '';
  let level = '';
  if (cleanKind === 'school') {
    if (extra && (extra.school_name || extra.city || extra.province || extra.country)) {
      schoolName = String(extra.school_name || '').trim();
      city = String(extra.city || '').trim();
      province = String(extra.province || '').trim();
      country = String(extra.country || '').trim();
    } else {
      const parts = splitComposedName(name);
      schoolName = parts.school_name;
      city = parts.city;
    }
  } else if (cleanKind === 'team' && extra) {
    sport = String(extra.sport || '').trim();
    level = String(extra.level || '').trim();
  }
  run('INSERT INTO hubs (id, name, kind, school_key, school_name, city, province, country, sport, level, created_by, created_at, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)', [
    id,
    String(name || '').trim(),
    cleanKind,
    cleanKind === 'school' ? schoolKey(schoolName, city, province, country) : '',
    schoolName,
    city,
    province,
    country,
    sport,
    level,
    profileId,
    now,
  ]);
  run('INSERT INTO hub_members (hub_id, profile_id, role, joined_via, joined_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    profileId,
    'admin',
    'founder',
    now,
  ]);
  persist();
  return { ...getHub(id), role: 'admin' };
}

function listHubsForProfile(profileId) {
  if (!profileId) return [];
  return all(
    `SELECT h.*, m.role AS my_role FROM hubs h
     JOIN hub_members m ON m.hub_id = h.id
     WHERE m.profile_id = ? ORDER BY h.created_at ASC`,
    [profileId]
  ).map((r) => ({ ...rowToHub(r), role: r.my_role }));
}

function createInvite(hubId, profileId) {
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO invites (token, hub_id, created_by, created_at, revoked) VALUES (?, ?, ?, ?, 0)', [
    token,
    hubId,
    profileId,
    new Date().toISOString(),
  ]);
  persist();
  return token;
}

function getInvite(token) {
  if (!token) return null;
  const invite = one('SELECT * FROM invites WHERE token = ?', [token]);
  if (!invite || Number(invite.revoked)) return null;
  const hub = getHubRow(invite.hub_id);
  if (!hub) return null;
  const inviter = getProfileRowById(invite.created_by);
  const countRow = one('SELECT COUNT(*) AS n FROM hub_members WHERE hub_id = ?', [hub.id]);
  return {
    hub_name: hub.name,
    hubName: hub.name,
    kind: hub.kind || 'other',
    inviter_first_name: inviter ? String(inviter.parent_name || '').trim().split(' ')[0] : '',
    member_count: countRow ? Number(countRow.n) : 0,
    hub_id: hub.id,
  };
}

function revokeInvite(hubId, token) {
  run('UPDATE invites SET revoked = 1 WHERE hub_id = ? AND token = ?', [hubId, token]);
  persist();
}

function createJoinRequest(hubId, profileId) {
  const pending = one(
    "SELECT * FROM join_requests WHERE hub_id = ? AND profile_id = ? AND status = 'pending'",
    [hubId, profileId]
  );
  if (pending) return pending;
  const id = crypto.randomUUID();
  run(
    'INSERT INTO join_requests (id, hub_id, profile_id, status, created_at, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
    [id, hubId, profileId, 'pending', new Date().toISOString()]
  );
  persist();
  return one('SELECT * FROM join_requests WHERE id = ?', [id]);
}

function listJoinRequests(hubId) {
  return all(
    `SELECT r.*, p.parent_name, p.child_name FROM join_requests r
     JOIN profiles p ON p.id = r.profile_id
     WHERE r.hub_id = ? ORDER BY r.created_at ASC`,
    [hubId]
  ).map((r) => ({
    id: r.id,
    hub_id: r.hub_id,
    profile_id: r.profile_id,
    status: r.status,
    created_at: r.created_at,
    decided_by: r.decided_by || '',
    decided_at: r.decided_at || '',
    parent_name: r.parent_name || '',
    child_name: r.child_name || '',
  }));
}

function decideJoinRequest(hubId, requestId, adminId, approve) {
  const req = one('SELECT * FROM join_requests WHERE hub_id = ? AND id = ?', [hubId, requestId]);
  if (!req) return null;
  run('UPDATE join_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [
    approve ? 'approved' : 'declined',
    adminId,
    new Date().toISOString(),
    requestId,
  ]);
  if (approve) {
    run(
      'INSERT OR IGNORE INTO hub_members (hub_id, profile_id, role, joined_via, joined_at) VALUES (?, ?, ?, ?, ?)',
      [hubId, req.profile_id, 'member', 'request', new Date().toISOString()]
    );
  }
  persist();
  return one('SELECT * FROM join_requests WHERE id = ?', [requestId]);
}

function createMaterial(hubId, uploadedBy, kind, title, rawText, status, scope, scopeValue) {
  const id = crypto.randomUUID();
  run(
    'INSERT INTO materials (id, hub_id, uploaded_by, kind, title, raw_text, created_at, status, scope, scope_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, hubId, uploadedBy || '', kind || 'paste', title || '', rawText || '', new Date().toISOString(), status || 'stored', scope || 'school', scopeValue || '']
  );
  persist();
  return one('SELECT * FROM materials WHERE id = ?', [id]);
}

function updateMaterialScope(id, scope, scopeValue) {
  run('UPDATE materials SET scope = ?, scope_value = ? WHERE id = ?', [scope || 'school', scopeValue || '', id]);
  persist();
}

function getMaterial(id) {
  return id ? one('SELECT * FROM materials WHERE id = ?', [id]) : null;
}

function findMaterial(hubId, title) {
  return one('SELECT * FROM materials WHERE hub_id = ? AND title = ? ORDER BY created_at ASC LIMIT 1', [hubId, title]);
}

function updateMaterialStatus(id, status) {
  run('UPDATE materials SET status = ? WHERE id = ?', [status, id]);
  persist();
}

function listMaterials(hubId, profileId) {
  const rows = all('SELECT id, hub_id, uploaded_by, kind, title, created_at, status, scope, scope_value FROM materials WHERE hub_id = ? ORDER BY created_at ASC', [hubId]).map(scopedMaterialRow);
  if (!profileId) return rows;
  return rows.filter((m) => rowInScope(m, profileScopeSets(profileId)));
}

function restampDemoFactScopes() {
  // School newsletter items default to school scope; stamp one grade and one
  // class item so audience filtering is visible when switching profiles.
  try {
    run("UPDATE facts SET scope = 'grade', scope_value = 'Grades 3-8' WHERE type != '' AND title LIKE 'Remembrance Assembly%' AND (scope IS NULL OR scope = '' OR scope = 'school')");
  } catch {
    // Facts table may not exist yet on a brand-new install.
  }
  try {
    run("UPDATE facts SET scope = 'class', scope_value = '3B' WHERE title LIKE 'Each homeroom collects for 2 students%' AND (scope IS NULL OR scope = '' OR scope = 'school')");
  } catch {
    // Facts table may not exist yet on a brand-new install.
  }
  persist();
}

function backfillSeedGroups() {
  // Stamp newsletter sections onto seed facts that predate group_label.
  // Never overwrites values the extraction already set.
  try {
    if (!fs.existsSync(FACTS_SEED_PATH)) return;
    const seedFacts = JSON.parse(fs.readFileSync(FACTS_SEED_PATH, 'utf8'));
    const wanted = [];
    for (const f of seedFacts || []) {
      if (f && f.id && (f.group_label || f.group_summary)) wanted.push(f);
    }
    for (const f of HOCKEY_FACTS) {
      if (f && f.id && (f.group_label || f.group_summary)) wanted.push(f);
    }
    for (const f of wanted) {
      run(
        "UPDATE facts SET group_label = COALESCE(NULLIF(group_label, ''), ?), group_summary = COALESCE(NULLIF(group_summary, ''), ?) WHERE id = ?",
        [String(f.group_label || ''), String(f.group_summary || ''), String(f.id)]
      );
    }
    persist();
  } catch {
    // Seed file stays the source; grouping can always come from extraction.
  }
}

function factRowToObject(r) {
  return {
    id: r.id,
    hub_id: r.hub_id || '',
    material_id: r.material_id || '',
    type: r.type,
    title: r.title,
    detail: r.detail || '',
    date: r.date || '',
    time: r.time || '',
    applies_to: r.applies_to || '',
    action_required: Boolean(r.action_required),
    action: r.action || '',
    link: r.link || '',
    source_document: r.source_document || '',
    source_text: r.source_text || '',
    published_at: r.published_at || '',
    extracted_at: r.extracted_at || '',
    confidence: typeof r.confidence === 'number' ? r.confidence : Number(r.confidence || 0),
    supersedes: r.supersedes || '',
    scope: r.scope || 'school',
    scope_value: r.scope_value || '',
    group_label: r.group_label || '',
    group_summary: r.group_summary || '',
  };
}

function scopedMaterialRow(r) {
  return {
    id: r.id,
    hub_id: r.hub_id,
    kind: r.kind,
    title: r.title,
    created_at: r.created_at,
    status: r.status,
    scope: r.scope || 'school',
    scope_value: r.scope_value || '',
  };
}

function insertFacts(hubId, materialId, facts, replaceMaterialFacts) {
  if (replaceMaterialFacts && materialId) {
    run('DELETE FROM facts WHERE material_id = ?', [materialId]);
  }
  for (const f of facts || []) {
    const derived = f.scope && ['school', 'grade', 'class'].includes(String(f.scope).toLowerCase())
      ? { scope: String(f.scope).toLowerCase(), value: f.scope_value || '' }
      : deriveScope(f);
    run(
      `INSERT OR REPLACE INTO facts
       (id, hub_id, material_id, type, title, detail, date, time, applies_to, action_required, action, link, source_document, source_text, published_at, extracted_at, confidence, supersedes, scope, scope_value, group_label, group_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        f.id, hubId, materialId || '', f.type, f.title, f.detail || '', f.date || '', f.time || '',
        f.applies_to || '', f.action_required ? 1 : 0, f.action || '', f.link || '',
        f.source_document || '', f.source_text || '', f.published_at || '', f.extracted_at || '',
        typeof f.confidence === 'number' ? f.confidence : 0, f.supersedes || '',
        derived.scope, derived.value, f.group_label || '', f.group_summary || '',
      ]
    );
  }
  persist();
  return (facts || []).length;
}

function deriveScope(fact) {
  const text = String((fact && fact.applies_to) || '');
  const classMatch = /\bclass\s+([A-Za-z0-9]+)\b/i.exec(text);
  if (classMatch && !/^es$/i.test(classMatch[1])) {
    return { scope: 'class', value: classMatch[1].toUpperCase() };
  }
  const gradeMatch = /\bgrades?\s*\d{1,2}(?:\s*-\s*\d{1,2})?\b/i.exec(text);
  if (gradeMatch) {
    const canonical = gradeMatch[0].replace(/\s+/g, ' ').trim();
    return {
      scope: 'grade',
      value: canonical.charAt(0).toUpperCase() + canonical.slice(1),
    };
  }
  return { scope: 'school', value: '' };
}

function listFacts(hubId, profileId) {
  const rows = all('SELECT * FROM facts WHERE hub_id = ? ORDER BY date ASC, title ASC', [hubId]).map(factRowToObject);
  if (!profileId) return rows;
  return rows.filter((f) => rowInScope(f, profileScopeSets(profileId)));
}

function listFactsForProfile(profileId) {
  if (!profileId) return [];
  return all(
    `SELECT f.*, h.name AS hub_name FROM facts f
     JOIN hubs h ON h.id = f.hub_id
     JOIN hub_members m ON m.hub_id = h.id AND m.profile_id = ?
     ORDER BY f.date ASC, f.title ASC`,
    [profileId]
  )
    .map((r) => ({ ...factRowToObject(r), hub_name: r.hub_name, hub: r.hub_name }))
    .filter((f) => rowInScope(f, profileScopeSets(profileId)));
}

function ensureHub(name, kind, createdBy, isDemo) {
  const existing = one('SELECT * FROM hubs WHERE name = ? LIMIT 1', [name]);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const parts = kind === 'school' ? splitComposedName(name) : { school_name: '', city: '' };
  run('INSERT INTO hubs (id, name, kind, school_key, school_name, city, province, country, created_by, created_at, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id, name, kind, kind === 'school' ? schoolKey(parts.school_name, parts.city, '', '') : '', parts.school_name, parts.city, '', '', createdBy, new Date().toISOString(), isDemo ? 1 : 0,
  ]);
  return one('SELECT * FROM hubs WHERE id = ?', [id]);
}

function seedDemoHubs() {
  const demo = getDemoRow();
  if (!demo) return;
  const now = new Date().toISOString();
  const hubA = ensureHub(DEMO_HUB_A_NAME, 'school', demo.id, 1);
  addMember(hubA.id, demo.id, 'admin', 'founder');

  let materialA = findMaterial(hubA.id, 'Maple Grove newsletter (mock)');
  if (!materialA) {
    const raw = fs.existsSync(path.join(ROOT, 'data', 'mock-newsletter.txt'))
      ? fs.readFileSync(path.join(ROOT, 'data', 'mock-newsletter.txt'), 'utf8')
      : '';
    materialA = createMaterial(hubA.id, demo.id, 'paste', 'Maple Grove newsletter (mock)', raw, 'extracted');
  }
  const countA = one('SELECT COUNT(*) AS n FROM facts WHERE hub_id = ?', [hubA.id]);
  if ((!countA || Number(countA.n) === 0) && fs.existsSync(FACTS_SEED_PATH)) {
    try {
      const seedFacts = JSON.parse(fs.readFileSync(FACTS_SEED_PATH, 'utf8'));
      if (Array.isArray(seedFacts)) insertFacts(hubA.id, materialA.id, seedFacts, false);
    } catch {
      // facts.json stays on disk as the seed source; a School run can refill the hub.
    }
  }

  const hubB = ensureHub(DEMO_HUB_B_NAME, 'team', demo.id, 1);
  addMember(hubB.id, demo.id, 'member', 'founder');
  let materialB = findMaterial(hubB.id, 'U9 Hockey — Fall schedule (fictional)');
  if (!materialB) {
    materialB = createMaterial(
      hubB.id, demo.id, 'paste', 'U9 Hockey — Fall schedule (fictional)',
      HOCKEY_FACTS.map((f) => f.source_text).join('\n'), 'extracted'
    );
    insertFacts(hubB.id, materialB.id, HOCKEY_FACTS.map((f) => ({ ...f, extracted_at: now, supersedes: '' })), false);
  }

  let sam = one('SELECT * FROM profiles WHERE parent_name = ? LIMIT 1', ['Sam Chen']);
  if (!sam) {
    const samId = crypto.randomUUID();
    run(
      `INSERT INTO profiles (id, parent_name, child_name, grade, class_name, school_name, priorities, nudge_style, actions, is_demo, created_at)
       VALUES (?, 'Sam Chen', 'Leo Chen', 'Grade 3', '3B', 'Maple Grove Elementary', ?, 'one short message in the evening', ?, 1, ?)`,
      [samId, JSON.stringify(['never miss a food-order deadline']), JSON.stringify({}), now]
    );
    run('INSERT INTO children (id, profile_id, name, grade, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      crypto.randomUUID(), samId, 'Leo Chen', 'Grade 3', '3B', now,
    ]);
    sam = one('SELECT * FROM profiles WHERE id = ?', [samId]);
  }
  const pending = one(
    "SELECT id FROM join_requests WHERE hub_id = ? AND profile_id = ? AND status = 'pending' LIMIT 1",
    [hubA.id, sam.id]
  );
  if (!pending) {
    const anyReq = one('SELECT id FROM join_requests WHERE hub_id = ? AND profile_id = ? LIMIT 1', [hubA.id, sam.id]);
    if (!anyReq) {
      run(
        'INSERT INTO join_requests (id, hub_id, profile_id, status, created_at, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
        [crypto.randomUUID(), hubA.id, sam.id, 'pending', now]
      );
    }
  }
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
  getChildren,
  getHub,
  getDemoHub,
  normalizeSchoolName,
  normalizeCityName,
  normalizeProvince,
  normalizeCountry,
  schoolKey,
  splitComposedName,
  findSchoolHubConflict,
  addMember,
  isMember,
  getMemberRole,
  createHub,
  deleteHub,
  listHubsForProfile,
  createInvite,
  getInvite,
  revokeInvite,
  createJoinRequest,
  listJoinRequests,
  decideJoinRequest,
  createMaterial,
  getMaterial,
  getMaterialText,
  findMaterial,
  updateMaterialStatus,
  updateMaterialScope,
  listMaterials,
  insertFacts,
  listFacts,
  listFactsForProfile,
};
