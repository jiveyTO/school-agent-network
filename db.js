// Small SQLite store for profiles, sources, settings, and Gmail tokens.
// Uses sql.js (WASM SQLite) so there is no native build step on node:20-alpine.
// All database access for the app goes through this module.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { isSameEvent, sameScope, mergeFactPair } = require('./event-dedupe');

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
// Fictional school website shown on the demo hub's Sources section (reserved
// .example.com domain, never a real school's address).
const DEMO_SCHOOL_WEBSITE = 'https://maplegrove-elementary.example.com';
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

// Durable database backing for the hosted copy (env-gated).
// Local and docker runs leave APP_DB_GCS_BUCKET unset, so the database stays
// a plain file exactly as before. When the bucket is set (Cloud Run), the
// database file is downloaded from Cloud Storage at boot when present
// (otherwise the local file/seed path below runs unchanged), and every
// persist is written back: debounced while serving, flushed on shutdown and
// at the end of boot. Auth uses the Cloud Run service account via the
// metadata server; plain fetch against the GCS JSON API, no new dependencies.
const DURABLE_UPLOAD_DEBOUNCE_MS = 1500;
let durableDirty = false;
let durableUploadTimer = null;
let durableToken = null;
let durableTokenExpiresAt = 0;
// Brief 036: a failed restore must never let a fresh seed overwrite the live
// database. Outcome of this boot's restore attempt: 'unattempted' (store
// disabled), 'absent' (no object existed, first boot may seed it), 'restored'
// (in-memory content is the stored object), or 'failed' (see below).
let durableRestoreOutcome = 'unattempted';
// Write-back is allowed only while this is true. Any restore failure, any
// refused upload, or any generation mismatch disables it for the rest of the
// boot, so a stale or seed-holding instance can never clobber the stored
// object. Degraded choice (brief 036): keep serving (seed or stale-local)
// with write-back hard-disabled and loud logs, rather than refusing traffic
// and crash-looping the demo on a transient storage blip.
let durableWriteBackEnabled = true;
let durableWriteBackRefusalLogged = false;
// Generation of the stored object observed at restore time. Uploads carry it
// as an ifGenerationMatch precondition so a stale instance loses with HTTP
// 412 instead of overwriting a newer object. Null when unknown (e.g. the
// storage stub in tests, or a metadata fetch that failed) — uploads then go
// without a precondition, exactly as before.
let durableRemoteGeneration = null;
let durableRemoteSize = null;

function durableConfig() {
  const bucket = (process.env.APP_DB_GCS_BUCKET || '').trim();
  if (!bucket) return null;
  const object = (process.env.APP_DB_GCS_OBJECT || 'app.db').trim() || 'app.db';
  const endpoint = (process.env.APP_DB_GCS_ENDPOINT || 'https://storage.googleapis.com').replace(
    /\/+$/,
    ''
  );
  return { bucket, object, endpoint };
}

function isDurableStoreEnabled() {
  return Boolean(durableConfig());
}

// One unambiguous boot line so the durable store state is never silent.
function durableStatusLine() {
  const cfg = durableConfig();
  if (cfg) return `durable store: ENGAGED (bucket="${cfg.bucket}" object="${cfg.object}")`;
  return 'durable store: DISABLED (APP_DB_GCS_BUCKET not set)';
}

async function durableAccessToken() {
  if (durableToken && Date.now() < durableTokenExpiresAt - 60000) return durableToken;
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) }
  );
  if (!res.ok) throw new Error('metadata token HTTP ' + res.status);
  const data = await res.json();
  if (!data || !data.access_token) throw new Error('metadata token missing access_token');
  durableToken = data.access_token;
  durableTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return durableToken;
}

function durableAuthHeaders() {
  // The test endpoint override (APP_DB_GCS_ENDPOINT) emulates GCS without auth.
  if (process.env.APP_DB_GCS_ENDPOINT) return Promise.resolve({});
  return durableAccessToken().then((token) => ({ Authorization: 'Bearer ' + token }));
}

// Fails the boot's restore loudly and disables write-back for the rest of
// the boot. The instance keeps serving (seed or stale-local) but NOTHING it
// holds may overwrite the stored object.
function durableRestoreFailed(cfg, reason) {
  durableRestoreOutcome = 'failed';
  durableWriteBackEnabled = false;
  console.warn(
    `DURABLE STORE RESTORE FAILED — WRITE-BACK DISABLED: ${reason} ` +
      `(bucket="${cfg.bucket}" object="${cfg.object}"). ` +
      'Serving without the hosted restore; local writes will NOT overwrite the stored object.'
  );
}

// The stored object is authoritative only when the bytes we downloaded are
// plausibly that object: non-empty, SQLite-shaped, and (when the metadata
// fetch told us the size) exactly the stored size. Anything else means the
// download is corrupt or truncated, and installing it — or later uploading a
// seed over the real object — would destroy data.
function durableDownloadedBytesValid(bytes) {
  if (!bytes || bytes.length === 0) return false;
  if (bytes.slice(0, 16).toString('binary') !== 'SQLite format 3\x00') return false;
  if (durableRemoteSize != null && bytes.length !== durableRemoteSize) return false;
  return true;
}

// Returns true when a database was restored. Never throws: on any failure
// the caller falls back to the local file/seed path — but with write-back
// disabled (see durableRestoreFailed), so the fallback seed can never
// overwrite the stored object.
async function restoreDurableStore() {
  const cfg = durableConfig();
  if (!cfg) {
    durableRestoreOutcome = 'unattempted';
    return false;
  }
  const objectPath =
    '/storage/v1/b/' + encodeURIComponent(cfg.bucket) + '/o/' + encodeURIComponent(cfg.object);
  try {
    const headers = await durableAuthHeaders();
    // Metadata first: distinguishes "no object yet" (first boot may seed it)
    // from "stored object exists" (a later failure must disable write-back).
    // Tolerated when it fails — the media fetch below still decides.
    try {
      const meta = await fetch(cfg.endpoint + objectPath, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (meta.status === 404) {
        durableRestoreOutcome = 'absent';
        return false;
      }
      if (meta.ok) {
        const info = await meta.json();
        if (info && info.generation != null) durableRemoteGeneration = String(info.generation);
        if (info && info.size != null && !Number.isNaN(Number(info.size))) {
          durableRemoteSize = Number(info.size);
        }
      }
    } catch {
      // Metadata is advisory only; the download below is authoritative.
    }
    const res = await fetch(cfg.endpoint + objectPath + '?alt=media', {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      durableRestoreOutcome = 'absent';
      return false;
    }
    if (!res.ok) {
      durableRestoreFailed(cfg, 'download HTTP ' + res.status);
      return false;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // Prefer the download's own generation stamp when the server sends one.
    const genHeader = res.headers && res.headers.get && res.headers.get('x-goog-generation');
    if (genHeader) durableRemoteGeneration = String(genHeader);
    if (!durableDownloadedBytesValid(bytes)) {
      durableRestoreFailed(
        cfg,
        `downloaded bytes failed validation (length=${bytes.length}` +
          (durableRemoteSize != null ? `, stored size=${durableRemoteSize}` : ', stored size unknown') +
          '): refusing to install them over the local database'
      );
      return false;
    }
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, bytes);
    durableRestoreOutcome = 'restored';
    durableWriteBackEnabled = true;
    return true;
  } catch (err) {
    durableRestoreFailed(cfg, err && err.message ? err.message : String(err));
    return false;
  }
}

async function durableUploadFromFile() {
  const cfg = durableConfig();
  if (!cfg || !durableDirty) return false;
  if (!fs.existsSync(DB_PATH)) return false;
  if (!durableWriteBackEnabled) {
    if (!durableWriteBackRefusalLogged) {
      durableWriteBackRefusalLogged = true;
      console.warn(
        'durable store: write-back disabled for this boot — local database will NOT be uploaded ' +
          `(bucket="${cfg.bucket}" object="${cfg.object}").`
      );
    }
    return false;
  }
  const headers = await durableAuthHeaders();
  headers['Content-Type'] = 'application/octet-stream';
  let url =
    cfg.endpoint +
    '/upload/storage/v1/b/' +
    encodeURIComponent(cfg.bucket) +
    '/o?uploadType=media&name=' +
    encodeURIComponent(cfg.object);
  // Optimistic concurrency: a restored instance may only overwrite the exact
  // generation it restored; a first-boot seed may only create the object when
  // nothing exists yet. A stale instance gets HTTP 412 and is disabled below.
  if (durableRemoteGeneration != null) {
    url += '&ifGenerationMatch=' + encodeURIComponent(durableRemoteGeneration);
  } else if (durableRestoreOutcome === 'absent') {
    url += '&ifGenerationMatch=0';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: fs.readFileSync(DB_PATH),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 412) {
    durableWriteBackEnabled = false;
    console.warn(
      `DURABLE STORE WRITE-BACK REFUSED — generation precondition failed (HTTP 412) ` +
        `(bucket="${cfg.bucket}" object="${cfg.object}"). ` +
        'The stored object changed under this instance; local writes will NOT overwrite it. WRITE-BACK DISABLED for the rest of this boot.'
    );
    return false;
  }
  if (!res.ok) throw new Error('upload HTTP ' + res.status);
  try {
    const body = await res.json();
    if (body && body.generation != null) durableRemoteGeneration = String(body.generation);
  } catch {
    // Upload succeeded; a missing generation in the reply just means the
    // next upload goes without a precondition.
  }
  return true;
}

function scheduleDurableUpload() {
  if (!durableConfig()) return;
  durableDirty = true;
  if (durableUploadTimer) return;
  durableUploadTimer = setTimeout(() => {
    durableUploadTimer = null;
    flushDurableStore();
  }, DURABLE_UPLOAD_DEBOUNCE_MS);
  if (durableUploadTimer.unref) durableUploadTimer.unref();
}

// Best-effort write-back of the latest database file. Never throws.
async function flushDurableStore() {
  if (durableUploadTimer) {
    clearTimeout(durableUploadTimer);
    durableUploadTimer = null;
  }
  if (!durableConfig() || !durableDirty) return false;
  try {
    const uploaded = await durableUploadFromFile();
    if (uploaded) durableDirty = false;
    return uploaded;
  } catch (err) {
    console.warn('durable store upload failed:', err && err.message ? err.message : err);
    return false;
  }
}

function persist() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  scheduleDurableUpload();
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
  const children = getChildren(row.id).map((c) => ({ id: c.id, name: c.name || '' }));
  if (!children.length && (row.child_name || '')) children.push({ name: row.child_name || '' });
  const firstName = (children[0] && children[0].name) || row.child_name || '';
  return {
    profile_id: row.id,
    id: row.id,
    is_demo: Boolean(row.is_demo),
    is_fictional_demo: Boolean(row.is_demo),
    school: '',
    parent: { name: row.parent_name || '', email: row.parent_email || '' },
    child: { name: firstName },
    children,
    email: row.parent_email || '',
    parent_email: row.parent_email || '',
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
  console.log(durableStatusLine());
  const restored = await restoreDurableStore();
  if (restored) console.log('durable store: database restored from hosted storage');
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', file),
  });
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  run(`CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    parent_name TEXT NOT NULL,
    parent_email TEXT DEFAULT '',
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
  run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    active_profile_id TEXT,
    google_sub TEXT,
    google_email TEXT,
    created_at TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS login_states (
    state TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS recovery_tokens (
    token_hash TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS recovery_rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
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
  run(`CREATE TABLE IF NOT EXISTS placements (
    hub_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    grade TEXT DEFAULT '',
    class_name TEXT DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (hub_id, child_id)
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
    scope_value TEXT,
    file_data BLOB,
    file_name TEXT,
    file_size INTEGER,
    file_mime TEXT,
    may_have_unread_pictures INTEGER DEFAULT 0,
    pictures_read_with_ocr INTEGER DEFAULT 0
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
  addColumnIfMissing('materials', 'file_data', 'file_data BLOB');
  addColumnIfMissing('materials', 'file_name', "file_name TEXT DEFAULT ''");
  addColumnIfMissing('materials', 'file_size', 'file_size INTEGER DEFAULT 0');
  addColumnIfMissing('materials', 'file_mime', "file_mime TEXT DEFAULT ''");
  addColumnIfMissing('materials', 'may_have_unread_pictures', 'may_have_unread_pictures INTEGER DEFAULT 0');
  addColumnIfMissing('materials', 'pictures_read_with_ocr', 'pictures_read_with_ocr INTEGER DEFAULT 0');
  addColumnIfMissing('facts', 'scope', "scope TEXT DEFAULT 'school'");
  addColumnIfMissing('facts', 'scope_value', "scope_value TEXT DEFAULT ''");
  addColumnIfMissing('facts', 'group_label', "group_label TEXT DEFAULT ''");
  addColumnIfMissing('facts', 'group_summary', "group_summary TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'sport', "sport TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'level', "level TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'website', "website TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'school_key', "school_key TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'school_name', "school_name TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'city', "city TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'province', "province TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'country', "country TEXT DEFAULT ''");
  addColumnIfMissing('profiles', 'parent_email', "parent_email TEXT DEFAULT ''");
  addColumnIfMissing('profiles', 'google_sub', "google_sub TEXT DEFAULT ''");
  addColumnIfMissing('profiles', 'google_email', "google_email TEXT DEFAULT ''");
  addColumnIfMissing('sessions', 'google_sub', "google_sub TEXT DEFAULT ''");
  addColumnIfMissing('sessions', 'google_email', "google_email TEXT DEFAULT ''");
  backfillSchoolKeys();
  persist();
  seedDemoHubs();
  purgeDemoMemberships();
  restampDemoFactScopes();
  backfillSeedGroups();
  // First boot with the durable store enabled uploads the seeded database so
  // later instances restore it. No-op when disabled or nothing changed.
  await flushDurableStore();
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

// Closed grade vocabulary: every placement grade is stored as one of these
// canonical labels, matching the "Grade N" labels extraction puts on facts.
const GRADE_OPTIONS = ['Kindergarten'].concat(
  Array.from({ length: 12 }, (_, i) => 'Grade ' + (i + 1))
);

const GRADE_WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

// Numeric grade for matching: Kindergarten counts as 0 so it never falls
// inside a numeric "Grades N-M" range but still matches itself.
function gradeNumberOf(value) {
  const s = String(value || '').toLowerCase();
  if (!s.trim()) return null;
  if (/\bkinder/.test(s) || /(^|[^a-z])(jk|sk|kg|k)([^a-z]|$)/.test(s)) return 0;
  const digits = /(\d{1,2})/.exec(s);
  if (digits) return Number(digits[1]);
  for (const word of Object.keys(GRADE_WORD_NUMBERS)) {
    if (new RegExp('\\b' + word + '\\b').test(s)) return GRADE_WORD_NUMBERS[word];
  }
  return null;
}

// Canonicalize a grade spelling to the closed vocabulary: "Gr 3",
// "grade three", "3", and "Grade Three" all become "Grade 3"; kinder
// spellings become "Kindergarten". Unrecognized input keeps its trimmed
// text so legacy rows are never silently blanked.
function canonicalGrade(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const n = gradeNumberOf(raw);
  if (n == null) return raw;
  if (n === 0) return 'Kindergarten';
  if (n >= 1 && n <= 12) return 'Grade ' + n;
  return raw;
}

function normalizeGrade(value) {
  return gradeNumberOf(value);
}

function normalizeClass(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^class\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

function scopeRangeBounds(scopeValue) {
  const s = String(scopeValue || '');
  const digits = [...s.matchAll(/(\d{1,2})/g)].map((m) => Number(m[1]));
  if (digits.length >= 2) return [digits[0], digits[1]];
  if (digits.length === 0) {
    const words = [];
    const lower = s.toLowerCase();
    const wordRe = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b/g;
    let m;
    while ((m = wordRe.exec(lower))) words.push(GRADE_WORD_NUMBERS[m[1]]);
    if (words.length >= 2) return [words[0], words[1]];
  }
  return null;
}

function gradeMatchesScope(scopeValue, childGrade) {
  const a = String(scopeValue || '').trim();
  const b = String(childGrade || '').trim();
  if (!a || !b) return false;
  // Canonical spellings match exactly: "Gr 3", "grade three", "3", and
  // "Grade Three" all canonicalize to "Grade 3", as does the stored value.
  const canonA = canonicalGrade(a).toLowerCase();
  const canonB = canonicalGrade(b).toLowerCase();
  if (canonA && canonA === canonB) return true;
  const childNum = gradeNumberOf(b);
  if (childNum == null) return false;
  const range = scopeRangeBounds(a);
  if (range) {
    return childNum >= range[0] && childNum <= range[1];
  }
  return gradeNumberOf(a) === childNum;
}

// Placements: per-child grade + optional class inside one hub. School (and
// activity/other) hubs use them; team hubs carry their own level and take none.
// Pre-redesign children rows may still carry a legacy grade/class: the first
// touch of a hub migrates those values into placement rows (deterministic —
// the same legacy values always seed the same placements, and existing rows
// are never overwritten).
function ensurePlacements(hubId, profileId) {
  const hub = hubId ? getHubRow(hubId) : null;
  if (!hub || (hub.kind || 'other') === 'team') return [];
  const kids = getChildren(profileId);
  if (!kids.length) return [];
  const have = all('SELECT child_id FROM placements WHERE hub_id = ?', [hubId]).map(
    (r) => r.child_id
  );
  const mine = new Set(kids.map((k) => k.id));
  if (have.some((id) => mine.has(id))) {
    return listPlacements(hubId, profileId);
  }
  const now = new Date().toISOString();
  for (const kid of kids) {
    run(
      'INSERT OR IGNORE INTO placements (hub_id, child_id, grade, class_name, updated_at) VALUES (?, ?, ?, ?, ?)',
      [hubId, kid.id, canonicalGrade(kid.grade || ''), kid.class || '', now]
    );
  }
  persist();
  return listPlacements(hubId, profileId);
}

function listPlacements(hubId, profileId) {
  if (!db || !hubId || !profileId) return [];
  try {
    return all(
      `SELECT p.child_id AS child_id, c.name AS child_name, p.grade AS grade, p.class_name AS class
       FROM placements p JOIN children c ON c.id = p.child_id
       WHERE p.hub_id = ? AND c.profile_id = ?`,
      [hubId, profileId]
    ).map((r) => ({
      child_id: r.child_id,
      child_name: r.child_name || '',
      grade: r.grade || '',
      class: r.class || '',
    }));
  } catch {
    return [];
  }
}

// Every child of the profile, with its placement row when one exists and
// blank grade/class otherwise (a missing row means "not placed yet").
function effectivePlacements(hubId, profileId) {
  const hub = hubId ? getHubRow(hubId) : null;
  if (!hub || (hub.kind || 'other') === 'team') return [];
  const kids = getChildren(profileId);
  const rows = new Map(listPlacements(hubId, profileId).map((p) => [p.child_id, p]));
  return kids.map((k) => {
    const row = rows.get(k.id);
    return row || { child_id: k.id, child_name: k.name || '', grade: '', class: '' };
  });
}

function placementStatus(hubId, profileId) {
  const hub = hubId ? getHubRow(hubId) : null;
  if (!hub || (hub.kind || 'other') === 'team') {
    return { placements: [], needs_placement: false };
  }
  ensurePlacements(hubId, profileId);
  const placements = effectivePlacements(hubId, profileId);
  return {
    placements,
    needs_placement: placements.some((p) => !String(p.grade || '').trim()),
  };
}

function setPlacements(hubId, profileId, list) {
  const hub = hubId ? getHubRow(hubId) : null;
  if (!hub) throw new Error('That hub could not be found.');
  if ((hub.kind || 'other') === 'team') {
    throw new Error("Team hubs don't use grade or class placements — the hub's own level already covers it.");
  }
  const kids = getChildren(profileId);
  const byId = new Map(kids.map((k) => [k.id, k]));
  const submitted = new Map();
  for (const item of list || []) {
    const id = item && item.child_id ? String(item.child_id) : '';
    if (!id || !byId.has(id)) throw new Error('That child is not in your family.');
    submitted.set(id, {
      grade: canonicalGrade(item && item.grade),
      class: String((item && (item.class || item.class_name)) || '').trim(),
    });
  }
  const now = new Date().toISOString();
  for (const kid of kids) run('DELETE FROM placements WHERE hub_id = ? AND child_id = ?', [hubId, kid.id]);
  for (const kid of kids) {
    const v = submitted.get(kid.id) || { grade: '', class: '' };
    run(
      'INSERT INTO placements (hub_id, child_id, grade, class_name, updated_at) VALUES (?, ?, ?, ?, ?)',
      [hubId, kid.id, v.grade, v.class, now]
    );
  }
  persist();
  return placementStatus(hubId, profileId);
}

// Remove one child's placement row in one hub. The child simply has no
// placement there afterwards: grade/class read back blank and grade- or
// class-scoped facts stay hidden, exactly like a child never placed.
function deletePlacement(hubId, profileId, childId) {
  const hub = hubId ? getHubRow(hubId) : null;
  if (!hub) throw new Error('That hub could not be found.');
  if ((hub.kind || 'other') === 'team') {
    throw new Error("Team hubs don't use grade or class placements — the hub's own level already covers it.");
  }
  const id = childId ? String(childId) : '';
  const kids = getChildren(profileId);
  if (!id || !kids.some((k) => k.id === id)) throw new Error('That child is not in your family.');
  run('DELETE FROM placements WHERE hub_id = ? AND child_id = ?', [hubId, id]);
  persist();
  return placementStatus(hubId, profileId);
}

function placementScopeSets(profileId, hubId) {
  ensurePlacements(hubId, profileId);
  const rows = listPlacements(hubId, profileId);
  return {
    grades: rows.map((p) => p.grade || '').filter(Boolean),
    classes: rows.map((p) => normalizeClass(p.class)).filter(Boolean),
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

function activateDemoProfile() {
  seedDemoIfNeeded();
  const demo = getDemoRow();
  if (!demo) return null;
  return rowToProfile(demo);
}

// Test and migration-simulation only: recreates the pre-sessions global
// active-profile pointer so a server can boot against a legacy-shaped
// database. Production code never writes this key.
function setLegacyActiveProfile(id) {
  setSetting('active_profile_id', id || null);
}

function createSession() {
  const id = crypto.randomUUID();
  // One-time legacy migration: the first session minted while a pre-sessions
  // global pointer exists adopts it, then the pointer is deleted so no later
  // session can inherit another visitor's profile.
  const adopted = getSetting('active_profile_id') || null;
  if (adopted) run('DELETE FROM settings WHERE key = ?', ['active_profile_id']);
  run('INSERT INTO sessions (id, active_profile_id, created_at) VALUES (?, ?, ?)', [
    id,
    adopted,
    new Date().toISOString(),
  ]);
  persist();
  return getSession(id);
}

function getSession(id) {
  if (!id) return null;
  const row = one('SELECT * FROM sessions WHERE id = ?', [String(id)]);
  return row || null;
}

function setSessionProfile(sessionId, profileId) {
  if (!sessionId) return null;
  run('UPDATE sessions SET active_profile_id = ? WHERE id = ?', [profileId || null, String(sessionId)]);
  persist();
  return getSession(sessionId);
}

function getSessionViewer(session) {
  if (session && session.active_profile_id) {
    const row = getProfileRowById(session.active_profile_id);
    if (row) return rowToProfile(row);
  }
  return getDemoProfile();
}

// The session's own family, or null when the session holds none (a fresh
// session with no family yet, or a signed-out one). Unlike
// getSessionViewer, this never falls back to the shared demo profile —
// invite accepts use it to tell a real family apart from a demo viewer.
function getSessionOwnProfile(session) {
  if (!session || !session.active_profile_id) return null;
  const row = getProfileRowById(session.active_profile_id);
  return rowToProfile(row);
}

// Account login (Google identity <-> family linking). The link lives on the
// family profile row (google_sub + email) so it survives in the same durable
// store as everything else; the signed-in identity also lives on the session
// row so a signed-in session without a family yet (onboarding) still renders
// "Signed in as <email>".
function getProfileByGoogleSub(sub) {
  if (!sub) return null;
  return rowToProfile(one('SELECT * FROM profiles WHERE google_sub = ? LIMIT 1', [String(sub)]));
}

function setProfileGoogleLink(profileId, sub, email) {
  const row = getProfileRowById(profileId);
  if (!row || row.is_demo) return null;
  run('UPDATE profiles SET google_sub = ?, google_email = ? WHERE id = ?', [
    String(sub || ''),
    String(email || ''),
    String(profileId),
  ]);
  persist();
  return rowToProfile(getProfileRowById(profileId));
}

function getSessionIdentity(session) {
  if (!session) return { signed_in: false, email: '' };
  const sub = session.google_sub || '';
  return { signed_in: Boolean(sub), email: sub ? session.google_email || '' : '' };
}

function setSessionIdentity(sessionId, sub, email) {
  if (!sessionId) return null;
  run('UPDATE sessions SET google_sub = ?, google_email = ? WHERE id = ?', [
    sub ? String(sub) : null,
    sub ? String(email || '') : null,
    String(sessionId),
  ]);
  persist();
  return getSession(sessionId);
}

// One-time OAuth state nonce bound to the session that started the login.
// Consumed (deleted) by the callback; stale nonces are pruned on mint.
function createLoginState(sessionId) {
  run("DELETE FROM login_states WHERE created_at < datetime('now', '-30 minutes')");
  const state = crypto.randomUUID();
  run('INSERT INTO login_states (state, session_id, created_at) VALUES (?, ?, ?)', [
    state,
    String(sessionId),
    new Date().toISOString(),
  ]);
  persist();
  return state;
}

function consumeLoginState(state, sessionId) {
  if (!state) return false;
  const row = one('SELECT * FROM login_states WHERE state = ?', [String(state)]);
  if (!row) return false;
  run('DELETE FROM login_states WHERE state = ?', [String(state)]);
  persist();
  return row.session_id === String(sessionId);
}

// Shared sign-in completion used by the real OAuth callback and (under a
// test-only env gate in server.js) by tests. Rules: (a) an account that
// already owns a family wins — the session switches to it, no merging;
// (b) otherwise the session's own non-demo family is attached to the
// account; (c) the demo family is never attachable — signing in while
// viewing it lands on the account family or on onboarding.
function completeGoogleSignIn(sessionId, sub, email) {
  const session = getSession(sessionId);
  if (!session || !sub) return null;
  const accountProfile = getProfileByGoogleSub(sub);
  if (accountProfile && !accountProfile.is_demo) {
    setSessionProfile(sessionId, accountProfile.id);
    setSessionIdentity(sessionId, sub, email);
    return { profile: getProfileByGoogleSub(sub), attached: false, switched: true };
  }
  const currentRow = session.active_profile_id ? getProfileRowById(session.active_profile_id) : null;
  if (currentRow && !currentRow.is_demo) {
    const linked = setProfileGoogleLink(currentRow.id, sub, email);
    setSessionIdentity(sessionId, sub, email);
    return { profile: linked, attached: true, switched: false };
  }
  setSessionProfile(sessionId, null);
  setSessionIdentity(sessionId, sub, email);
  return { profile: null, attached: false, switched: false };
}

// Brief 041: email recovery. The raw token is returned to the caller once
// and never stored or logged; only its SHA-256 hash is kept. Tokens are
// single-use (consuming deletes the row, even when expired) and a new
// request invalidates every earlier token for the same profile. When
// several profiles share one email (allowed since brief 040), recovery
// restores the most recently created profile with that email — profiles
// carry no activity timestamp, so creation time is the available proxy
// for "most recently active".
// Brief 049: the lookup matches the family's Google-linked email as well
// as its contact email — families created before brief 040 have no
// contact email, and the Google-linked address was verified by Google
// sign-in itself, so it carries the same mailbox-control proof.
const RECOVERY_TOKEN_TTL_MS = 60 * 60 * 1000;

function hashRecoveryToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function findProfileByParentEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const row = one(
    "SELECT * FROM profiles WHERE is_demo = 0 AND (LOWER(TRIM(COALESCE(parent_email, ''))) = ? OR LOWER(TRIM(COALESCE(google_email, ''))) = ?) ORDER BY created_at DESC LIMIT 1",
    [normalized, normalized]
  );
  return rowToProfile(row);
}

function createRecoveryToken(profileId, ttlMs) {
  if (!profileId) return null;
  run('DELETE FROM recovery_tokens WHERE profile_id = ?', [String(profileId)]);
  const raw = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + (ttlMs == null ? RECOVERY_TOKEN_TTL_MS : ttlMs)).toISOString();
  run('INSERT INTO recovery_tokens (token_hash, profile_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [
    hashRecoveryToken(raw),
    String(profileId),
    expiresAt,
    new Date(now).toISOString(),
  ]);
  persist();
  return { token: raw, expires_at: expiresAt };
}

function consumeRecoveryToken(raw) {
  if (!raw) return null;
  const hash = hashRecoveryToken(raw);
  const row = one('SELECT * FROM recovery_tokens WHERE token_hash = ?', [hash]);
  if (!row) return null;
  run('DELETE FROM recovery_tokens WHERE token_hash = ?', [hash]);
  persist();
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return rowToProfile(getProfileRowById(row.profile_id));
}

function recoveryTokenMetaForProfile(profileId) {
  if (!profileId) return null;
  const row = one('SELECT token_hash, expires_at, created_at FROM recovery_tokens WHERE profile_id = ? LIMIT 1', [
    String(profileId),
  ]);
  return row || null;
}

// Fixed-window counter in the store. Returns true when this hit is within
// the limit. Callers key it per email and per IP.
function hitRecoveryRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const row = one('SELECT * FROM recovery_rate_limits WHERE key = ?', [String(key)]);
  if (!row || now - new Date(row.window_start).getTime() >= windowMs) {
    run(
      'INSERT INTO recovery_rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start',
      [String(key), new Date(now).toISOString()]
    );
    persist();
    return true;
  }
  const count = Number(row.count || 0) + 1;
  run('UPDATE recovery_rate_limits SET count = ? WHERE key = ?', [count, String(key)]);
  persist();
  return count <= limit;
}

// Brief 046: agent tokens. A parent issues a named token in the browser;
// the raw token is shown once and never stored — only its SHA-256 hash is
// kept (the brief 041 pattern). Bearer resolution acts as exactly that one
// family: every existing membership/ownership gate applies unchanged. The
// demo profile can never hold or be resolved by a token.
const AGENT_TOKEN_PREFIX = 'pl_agent_';

function hashAgentToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function agentTokenPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || '',
    created_at: row.created_at || '',
    last_used_at: row.last_used_at || null,
    revoked_at: row.revoked_at || null,
    active: !row.revoked_at,
  };
}

function createAgentToken(profileId, name) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Give this token a name — for example, "Homework helper".');
  if (cleanName.length > 80) throw new Error('Keep that token name a little shorter.');
  const profile = getProfileRowById(profileId);
  if (!profile || Number(profile.is_demo) === 1) return null;
  const raw = AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  run(
    'INSERT INTO agent_tokens (id, profile_id, name, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
    [id, String(profileId), cleanName, hashAgentToken(raw), now]
  );
  persist();
  return { token: raw, record: agentTokenPublic(one('SELECT * FROM agent_tokens WHERE id = ?', [id])) };
}

function listAgentTokens(profileId) {
  if (!profileId) return [];
  return all('SELECT * FROM agent_tokens WHERE profile_id = ? ORDER BY created_at DESC, id DESC', [
    String(profileId),
  ]).map(agentTokenPublic);
}

function resolveAgentToken(raw) {
  const value = String(raw || '').trim();
  if (!value || !value.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const row = one('SELECT * FROM agent_tokens WHERE token_hash = ?', [hashAgentToken(value)]);
  if (!row || row.revoked_at) return null;
  const profileRow = getProfileRowById(row.profile_id);
  if (!profileRow || Number(profileRow.is_demo) === 1) return null;
  const now = new Date().toISOString();
  run('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', [now, row.id]);
  persist();
  return {
    profile: rowToProfile(profileRow),
    token: agentTokenPublic({ ...row, last_used_at: now }),
  };
}

function revokeAgentToken(profileId, tokenId) {
  if (!profileId || !tokenId) return null;
  const row = one('SELECT * FROM agent_tokens WHERE id = ? AND profile_id = ?', [
    String(tokenId),
    String(profileId),
  ]);
  if (!row) return null;
  if (!row.revoked_at) {
    run('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
    persist();
  }
  return agentTokenPublic(one('SELECT * FROM agent_tokens WHERE id = ?', [row.id]));
}

// Test-only: the stored row (hash included) so tests can prove the raw
// token is never kept. Never exposed over HTTP.
function agentTokenMeta(tokenId) {
  if (!tokenId) return null;
  return one('SELECT * FROM agent_tokens WHERE id = ?', [String(tokenId)]);
}

function signOutSession(sessionId) {
  if (!sessionId) return null;
  setSessionIdentity(sessionId, null, '');
  setSessionProfile(sessionId, null);
  return getSession(sessionId);
}

// Brief 040: the family contact email. A plain contact/recovery identifier
// on the profile — duplicates allowed, never an identity key, no
// verification flow. Basic format check only.
const PARENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PARENT_EMAIL_ERROR =
  'Please add a valid email — for example, you@example.com — so we can help you get back in if you are ever locked out.';

function parentEmailOf(input) {
  if (!input || typeof input !== 'object') return '';
  const raw = input.parent_email != null ? input.parent_email
    : input.email != null ? input.email
    : input.parentEmail != null ? input.parentEmail
    : input.parent && input.parent.email != null ? input.parent.email
    : '';
  return String(raw || '').trim();
}

function isValidParentEmail(value) {
  return PARENT_EMAIL_RE.test(String(value || '').trim());
}

function createProfile(input) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const raw = Array.isArray(input.children) && input.children.length
    ? input.children
    : [{ name: input.child_name }];
  // Family profile is names only: grade/class/school sent by older clients are
  // ignored, never stored.
  const names = raw
    .map((kid) => String((kid && kid.name) || '').trim())
    .filter(Boolean);
  if (!names.length) names.push('');
  run(
    `INSERT INTO profiles
       (id, parent_name, parent_email, child_name, grade, class_name, school_name, priorities, nudge_style, actions, is_demo, created_at)
     VALUES (?, ?, ?, ?, '', '', '', ?, ?, ?, 0, ?)`,
    [
      id,
      String(input.parent_name || '').trim(),
      parentEmailOf(input),
      names[0],
      JSON.stringify(Array.isArray(input.priorities) ? input.priorities : []),
      String(input.nudge_style || 'one short message in the evening').trim(),
      JSON.stringify(input.actions && typeof input.actions === 'object' ? input.actions : {}),
      now,
    ]
  );
  for (const name of names) {
    run(
      'INSERT INTO children (id, profile_id, name, grade, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), id, name, '', '', now]
    );
  }
  persist();
  return rowToProfile(getProfileRowById(id));
}

// Session-scoped family creation. When the creating session is signed in
// (its session row carries a Google identity), the account link MOVES to the
// new family: any other non-demo profile holding this account's link has it
// cleared, and the new profile is attached via the standard
// setProfileGoogleLink path, all persisted together. The previous family
// keeps its data, hubs, and memberships — only the link moves. When the
// account owned no family this is an immediate attach (same end state as
// signing in afterward). Anonymous creation changes nothing; the demo family
// is never linkable.
function createProfileForSession(sessionId, input) {
  const profile = createProfile(input);
  const session = sessionId ? getSession(sessionId) : null;
  const sub = session ? String(session.google_sub || '') : '';
  if (!profile || !sub) return profile;
  const email = String(session.google_email || '');
  const prev = getProfileByGoogleSub(sub);
  if (prev && !prev.is_demo && prev.id !== profile.id) {
    run('UPDATE profiles SET google_sub = ?, google_email = ? WHERE id = ?', ['', '', prev.id]);
  }
  const linked = setProfileGoogleLink(profile.id, sub, email);
  persist();
  return linked || profile;
}

// Brief 040: update the family contact email. The demo family is not
// editable. Throws the shared email error on a missing/invalid address so
// a typo fix can never save a bad address; duplicates are allowed.
function updateProfileEmail(profileId, email) {
  const row = getProfileRowById(profileId);
  if (!row || row.is_demo) return null;
  const value = String(email || '').trim();
  if (!isValidParentEmail(value)) throw new Error(PARENT_EMAIL_ERROR);
  run('UPDATE profiles SET parent_email = ? WHERE id = ?', [value, profileId]);
  persist();
  return rowToProfile(getProfileRowById(profileId));
}

function hasEmailInput(input) {
  return Boolean(input) && typeof input === 'object' &&
    (input.parent_email != null || input.email != null || input.parentEmail != null ||
      (input.parent && input.parent.email != null));
}

// Rename/add/remove children by name. The demo family is not editable.
// Returns the updated profile, or null when there is nothing to update.
function updateProfileNames(profileId, input) {
  const row = getProfileRowById(profileId);
  if (!row || row.is_demo) return null;
  if (hasEmailInput(input)) {
    const value = parentEmailOf(input);
    if (!isValidParentEmail(value)) throw new Error(PARENT_EMAIL_ERROR);
    run('UPDATE profiles SET parent_email = ? WHERE id = ?', [value, profileId]);
  }
  const parentName = String((input && input.parent_name) || '').trim();
  const raw = input && Array.isArray(input.children) ? input.children : [];
  const wanted = raw
    .map((kid) => ({
      id: kid && kid.id ? String(kid.id) : '',
      name: String((kid && kid.name) || '').trim(),
    }))
    .filter((kid) => kid.name);
  if (!wanted.length) throw new Error('Please add at least one child name.');
  const existing = new Map(getChildren(profileId).map((k) => [k.id, k]));
  const now = new Date().toISOString();
  if (parentName) run('UPDATE profiles SET parent_name = ? WHERE id = ?', [parentName, profileId]);
  const keptIds = new Set();
  const finalNames = [];
  for (const kid of wanted) {
    if (kid.id && existing.has(kid.id)) {
      run('UPDATE children SET name = ? WHERE id = ?', [kid.name, kid.id]);
      keptIds.add(kid.id);
      finalNames.push(kid.name);
    } else {
      const newId = crypto.randomUUID();
      run(
        'INSERT INTO children (id, profile_id, name, grade, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newId, profileId, kid.name, '', '', now]
      );
      keptIds.add(newId);
      finalNames.push(kid.name);
    }
  }
  for (const id of existing.keys()) {
    if (!keptIds.has(id)) {
      run('DELETE FROM placements WHERE child_id = ?', [id]);
      run('DELETE FROM children WHERE id = ?', [id]);
    }
  }
  run('UPDATE profiles SET child_name = ? WHERE id = ?', [finalNames[0] || '', profileId]);
  persist();
  return rowToProfile(getProfileRowById(profileId));
}

// Test and migration-simulation only: stamps legacy grade/class onto a child
// row so tests can prove the first-hub-touch migration. Production code never
// writes these columns for new data.
function __testSetChildLegacy(childId, grade, className) {
  run('UPDATE children SET grade = ?, class_name = ? WHERE id = ?', [
    String(grade || ''),
    String(className || ''),
    String(childId),
  ]);
  persist();
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
    website: row.website || '',
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
  if (profileId && !rowInScope(row, placementScopeSets(profileId, row.hub_id))) return null;
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

// The shared demo profile must never hold membership in a non-demo
// (real) hub: anyone exploring the demo would otherwise see the real
// school's name and shared hub contents in the demo's hub list. Enforced
// here so every path that adds memberships (invite accepts, approved join
// requests) is covered, not just the invite page.
function assertMembershipAllowed(hubId, profileId) {
  const hub = hubId ? getHubRow(hubId) : null;
  const profile = profileId ? getProfileRowById(profileId) : null;
  if (hub && profile && Number(profile.is_demo) === 1 && Number(hub.is_demo) !== 1) {
    throw new Error('Demo families cannot join this hub. Sign in or set up your family first.');
  }
}

function addMember(hubId, profileId, role, joinedVia) {
  assertMembershipAllowed(hubId, profileId);
  run(
    'INSERT OR IGNORE INTO hub_members (hub_id, profile_id, role, joined_via, joined_at) VALUES (?, ?, ?, ?, ?)',
    [hubId, profileId, role || 'member', joinedVia || 'invite', new Date().toISOString()]
  );
  persist();
}

// Membership removal used by cleanup flows. Deletes the row; never throws
// when there is nothing to remove.
function removeMember(hubId, profileId) {
  if (!hubId || !profileId || !db) return false;
  run('DELETE FROM hub_members WHERE hub_id = ? AND profile_id = ?', [hubId, profileId]);
  const removed = db.getRowsModified() > 0;
  persist();
  return removed;
}

// Repairs membership rows that predate the addMember guard (e.g. a demo
// invite accept that joined the demo profile to a real hub). Runs on every
// boot so a stale durable copy self-heals; returns the removed rows for
// logging. Idempotent.
function purgeDemoMemberships() {
  if (!tableColumns('hubs').includes('is_demo') || !tableColumns('profiles').includes('is_demo')) return [];
  const rows = all(
    `SELECT m.hub_id AS hub_id, m.profile_id AS profile_id, h.name AS hub_name
     FROM hub_members m
     JOIN profiles p ON p.id = m.profile_id AND p.is_demo = 1
     JOIN hubs h ON h.id = m.hub_id AND COALESCE(h.is_demo, 0) != 1`
  );
  for (const r of rows) {
    run('DELETE FROM hub_members WHERE hub_id = ? AND profile_id = ?', [r.hub_id, r.profile_id]);
  }
  if (rows.length) persist();
  if (rows.length) console.log(`demo membership sweep: removed ${rows.length} demo membership(s) from non-demo hub(s)`);
  return rows;
}

function isMember(hubId, profileId) {
  if (!hubId || !profileId) return false;
  return Boolean(one('SELECT hub_id FROM hub_members WHERE hub_id = ? AND profile_id = ?', [hubId, profileId]));
}

function getMemberRole(hubId, profileId) {
  const row = one('SELECT role FROM hub_members WHERE hub_id = ? AND profile_id = ?', [hubId, profileId]);
  return row ? row.role : null;
}

// Membership identity projected into a hub: only the parent's name and
// their hub role. No child names, grades, classes, placements, emails, or
// any other family-profile data ever leaves through here. Founder is an
// admin who joined as founder; other admins are Admin; everyone else is
// Member. Ordered founder/admins first, then members.
function listHubMembers(hubId) {
  if (!hubId) return [];
  const hub = getHubRow(hubId);
  if (!hub) return [];
  const rows = all(
    `SELECT p.parent_name AS parent_name, m.role AS role, m.joined_via AS joined_via,
            m.joined_at AS joined_at, m.profile_id AS profile_id
     FROM hub_members m
     JOIN profiles p ON p.id = m.profile_id
     WHERE m.hub_id = ?
     ORDER BY m.joined_at ASC, p.parent_name ASC`,
    [hubId]
  );
  const members = rows.map((r) => {
    const isFounder = r.role === 'admin' && r.joined_via === 'founder';
    const isAdmin = r.role === 'admin';
    const role = isFounder ? 'founder' : isAdmin ? 'admin' : 'member';
    const roleLabel = isFounder ? 'Founder' : isAdmin ? 'Admin' : 'Member';
    const parentName = r.parent_name || '';
    return {
      parent_name: parentName,
      name: parentName,
      family_name: parentName,
      display_name: parentName,
      role,
      role_label: roleLabel,
      is_founder: isFounder,
      is_admin: isAdmin,
      _rank: isFounder ? 0 : isAdmin ? 1 : 2,
      _isCreator: hub.created_by && r.profile_id === hub.created_by ? 1 : 0,
      _joined: r.joined_at || '',
    };
  });
  members.sort((a, b) => a._rank - b._rank || String(a._joined).localeCompare(String(b._joined)) || a.parent_name.localeCompare(b.parent_name));
  const creatorNames = new Set(rows.filter((r) => hub.created_by && r.profile_id === hub.created_by).map((r) => r.parent_name || ''));
  const pub = members.map(publicMember);
  pub._creatorNames = creatorNames;
  pub._adminNames = new Set(members.filter((m) => m.is_admin).map((m) => m.parent_name));
  return pub;
}

function publicMember(m) {
  return {
    parent_name: m.parent_name,
    name: m.name,
    family_name: m.family_name,
    display_name: m.display_name,
    role: m.role,
    role_label: m.role_label,
    is_founder: m.is_founder,
    is_admin: m.is_admin,
  };
}

// Point of contact: the founder/admin(s). If a hub somehow has no admin
// (e.g. a seeded hub whose founder holds a member role), the hub's
// creator is the contact so every hub still names someone.
function listHubContacts(hubId) {
  const members = listHubMembers(hubId);
  let contacts = members.filter((m) => m.is_admin);
  if (!contacts.length) contacts = members.filter((m) => members._creatorNames && members._creatorNames.has(m.parent_name));
  return contacts.map((m) => ({
    parent_name: m.parent_name,
    name: m.name,
    role: m.role,
    role_label: m.role_label,
  }));
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
  let website = extra && extra.website ? String(extra.website).trim() : '';
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
  run('INSERT INTO hubs (id, name, kind, school_key, school_name, city, province, country, sport, level, website, created_by, created_at, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)', [
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
    website,
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

function setHubWebsite(hubId, website) {
  if (!hubId || !getHubRow(hubId)) return null;
  run('UPDATE hubs SET website = ? WHERE id = ?', [String(website || '').trim(), hubId]);
  persist();
  return getHub(hubId);
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
  if (approve) {
    // Membership first: a refused add (e.g. the demo profile can never
    // join a non-demo hub) throws here and leaves the request pending
    // instead of recording a phantom approval.
    addMember(hubId, req.profile_id, 'member', 'request');
  }
  run('UPDATE join_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [
    approve ? 'approved' : 'declined',
    adminId,
    new Date().toISOString(),
    requestId,
  ]);
  persist();
  return one('SELECT * FROM join_requests WHERE id = ?', [requestId]);
}

function createMaterial(hubId, uploadedBy, kind, title, rawText, status, scope, scopeValue, file) {
  const id = crypto.randomUUID();
  const fileData = file && file.data ? new Uint8Array(file.data) : null;
  run(
    'INSERT INTO materials (id, hub_id, uploaded_by, kind, title, raw_text, created_at, status, scope, scope_value, file_data, file_name, file_size, file_mime, may_have_unread_pictures, pictures_read_with_ocr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, hubId, uploadedBy || '', kind || 'paste', title || '', rawText || '', new Date().toISOString(), status || 'stored', scope || 'school', scopeValue || '', fileData, fileData ? String(file.name || '') : '', fileData ? fileData.length : 0, fileData ? String(file.mime || '') : '', file && file.pictureRisk ? 1 : 0, file && file.picturesReadWithOcr ? 1 : 0]
  );
  persist();
  return getMaterial(id);
}

function updateMaterialScope(id, scope, scopeValue) {
  run('UPDATE materials SET scope = ?, scope_value = ? WHERE id = ?', [scope || 'school', scopeValue || '', id]);
  persist();
}

function getMaterial(id) {
  if (!id) return null;
  const row = one(
    "SELECT id, hub_id, uploaded_by, kind, title, raw_text, created_at, status, scope, scope_value, file_name, file_size, file_mime, may_have_unread_pictures, pictures_read_with_ocr, (file_data IS NOT NULL) AS has_file FROM materials WHERE id = ?",
    [id]
  );
  if (!row) return null;
  return { ...row, has_file: Boolean(row.has_file), may_have_unread_pictures: Boolean(row.may_have_unread_pictures), pictures_read_with_ocr: Boolean(row.pictures_read_with_ocr) };
}

// The retained original file behind a material (brief 042 PDF uploads and
// brief 044 image uploads), with the same per-profile scope gate as
// getMaterialText. Returns the raw bytes as a Buffer; null when the material
// is missing, out of scope, or has no file.
function getMaterialFile(materialId, profileId) {
  const row = materialId
    ? one('SELECT id, hub_id, kind, title, scope, scope_value, file_name, file_size, file_mime, file_data FROM materials WHERE id = ?', [materialId])
    : null;
  if (!row || !row.file_data) return null;
  if (profileId && !rowInScope(row, placementScopeSets(profileId, row.hub_id))) return null;
  return {
    id: row.id,
    hub_id: row.hub_id,
    kind: row.kind,
    title: row.title,
    file_name: row.file_name || '',
    file_size: row.file_size || row.file_data.length,
    file_mime: row.file_mime || '',
    data: Buffer.from(row.file_data),
  };
}

function findMaterial(hubId, title) {
  return one('SELECT * FROM materials WHERE hub_id = ? AND title = ? ORDER BY created_at ASC LIMIT 1', [hubId, title]);
}

function updateMaterialStatus(id, status) {
  run('UPDATE materials SET status = ? WHERE id = ?', [status, id]);
  persist();
}

function listMaterials(hubId, profileId) {
  const rows = all("SELECT id, hub_id, uploaded_by, kind, title, created_at, status, scope, scope_value, file_name, file_size, file_mime, may_have_unread_pictures, pictures_read_with_ocr, (file_data IS NOT NULL) AS has_file FROM materials WHERE hub_id = ? ORDER BY created_at ASC", [hubId]).map(scopedMaterialRow);
  if (!profileId) return rows;
  return rows.filter((m) => rowInScope(m, placementScopeSets(profileId, hubId)));
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
    has_file: Boolean(r.has_file),
    file_name: r.file_name || '',
    file_size: r.file_size || 0,
    file_mime: r.file_mime || '',
    may_have_unread_pictures: Boolean(r.may_have_unread_pictures),
    pictures_read_with_ocr: Boolean(r.pictures_read_with_ocr),
  };
}

function insertFacts(hubId, materialId, facts, replaceMaterialFacts) {
  if (replaceMaterialFacts && materialId) {
    run('DELETE FROM facts WHERE material_id = ?', [materialId]);
  }
  // Same-event duplicates — one event named in two newsletter sections, or
  // arriving via two materials in this hub — fold into a single row that keeps
  // the clearer title and both source quotes. Facts scoped to different
  // audiences never merge; conflict detection still skips them as same-event.
  const known = all('SELECT * FROM facts WHERE hub_id = ?', [hubId]).map(factRowToObject);
  for (const f of facts || []) {
    const derived = f.scope && ['school', 'grade', 'class'].includes(String(f.scope).toLowerCase())
      ? { scope: String(f.scope).toLowerCase(), value: f.scope_value || '' }
      : deriveScope(f);
    const incoming = Object.assign({}, f, {
      hub_id: hubId,
      material_id: materialId || '',
      scope: derived.scope,
      scope_value: derived.value,
    });
    const hit = known.find((g) => isSameEvent(g, incoming) && sameScope(g, incoming));
    if (!hit) {
      run(
        `INSERT OR REPLACE INTO facts
         (id, hub_id, material_id, type, title, detail, date, time, applies_to, action_required, action, link, source_document, source_text, published_at, extracted_at, confidence, supersedes, scope, scope_value, group_label, group_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          incoming.id, hubId, materialId || '', incoming.type, incoming.title, incoming.detail || '', incoming.date || '', incoming.time || '',
          incoming.applies_to || '', incoming.action_required ? 1 : 0, incoming.action || '', incoming.link || '',
          incoming.source_document || '', incoming.source_text || '', incoming.published_at || '', incoming.extracted_at || '',
          typeof incoming.confidence === 'number' ? incoming.confidence : 0, incoming.supersedes || '',
          derived.scope, derived.value, incoming.group_label || '', incoming.group_summary || '',
        ]
      );
      known.push(incoming);
      continue;
    }
    const merged = mergeFactPair(hit, incoming);
    run(
      `UPDATE facts
       SET type = ?, title = ?, detail = ?, date = ?, time = ?, applies_to = ?, action_required = ?,
           action = ?, link = ?, source_document = ?, source_text = ?, confidence = ?,
           scope = ?, scope_value = ?, group_label = ?, group_summary = ?
       WHERE id = ?`,
      [
        merged.type, merged.title, merged.detail || '', merged.date || '', merged.time || '',
        merged.applies_to || '', merged.action_required ? 1 : 0, merged.action || '', merged.link || '',
        merged.source_document || '', merged.source_text || '',
        typeof merged.confidence === 'number' ? merged.confidence : 0,
        merged.scope || 'school', merged.scope_value || '', merged.group_label || '', merged.group_summary || '',
        hit.id,
      ]
    );
    Object.assign(hit, merged, { id: hit.id, hub_id: hit.hub_id, material_id: hit.material_id });
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
  return rows.filter((f) => rowInScope(f, placementScopeSets(profileId, hubId)));
}

function listFactsForProfile(profileId) {
  if (!profileId) return [];
  const setsByHub = new Map();
  const setsFor = (hubId) => {
    if (!setsByHub.has(hubId)) setsByHub.set(hubId, placementScopeSets(profileId, hubId));
    return setsByHub.get(hubId);
  };
  return all(
    `SELECT f.*, h.name AS hub_name FROM facts f
     JOIN hubs h ON h.id = f.hub_id
     JOIN hub_members m ON m.hub_id = h.id AND m.profile_id = ?
     ORDER BY f.date ASC, f.title ASC`,
    [profileId]
  )
    .map((r) => ({ ...factRowToObject(r), hub_name: r.hub_name, hub: r.hub_name }))
    .filter((f) => rowInScope(f, setsFor(f.hub_id)));
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
  if (!String(hubA.website || '').trim()) {
    run('UPDATE hubs SET website = ? WHERE id = ?', [DEMO_SCHOOL_WEBSITE, hubA.id]);
    persist();
  }

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
  HOCKEY_FACTS,
  initDb,
  isDurableStoreEnabled,
  durableStatusLine,
  flushDurableStore,
  getActiveProfile,
  getDemoProfile,
  getProfileForRun,
  activateDemoProfile,
  createSession,
  setLegacyActiveProfile,
  getSession,
  setSessionProfile,
  getSessionViewer,
  getProfileByGoogleSub,
  getProfileRowById,
  setProfileGoogleLink,
  getSessionIdentity,
  setSessionIdentity,
  createLoginState,
  consumeLoginState,
  completeGoogleSignIn,
  signOutSession,
  findProfileByParentEmail,
  createRecoveryToken,
  consumeRecoveryToken,
  recoveryTokenMetaForProfile,
  hitRecoveryRateLimit,
  RECOVERY_TOKEN_TTL_MS,
  AGENT_TOKEN_PREFIX,
  createAgentToken,
  listAgentTokens,
  resolveAgentToken,
  revokeAgentToken,
  agentTokenMeta,
  createProfile,
  createProfileForSession,
  updateProfileNames,
  updateProfileEmail,
  parentEmailOf,
  isValidParentEmail,
  PARENT_EMAIL_ERROR,
  __testSetChildLegacy,
  updateProfileActions,
  ensurePlacements,
  listPlacements,
  effectivePlacements,
  placementStatus,
  setPlacements,
  deletePlacement,
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
  removeMember,
  purgeDemoMemberships,
  getSessionOwnProfile,
  isMember,
  getMemberRole,
  listHubMembers,
  listHubContacts,
  createHub,
  setHubWebsite,
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
  getMaterialFile,
  findMaterial,
  updateMaterialStatus,
  updateMaterialScope,
  listMaterials,
  insertFacts,
  listFacts,
  listFactsForProfile,
  GRADE_OPTIONS,
  canonicalGrade,
  gradeNumberOf,
  gradeMatchesScope,
};
