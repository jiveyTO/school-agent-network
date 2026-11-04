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
  { id: 'fact-u9-hockey-skate-fitting-2026-11-04', type: 'event', title: 'Skate fitting', detail: 'Skate fitting at the arena pro shop before the season opener.', date: '2026-11-07', time: '4:30 PM–5:30 PM', applies_to: 'U9 Hockey players', action_required: true, action: 'Bring skates for fitting', link: '', source_document: 'U9 Hockey — Maple Grove (fictional schedule)', source_text: 'Skate fitting is Saturday between 4:30 and 5:30 PM at the pro shop.', published_at: '2026-11-01T09:00:00.000Z', confidence: 0.97, group_label: 'Season prep' },
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
// A failed upload (network error, timeout, HTTP 5xx) retries with capped
// exponential backoff instead of waiting for the next write. The base delay
// is overridable for tests only.
const DURABLE_RETRY_BASE_MS = Number(process.env.APP_DB_GCS_RETRY_BASE_MS) || 5000;
const DURABLE_RETRY_MAX_MS = 5 * 60 * 1000;
const DURABLE_RETRY_MAX_ATTEMPTS = 8;
let durableDirty = false;
let durableUploadTimer = null;
// Bumped by every persist. An upload clears durableDirty only when no write
// landed while it was in flight, so a mid-upload write is never forgotten.
let durableWriteSeq = 0;
// The upload in flight, if any. Uploads never overlap: two in flight on the
// same generation would make the second fail with HTTP 412 and disable
// write-back for the rest of the boot.
let durableInFlight = null;
// Transfer budget grows with the file: 30 s plus 10 s per MB, capped at
// 5 min. A fixed 30 s upload limit timed out on the 18.8 MB database
// (revision 00084, 2026-11-04).
function durableTransferTimeoutMs(bytes) {
  const mb = Math.ceil(Math.max(0, Number(bytes) || 0) / (1024 * 1024));
  return Math.min(30000 + mb * 10000, 5 * 60 * 1000);
}
let durableRetryAttempt = 0;
// MD5s (base64, as GCS reports them) of the bytes sent by uploads that threw
// since the last confirmed one. A timed-out upload may still have landed; the
// retry then gets HTTP 412, and a matching stored hash proves the object is
// ours (see durableAdoptLandedUpload).
const durableUnconfirmedMd5s = new Set();
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
      signal: AbortSignal.timeout(Math.max(15000, durableTransferTimeoutMs(durableRemoteSize))),
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
  const body = fs.readFileSync(DB_PATH);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(durableTransferTimeoutMs(body.length)),
    });
  } catch (err) {
    durableUnconfirmedMd5s.add(crypto.createHash('md5').update(body).digest('base64'));
    throw err;
  }
  if (res.status === 412 && durableUnconfirmedMd5s.size && (await durableAdoptLandedUpload(cfg, headers))) {
    // The earlier "failed" upload had landed; retry once on its generation.
    return durableUploadFromFile();
  }
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
  durableUnconfirmedMd5s.clear();
  try {
    const body = await res.json();
    if (body && body.generation != null) durableRemoteGeneration = String(body.generation);
  } catch {
    // Upload succeeded; a missing generation in the reply just means the
    // next upload goes without a precondition.
  }
  return true;
}

// After a 412 that follows uploads whose replies were lost: if the stored
// object's MD5 equals the bytes one of them sent, that upload landed and the
// object is still ours, so adopt its generation instead of disabling
// write-back. Any other content means a different writer: return false.
// Checked once per 412, so a second 412 disables write-back as before.
async function durableAdoptLandedUpload(cfg, headers) {
  const expected = new Set(durableUnconfirmedMd5s);
  durableUnconfirmedMd5s.clear();
  try {
    const meta = await fetch(
      cfg.endpoint + '/storage/v1/b/' + encodeURIComponent(cfg.bucket) + '/o/' + encodeURIComponent(cfg.object),
      { headers: headers.Authorization ? { Authorization: headers.Authorization } : {}, signal: AbortSignal.timeout(15000) }
    );
    if (!meta.ok) return false;
    const info = await meta.json();
    if (!info || !expected.has(info.md5Hash) || info.generation == null) return false;
    durableRemoteGeneration = String(info.generation);
    console.warn('durable store: an upload reported as failed had landed; continuing on its generation.');
    return true;
  } catch {
    return false;
  }
}

function scheduleDurableRetry() {
  if (durableUploadTimer || !durableDirty) return;
  if (durableRetryAttempt >= DURABLE_RETRY_MAX_ATTEMPTS) {
    console.warn(
      `durable store: upload still failing after ${durableRetryAttempt} retries; ` +
        'the next write will try again.'
    );
    durableRetryAttempt = 0;
    return;
  }
  const delay = Math.min(DURABLE_RETRY_BASE_MS * 2 ** durableRetryAttempt, DURABLE_RETRY_MAX_MS);
  durableRetryAttempt += 1;
  durableUploadTimer = setTimeout(() => {
    durableUploadTimer = null;
    flushDurableStore();
  }, delay);
  if (durableUploadTimer.unref) durableUploadTimer.unref();
}

function scheduleDurableUpload() {
  if (!durableConfig()) return;
  durableWriteSeq += 1;
  durableDirty = true;
  if (durableUploadTimer) return;
  scheduleDurableUploadTimer();
}

function scheduleDurableUploadTimer() {
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
  if (durableInFlight) {
    // One upload at a time: wait for it, then upload whatever is still
    // unsaved (a write that landed during it).
    await durableInFlight;
    return flushDurableStore();
  }
  const seqAtStart = durableWriteSeq;
  durableInFlight = (async () => {
    try {
      const uploaded = await durableUploadFromFile();
      if (uploaded) {
        durableRetryAttempt = 0;
        if (durableWriteSeq === seqAtStart) durableDirty = false;
        else if (!durableUploadTimer) scheduleDurableUploadTimer();
      }
      return uploaded;
    } catch (err) {
      console.warn('durable store upload failed:', err && err.message ? err.message : err);
      scheduleDurableRetry();
      return false;
    } finally {
      durableInFlight = null;
    }
  })();
  return durableInFlight;
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
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0
  )`);
  run(`CREATE TABLE IF NOT EXISTS gmail_states (
    state TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
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
  // Quote verification: how many extracted items a material lost because
  // their quote was not found in its source text. Existing rows stay 0.
  addColumnIfMissing('materials', 'unverified_count', 'unverified_count INTEGER DEFAULT 0');
  // 1 only for facts whose quote code-verified against the material's text
  // at extraction time; facts stored before verification stay 0.
  addColumnIfMissing('facts', 'quote_verified', 'quote_verified INTEGER DEFAULT 0');
  // Brief 060: last 4 characters of an agent token, captured at creation so
  // its card can be told apart. A display label only — it never
  // authenticates. Tokens minted before this stay '' and show no hint.
  addColumnIfMissing('agent_tokens', 'display_hint', "display_hint TEXT DEFAULT ''");
  // Brief 062: SHA-256 of a material's normalized source text, set when it
  // is added, so the same newsletter added twice lands on one material.
  // Existing rows stay '' and never match a duplicate check.
  addColumnIfMissing('materials', 'fingerprint', "fingerprint TEXT DEFAULT ''");
  // Brief 062: provenance of an email-kind material sent by an agent.
  addColumnIfMissing('materials', 'email_from', "email_from TEXT DEFAULT ''");
  addColumnIfMissing('materials', 'email_date', "email_date TEXT DEFAULT ''");
  // Each family's latest evening check, saved so the home screen, agents,
  // and the evening email can show it without recomputing.
  run(`CREATE TABLE IF NOT EXISTS evening_checks (
    profile_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    moment_label TEXT,
    fingerprint TEXT
  )`);
  // Audit trail for items dropped because their quote did not verify.
  run(`CREATE TABLE IF NOT EXISTS fact_rejections (
    id TEXT PRIMARY KEY,
    hub_id TEXT,
    material_id TEXT,
    fact_title TEXT,
    fact_detail TEXT,
    quote TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  )`);
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
  // Evening email: opt-in (off by default), the local time the family
  // wants it, and the local day it was last sent (one email per day).
  addColumnIfMissing('profiles', 'evening_email', 'evening_email INTEGER DEFAULT 0');
  addColumnIfMissing('profiles', 'evening_email_time', "evening_email_time TEXT DEFAULT '19:00'");
  addColumnIfMissing('profiles', 'evening_email_last_day', "evening_email_last_day TEXT DEFAULT ''");
  addColumnIfMissing('sessions', 'google_sub', "google_sub TEXT DEFAULT ''");
  addColumnIfMissing('sessions', 'google_email', "google_email TEXT DEFAULT ''");
  // Brief 074: whether Google said the signed-in email is verified, and the
  // Google account (sub) whose "is this your family?" offer was declined.
  addColumnIfMissing('sessions', 'google_email_verified', 'google_email_verified INTEGER DEFAULT 0');
  addColumnIfMissing('sessions', 'link_declined_sub', "link_declined_sub TEXT DEFAULT ''");
  // Rows from before expiry existed get 0, so they count as expired.
  addColumnIfMissing('login_states', 'expires_at', 'expires_at INTEGER NOT NULL DEFAULT 0');
  // Brief 067: invite links expire 7 days after they're made. A hub can ask
  // a question only its parents would know before a family joins by link
  // (answers kept only as hashes); join_open = 1 lets anyone with a link in.
  addColumnIfMissing('invites', 'expires_at', "expires_at TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'join_question', "join_question TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'join_answers', "join_answers TEXT DEFAULT ''");
  addColumnIfMissing('hubs', 'join_open', 'join_open INTEGER DEFAULT 0');
  // Brief 068: up to three challenge questions, JSON [{ q, a: [hashes] }].
  // A hub saved before this keeps its one question in join_question /
  // join_answers, read as a list of one.
  addColumnIfMissing('hubs', 'join_questions', "join_questions TEXT DEFAULT ''");
  // Brief 068: why a family is asking (e.g. it couldn't answer the hub's
  // questions), shown to the admin next to the request.
  addColumnIfMissing('join_requests', 'note', "note TEXT DEFAULT ''");
  addColumnIfMissing('agent_tokens', 'via', "via TEXT DEFAULT ''");
  // Brief 067: an agent's request to join by invite, waiting for its
  // parent's approval. Only a hash of the agent's poll secret is kept; the
  // token is minted when the agent collects it, so none is ever stored.
  run(`CREATE TABLE IF NOT EXISTS agent_connects (
    id TEXT PRIMARY KEY,
    invite_token TEXT NOT NULL,
    hub_id TEXT NOT NULL,
    agent_name TEXT,
    user_code TEXT,
    poll_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    profile_id TEXT,
    membership TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT
  )`);
  backfillInviteExpiry();
  backfillSchoolKeys();
  persist();
  seedDemoHubs();
  purgeDemoMemberships();
  restampDemoFactScopes();
  backfillSeedGroups();
  for (const target of DEMO_TEST_MATERIAL_REMOVALS) removeDemoTestMaterial(target);
  moveDemoSkateFitting();
  retitleLegacyPastes();
  // A restored database that boot left unchanged (schema-only migrations
  // don't count: they re-run every boot) is not uploaded. Uploading it would
  // move the stored generation during a deploy, so the old instance's final
  // flush, or this instance's first real write, would fail with HTTP 412.
  if (durableRestoreOutcome === 'restored' && totalRowChanges() === 0) {
    durableDirty = false;
    if (durableUploadTimer) {
      clearTimeout(durableUploadTimer);
      durableUploadTimer = null;
    }
    console.log('durable store: restored database unchanged at boot; no upload');
  }
  // First boot with the durable store enabled uploads the seeded database so
  // later instances restore it. No-op when disabled or nothing changed.
  await flushDurableStore();
}

// Brief 072: a pasted material's title when no title was supplied. The
// first line when it is short; a heading glued to its body ("Hillcrest
// Public School — November Newsletter. Pizza Day: …") keeps its first
// sentence; anything else is cut on a word at PASTE_TITLE_CAP with "…".
// No text at all -> a dated label. Never the whole paste. The extraction
// read then proposes a content title (Brief 053's path) that replaces this.
const PASTE_TITLE_CAP = 60;

function firstPasteLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim().replace(/^#+\s*/, '').trim())
    .find((line) => line) || '';
}

function derivePasteTitle(text, now) {
  const first = firstPasteLine(text).replace(/\s+/g, ' ');
  if (first) {
    if (first.length <= PASTE_TITLE_CAP) return first;
    const sentence = first.slice(0, PASTE_TITLE_CAP + 1).match(/^(.{8,}?[^\s.!?])[.!?](?=\s|$)/);
    if (sentence) return sentence[1].trim();
    const cut = first.slice(0, PASTE_TITLE_CAP);
    const space = cut.lastIndexOf(' ');
    return (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, '') + '…';
  }
  const at = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  return `Newsletter — ${at.toISOString().slice(0, 10)}`;
}

// The title every paste got before Brief 072: its first line, cut at 80
// characters. A paste still carrying exactly this was never renamed.
function legacyPasteTitle(text) {
  const first = firstPasteLine(text);
  if (!first) return '';
  return first.length > 80 ? first.slice(0, 80).trim() + '…' : first;
}

// Brief 072 backfill: pastes added before 072 whose title is still the old
// first-line cut get the new title (their notes' labels follow, as on a
// rename). A title a parent set (anything else) is never touched, demo
// hubs stay as they are, and a retitled paste no longer matches, so later
// boots change nothing.
function retitleLegacyPastes() {
  const rows = all(
    `SELECT m.id AS id, m.title AS title, m.raw_text AS raw_text FROM materials m
     JOIN hubs h ON h.id = m.hub_id
     WHERE m.kind = 'paste' AND COALESCE(h.is_demo, 0) = 0`
  );
  let changed = 0;
  for (const row of rows) {
    const title = String(row.title || '');
    const legacy = legacyPasteTitle(row.raw_text);
    if (!legacy || title !== legacy) continue;
    const next = derivePasteTitle(row.raw_text);
    if (!next || next === title) continue;
    run('UPDATE materials SET title = ? WHERE id = ?', [next, row.id]);
    run('UPDATE facts SET group_label = ? WHERE material_id = ? AND group_label = ?', [next, row.id, title]);
    run('UPDATE facts SET source_document = ? WHERE material_id = ? AND source_document = ?', [next, row.id, title]);
    changed += 1;
  }
  if (changed) console.log(`paste titles: retitled ${changed} pasted material(s) from their first-line cut`);
  return changed;
}

// Rows inserted, updated or deleted on this connection since it opened.
function totalRowChanges() {
  const res = db.exec('SELECT total_changes()');
  return res.length ? Number(res[0].values[0][0]) : 0;
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
    const key = schoolKey(schoolName, city, row.province, row.country);
    // Only when something differs: a no-op UPDATE still counts as a change
    // and would make every boot upload the database (see initDb).
    run(
      "UPDATE hubs SET school_name = ?, city = ?, school_key = ? WHERE id = ? " +
        "AND (COALESCE(school_name, '') <> ? OR COALESCE(city, '') <> ? OR COALESCE(school_key, '') <> ?)",
      [schoolName || '', city || '', key, row.id, schoolName || '', city || '', key]
    );
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

function setSessionIdentity(sessionId, sub, email, emailVerified) {
  if (!sessionId) return null;
  run('UPDATE sessions SET google_sub = ?, google_email = ?, google_email_verified = ? WHERE id = ?', [
    sub ? String(sub) : null,
    sub ? String(email || '') : null,
    sub && emailVerified ? 1 : 0,
    String(sessionId),
  ]);
  persist();
  return getSession(sessionId);
}

// One-time OAuth state nonce bound to the session that started the login.
// Consumed (deleted) by the callback; expired nonces are pruned on mint and
// refused on consume. Expiry is epoch ms: comparing ISO created_at text with
// sqlite datetime() text never matched same-day rows.
const LOGIN_STATE_TTL_MS = 15 * 60 * 1000;

function createLoginState(sessionId) {
  run('DELETE FROM login_states WHERE expires_at < ?', [Date.now()]);
  const state = crypto.randomUUID();
  run('INSERT INTO login_states (state, session_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    state,
    String(sessionId),
    new Date().toISOString(),
    Date.now() + LOGIN_STATE_TTL_MS,
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
  if (Number(row.expires_at) < Date.now()) return false;
  return row.session_id === String(sessionId);
}

// One-time Gmail-connect OAuth state, bound to the session that started the
// connect and the family it was started for. The callback attaches tokens
// only to that bound family; a profile ID is never accepted as state.
const GMAIL_STATE_TTL_MS = 10 * 60 * 1000;

function createGmailState(sessionId, profileId) {
  run('DELETE FROM gmail_states WHERE expires_at < ?', [Date.now()]);
  const state = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO gmail_states (state, session_id, profile_id, expires_at) VALUES (?, ?, ?, ?)', [
    state,
    String(sessionId),
    String(profileId),
    Date.now() + GMAIL_STATE_TTL_MS,
  ]);
  persist();
  return state;
}

// Returns the bound profile ID, or null. Always deletes the state it finds,
// so a token works at most once even when the session does not match.
function consumeGmailState(state, sessionId) {
  if (!state) return null;
  const row = one('SELECT * FROM gmail_states WHERE state = ?', [String(state)]);
  if (!row) return null;
  run('DELETE FROM gmail_states WHERE state = ?', [String(state)]);
  persist();
  if (row.session_id !== String(sessionId)) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  return row.profile_id;
}

// Shared sign-in completion used by the real OAuth callback and (under a
// test-only env gate in server.js) by tests. Rules: (a) an account that
// already owns a family wins — the session switches to it, no merging;
// (b) otherwise the session's own non-demo family is attached to the
// account; (c) the demo family is never attachable — signing in while
// viewing it lands on the account family or on onboarding.
// Brief 074: emailVerified is Google's email_verified for this sign-in. It
// changes none of (a)-(c); it only lets a session left with no family see
// the "is this your family?" offer below.
function completeGoogleSignIn(sessionId, sub, email, emailVerified) {
  const session = getSession(sessionId);
  if (!session || !sub) return null;
  const accountProfile = getProfileByGoogleSub(sub);
  if (accountProfile && !accountProfile.is_demo) {
    setSessionProfile(sessionId, accountProfile.id);
    setSessionIdentity(sessionId, sub, email, emailVerified);
    return { profile: getProfileByGoogleSub(sub), attached: false, switched: true };
  }
  const currentRow = session.active_profile_id ? getProfileRowById(session.active_profile_id) : null;
  if (currentRow && !currentRow.is_demo) {
    const linked = setProfileGoogleLink(currentRow.id, sub, email);
    setSessionIdentity(sessionId, sub, email, emailVerified);
    return { profile: linked, attached: true, switched: false };
  }
  setSessionProfile(sessionId, null);
  setSessionIdentity(sessionId, sub, email, emailVerified);
  return { profile: null, attached: false, switched: false, link_offer: linkOfferCandidates(getSession(sessionId)).length };
}

// Brief 074: a family made with the typed-email form carries the address
// only as parent_email, so Google sign-in (by google_sub) can't see it.
// When a signed-in session holds no family of its own, Google says the
// email is verified, and the parent hasn't said No for this account, the
// families whose contact email matches it exactly (case-normalized) and
// that no Google account owns yet are offered: "is this your family?".
// Nothing links until the parent taps Yes on one of them.
const LINK_OFFER_MAX = 5;

function linkOfferCandidates(session) {
  if (!session || !session.google_sub || Number(session.google_email_verified) !== 1) return [];
  if (String(session.link_declined_sub || '') === String(session.google_sub)) return [];
  if (getProfileByGoogleSub(session.google_sub)) return [];
  const own = session.active_profile_id ? getProfileRowById(session.active_profile_id) : null;
  if (own && !own.is_demo) return [];
  const email = String(session.google_email || '').trim().toLowerCase();
  if (!email) return [];
  return all(
    `SELECT * FROM profiles WHERE is_demo = 0 AND COALESCE(google_sub, '') = ''
     AND LOWER(TRIM(COALESCE(parent_email, ''))) = ? ORDER BY created_at ASC LIMIT ?`,
    [email, LINK_OFFER_MAX]
  ).map(rowToProfile);
}

// An opaque per-session handle for one offered family (never its id).
function linkOfferKey(sessionId, profileId) {
  return crypto.createHash('sha256').update(String(sessionId) + ':' + String(profileId)).digest('hex').slice(0, 20);
}

// What the page shows: the parent's name and the children's names only.
function getLinkOffer(session) {
  const candidates = linkOfferCandidates(session);
  if (!candidates.length) return null;
  return {
    email: String(session.google_email || ''),
    families: candidates.map((p) => ({
      key: linkOfferKey(session.id, p.id),
      parent_name: (p.parent && p.parent.name) || '',
      children: (p.children || []).map((c) => c.name).filter(Boolean),
    })),
  };
}

// Yes on one offered family: re-checks the offer as it stands now, stamps
// the Google identity onto that family, and switches the session to it.
// The link is logged (family id and time; nothing secret).
function acceptLinkOffer(sessionId, key) {
  const session = getSession(sessionId);
  const chosen = linkOfferCandidates(session).find((p) => linkOfferKey(sessionId, p.id) === String(key || ''));
  if (!chosen) return null;
  const linked = setProfileGoogleLink(chosen.id, session.google_sub, session.google_email);
  if (!linked) return null;
  setSessionProfile(sessionId, chosen.id);
  console.log(`account link: family ${chosen.id} linked to its Google sign-in by matching email (parent confirmed) at ${new Date().toISOString()}`);
  return linked;
}

// No: nothing is stamped; this session isn't asked again for this account.
function declineLinkOffer(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.google_sub) return false;
  run('UPDATE sessions SET link_declined_sub = ? WHERE id = ?', [String(session.google_sub), String(sessionId)]);
  persist();
  return true;
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
    ...(row.display_hint ? { hint: row.display_hint } : {}),
    ...(row.via ? { via: row.via } : {}),
  };
}

function createAgentToken(profileId, name, via) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Give this token a name — for example, "Homework helper".');
  if (cleanName.length > 80) throw new Error('Keep that token name a little shorter.');
  const profile = getProfileRowById(profileId);
  if (!profile || Number(profile.is_demo) === 1) return null;
  const raw = AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  run(
    'INSERT INTO agent_tokens (id, profile_id, name, token_hash, created_at, last_used_at, revoked_at, display_hint, via) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
    [id, String(profileId), cleanName, hashAgentToken(raw), now, raw.slice(-4), String(via || '')]
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

// Deleting removes a revoked token from the family's list for good. An
// active token must be revoked first, so deleting can never be the step
// that cuts access off. Returns 'deleted', 'active', or null (not found or
// not this family's).
function deleteAgentToken(profileId, tokenId) {
  if (!profileId || !tokenId) return null;
  const row = one('SELECT * FROM agent_tokens WHERE id = ? AND profile_id = ?', [
    String(tokenId),
    String(profileId),
  ]);
  if (!row) return null;
  if (!row.revoked_at) return 'active';
  run('DELETE FROM agent_tokens WHERE id = ?', [row.id]);
  persist();
  return 'deleted';
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

// Remove one material from its hub: the material row (which also holds
// the retained file bytes), and every fact extracted from it. Sibling
// materials and their facts are untouched.
// Renames a material. Notes stamped with its old title (their group
// heading and source label) follow the new one; other labels stay.
function renameMaterial(materialId, title) {
  const row = one('SELECT id, title FROM materials WHERE id = ?', [materialId]);
  if (!row) return null;
  const next = String(title || '');
  const prev = String(row.title || '');
  run('UPDATE materials SET title = ? WHERE id = ?', [next, materialId]);
  if (prev) {
    run('UPDATE facts SET group_label = ? WHERE material_id = ? AND group_label = ?', [next, materialId, prev]);
    run('UPDATE facts SET source_document = ? WHERE material_id = ? AND source_document = ?', [next, materialId, prev]);
  }
  persist();
  return getMaterial(materialId);
}

function deleteMaterial(materialId) {
  if (!materialId) return false;
  if (!one('SELECT id FROM materials WHERE id = ?', [materialId])) return false;
  run('DELETE FROM facts WHERE material_id = ?', [materialId]);
  run('DELETE FROM fact_rejections WHERE material_id = ?', [materialId]);
  run('DELETE FROM materials WHERE id = ?', [materialId]);
  persist();
  return true;
}

function deleteHub(hubId) {
  if (!hubId) return false;
  if (!getHubRow(hubId)) return false;
  run('DELETE FROM facts WHERE hub_id = ?', [hubId]);
  run('DELETE FROM fact_rejections WHERE hub_id = ?', [hubId]);
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

// Brief 055: a hub member is addressed by an opaque per-hub key, never by
// profile id (profile ids must not reach other families' browsers). One-way:
// the key cannot be turned back into the profile id.
function hubMemberKey(hubId, profileId) {
  return crypto.createHash('sha256').update('hub-member:' + hubId + ':' + profileId).digest('hex').slice(0, 32);
}

// The membership behind a member key, or null when the key names no member
// of this hub.
function findHubMemberByKey(hubId, key) {
  if (!hubId || !key) return null;
  const hub = getHubRow(hubId);
  if (!hub) return null;
  const rows = all('SELECT profile_id, role, joined_via FROM hub_members WHERE hub_id = ?', [hubId]);
  const row = rows.find((r) => hubMemberKey(hubId, r.profile_id) === String(key));
  if (!row) return null;
  return {
    profile_id: row.profile_id,
    is_founder: (row.role === 'admin' && row.joined_via === 'founder') || Boolean(hub.created_by && hub.created_by === row.profile_id),
  };
}

// Brief 055: a founder/admin takes a family out of a hub. The membership
// and that family's placements in THIS hub go; the profile, its children,
// its other hubs, and the materials it added here all stay.
function removeHubMember(hubId, profileId) {
  if (!hubId || !profileId || !db) return false;
  run(
    'DELETE FROM placements WHERE hub_id = ? AND child_id IN (SELECT id FROM children WHERE profile_id = ?)',
    [hubId, profileId]
  );
  run('DELETE FROM hub_members WHERE hub_id = ? AND profile_id = ?', [hubId, profileId]);
  const removed = db.getRowsModified() > 0;
  persist();
  return removed;
}

// Repairs membership rows that predate the addMember guard (e.g. a demo
// invite accept that joined the demo profile to a real hub). Runs on every
// boot so a stale durable copy self-heals; returns the removed rows for
// logging. Idempotent.
// Brief 066: a fictional test newsletter added to the hosted demo hub for
// extraction scoring. The page refuses to remove demo materials, so boot
// removes exactly this one through deleteMaterial (its facts and rejections
// go with it) and saves through the normal write-back. Exact hub id,
// material id and title must all match, and the hub must be a demo hub;
// once it is gone this is a no-op.
const DEMO_TEST_MATERIAL_REMOVALS = [
  {
    hubId: '40a10522-ee08-4af2-a288-0343eaa8481c',
    materialId: 'a174b415-56f9-4d19-9e9d-501e5f0bc14a',
    title: 'Maple Grove Weekly — Nov 9 to 13, 2026',
  },
];

function removeDemoTestMaterial({ hubId, materialId, title }) {
  const hub = one('SELECT id, is_demo FROM hubs WHERE id = ?', [hubId]);
  if (!hub || Number(hub.is_demo) !== 1) return null;
  const material = one('SELECT id, title FROM materials WHERE id = ? AND hub_id = ?', [materialId, hubId]);
  if (!material || material.title !== title) return null;
  const factIds = all('SELECT id FROM facts WHERE material_id = ?', [materialId]).map((r) => String(r.id));
  // A demo family's saved evening check that shows any of these facts (or
  // names the material) is cleared, so the next check recomputes without it.
  const stale = all(
    `SELECT e.profile_id AS profile_id, e.result_json AS result_json
     FROM evening_checks e JOIN profiles p ON p.id = e.profile_id AND p.is_demo = 1`
  ).filter((c) => {
    const json = String(c.result_json || '');
    return json.includes(materialId) || json.includes(title) || factIds.some((id) => id && json.includes(id));
  });
  for (const c of stale) run('DELETE FROM evening_checks WHERE profile_id = ?', [c.profile_id]);
  deleteMaterial(materialId);
  console.log(
    `demo cleanup: removed test material ${materialId} and ${factIds.length} fact(s); cleared ${stale.length} saved demo evening check(s)`
  );
  return { facts_removed: factIds.length, checks_cleared: stale.length };
}

// The demo's skate fitting moved from Wed Nov 4 (already past at the demo's
// Thursday-evening moment, so it looked forgotten) to Sat Nov 7, so the demo
// evening check shows it as due soon. Saturday has no all-day school events,
// so the demo keeps its 3 conflicts. Existing databases are moved once; the
// fact keeps its id. No-op once moved.
const DEMO_SKATE_FITTING_ID = 'fact-u9-hockey-skate-fitting-2026-11-04';
const DEMO_SKATE_FITTING_OLD_QUOTE = 'Skate fitting is Wednesday between 4:30 and 5:30 PM at the pro shop.';

function moveDemoSkateFitting() {
  const row = one(
    `SELECT f.id AS id, f.date AS date, f.material_id AS material_id
     FROM facts f JOIN hubs h ON h.id = f.hub_id AND h.is_demo = 1 WHERE f.id = ?`,
    [DEMO_SKATE_FITTING_ID]
  );
  if (!row || row.date !== '2026-11-04') return false;
  const seed = HOCKEY_FACTS.find((f) => f.id === DEMO_SKATE_FITTING_ID);
  run('UPDATE facts SET date = ?, source_text = ? WHERE id = ?', [seed.date, seed.source_text, DEMO_SKATE_FITTING_ID]);
  if (row.material_id) {
    run('UPDATE materials SET raw_text = REPLACE(raw_text, ?, ?) WHERE id = ?', [
      DEMO_SKATE_FITTING_OLD_QUOTE, seed.source_text, row.material_id,
    ]);
  }
  persist();
  console.log(`demo update: skate fitting moved to ${seed.date}`);
  return true;
}

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
      _profileId: r.profile_id,
    };
  });
  members.sort((a, b) => a._rank - b._rank || String(a._joined).localeCompare(String(b._joined)) || a.parent_name.localeCompare(b.parent_name));
  const creatorNames = new Set(rows.filter((r) => hub.created_by && r.profile_id === hub.created_by).map((r) => r.parent_name || ''));
  const pub = members.map(publicMember);
  // Server-side only (never serialized: JSON drops array properties).
  pub._profileIds = members.map((m) => m._profileId);
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

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function inviteExpiryFrom(createdAt) {
  const t = Date.parse(createdAt || '');
  return new Date((Number.isFinite(t) ? t : Date.now()) + INVITE_LIFETIME_MS).toISOString();
}

// Brief 067: links made before expiry existed expire 7 days after they were
// made. Runs every boot; only rows still missing an expiry change.
function backfillInviteExpiry() {
  const rows = all("SELECT token, created_at FROM invites WHERE COALESCE(expires_at, '') = ''");
  for (const r of rows) {
    run('UPDATE invites SET expires_at = ? WHERE token = ?', [inviteExpiryFrom(r.created_at), r.token]);
  }
  if (rows.length) persist();
}

function inviteExpired(invite, now) {
  const at = Date.parse((invite && invite.expires_at) || '');
  return Number.isFinite(at) && at <= (now || Date.now());
}

function createInvite(hubId, profileId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  run('INSERT INTO invites (token, hub_id, created_by, created_at, revoked, expires_at) VALUES (?, ?, ?, ?, 0, ?)', [
    token,
    hubId,
    profileId,
    now,
    inviteExpiryFrom(now),
  ]);
  persist();
  return token;
}

// 'ok' | 'expired' | 'missing' (unknown, turned off, or its hub is gone).
function inviteState(token) {
  if (!token) return 'missing';
  const invite = one('SELECT * FROM invites WHERE token = ?', [token]);
  if (!invite || Number(invite.revoked) || !getHubRow(invite.hub_id)) return 'missing';
  return inviteExpired(invite) ? 'expired' : 'ok';
}

// A short handle for an invite that is not the token itself, so a list of
// links can turn one off without ever showing the full link.
function inviteRef(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

function listActiveInvites(hubId) {
  const now = Date.now();
  return all('SELECT * FROM invites WHERE hub_id = ? AND revoked = 0 ORDER BY created_at DESC', [hubId])
    .filter((r) => !inviteExpired(r, now))
    .map((r) => {
      const maker = getProfileRowById(r.created_by);
      return {
        ref: inviteRef(r.token),
        last4: String(r.token).slice(-4),
        created_at: r.created_at,
        expires_at: r.expires_at,
        made_by: maker ? String(maker.parent_name || '').trim().split(' ')[0] : '',
      };
    });
}

function turnOffInvite(hubId, ref) {
  const row = all('SELECT token FROM invites WHERE hub_id = ? AND revoked = 0', [hubId])
    .find((r) => inviteRef(r.token) === String(ref || ''));
  if (!row) return false;
  revokeInvite(hubId, row.token);
  return true;
}

function getInvite(token) {
  if (!token) return null;
  const invite = one('SELECT * FROM invites WHERE token = ?', [token]);
  if (!invite || Number(invite.revoked) || inviteExpired(invite)) return null;
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

function createJoinRequest(hubId, profileId, note) {
  const pending = one(
    "SELECT * FROM join_requests WHERE hub_id = ? AND profile_id = ? AND status = 'pending'",
    [hubId, profileId]
  );
  const cleanNote = String(note || '').trim().slice(0, 200);
  if (pending) {
    if (cleanNote && !pending.note) {
      run('UPDATE join_requests SET note = ? WHERE id = ?', [cleanNote, pending.id]);
      persist();
      return one('SELECT * FROM join_requests WHERE id = ?', [pending.id]);
    }
    return pending;
  }
  const id = crypto.randomUUID();
  run(
    'INSERT INTO join_requests (id, hub_id, profile_id, status, created_at, decided_by, decided_at, note) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
    [id, hubId, profileId, 'pending', new Date().toISOString(), cleanNote]
  );
  persist();
  return one('SELECT * FROM join_requests WHERE id = ?', [id]);
}

// Brief 067: a family asking to join through an invite link. Reuses its
// pending request; a declined family may ask again after 24 hours; a hub
// holds at most 20 pending requests. Returns { request } or { error, status }.
const JOIN_REQUEST_CAP = 20;
const JOIN_REASK_MS = 24 * 60 * 60 * 1000;

function requestToJoin(hubId, profileId, note) {
  const pending = one(
    "SELECT * FROM join_requests WHERE hub_id = ? AND profile_id = ? AND status = 'pending'",
    [hubId, profileId]
  );
  if (pending) return { request: createJoinRequest(hubId, profileId, note) };
  const declined = one(
    "SELECT decided_at FROM join_requests WHERE hub_id = ? AND profile_id = ? AND status = 'declined' ORDER BY decided_at DESC LIMIT 1",
    [hubId, profileId]
  );
  if (declined && Date.now() - Date.parse(declined.decided_at || 0) < JOIN_REASK_MS) {
    return { error: 'This hub said no to your request recently — you can ask again tomorrow.', status: 403 };
  }
  const open = one("SELECT COUNT(*) AS n FROM join_requests WHERE hub_id = ? AND status = 'pending'", [hubId]);
  if (open && Number(open.n) >= JOIN_REQUEST_CAP) {
    return { error: 'This hub has too many families waiting right now. Please try again later.', status: 429 };
  }
  return { request: createJoinRequest(hubId, profileId, note) };
}

function countPendingJoinRequests(hubId) {
  const row = one("SELECT COUNT(*) AS n FROM join_requests WHERE hub_id = ? AND status = 'pending'", [hubId]);
  return row ? Number(row.n) : 0;
}

function listPendingHubsForProfile(profileId) {
  if (!profileId) return [];
  return all(
    `SELECT h.id AS id, h.name AS name, r.created_at AS asked_at FROM join_requests r
     JOIN hubs h ON h.id = r.hub_id
     WHERE r.profile_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC`,
    [profileId]
  ).map((r) => ({ id: r.id, name: r.name, asked_at: r.asked_at }));
}

// Brief 067: the hub's join question. Answers are compared in a normalized
// form (case, spacing, punctuation and accents ignored) and stored only as
// salted hashes, so nobody can read them back.
function normalizeJoinAnswer(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashJoinAnswer(hubId, answer) {
  return crypto.createHash('sha256').update(String(hubId) + ':' + normalizeJoinAnswer(answer)).digest('hex');
}

// Brief 068: more forgiving matching on top of the 067 form — "&" reads as
// "and", "St"/"Ste" as "Saint"/"Sainte", and a leading "the", "a" or "an"
// is dropped ("The Saint Joseph's Tigers" = "st josephs tigers"). Hashes
// made this way carry a "v2:" prefix; 067 hashes keep matching as before.
const JOIN_WORD_VARIANTS = { st: 'saint', ste: 'sainte' };
function normalizeJoinAnswerV2(value) {
  const words = normalizeJoinAnswer(String(value || '').replace(/&/g, ' and '))
    .replace(/(\w)\s+s\b/g, '$1s')
    .split(' ')
    .filter(Boolean)
    .map((w) => JOIN_WORD_VARIANTS[w] || w);
  if (words.length > 1 && ['the', 'a', 'an'].includes(words[0])) words.shift();
  return words.join(' ');
}

function hashJoinAnswerV2(hubId, answer) {
  return 'v2:' + crypto.createHash('sha256').update(String(hubId) + ':v2:' + normalizeJoinAnswerV2(answer)).digest('hex');
}

function answerMatchesHashes(hubId, answer, hashes) {
  if (!normalizeJoinAnswer(answer) || !Array.isArray(hashes)) return false;
  return hashes.includes(hashJoinAnswerV2(hubId, answer)) || hashes.includes(hashJoinAnswer(hubId, answer));
}

const JOIN_QUESTION_MAX = 3;

// The hub's questions as stored: [{ q, a: [hashes] }]. A hub saved by 067
// has one question in the older columns.
function storedJoinQuestions(row) {
  if (!row) return [];
  let list = [];
  try { list = JSON.parse(row.join_questions || '[]'); } catch { list = []; }
  if (Array.isArray(list) && list.length) {
    return list
      .filter((x) => x && String(x.q || '').trim() && Array.isArray(x.a) && x.a.length)
      .slice(0, JOIN_QUESTION_MAX);
  }
  const q = String(row.join_question || '').trim();
  let a = [];
  try { a = JSON.parse(row.join_answers || '[]'); } catch { a = []; }
  return q && Array.isArray(a) && a.length ? [{ q, a }] : [];
}

// What callers may see: prompts and counts, never the hashes. `question`
// (the first prompt) stays for 067 clients.
function getJoinSettings(hubId) {
  const row = getHubRow(hubId);
  if (!row) return null;
  const stored = storedJoinQuestions(row);
  return {
    question: stored.length ? stored[0].q : '',
    questions: stored.map((x) => x.q),
    question_count: stored.length,
    has_question: stored.length > 0,
    answer_count: stored.reduce((n, x) => n + x.a.length, 0),
    answer_counts: stored.map((x) => x.a.length),
    open: Number(row.join_open) === 1,
  };
}

function answerList(answers) {
  const raw = Array.isArray(answers) ? answers : String(answers == null ? '' : answers).split('\n');
  return raw.map((a) => String(a == null ? '' : a).trim()).filter((a) => normalizeJoinAnswer(a));
}

// Brief 068: save one to three questions. Each item is { question, answers,
// from }. Answers are never sent back, so the editor can't resend them: an
// item with no answers and `from` = the index of a saved question keeps
// that question's saved answers (wording edits, reordering, removing one).
function setJoinQuestions(hubId, items) {
  const row = getHubRow(hubId);
  const before = storedJoinQuestions(row);
  const list = (Array.isArray(items) ? items : []).filter((it) => it && (String(it.question || '').trim() || answerList(it.answers).length));
  if (!list.length) throw new Error('Write the question parents will see.');
  if (list.length > JOIN_QUESTION_MAX) throw new Error('Keep it to ' + JOIN_QUESTION_MAX + ' questions or fewer.');
  const saved = list.map((it) => {
    const q = String(it.question || '').trim();
    if (!q) throw new Error('Write the question parents will see.');
    if (q.length > 140) throw new Error('Keep each question under 140 characters.');
    const given = answerList(it.answers);
    if (given.length > 10) throw new Error('Keep it to 10 answers or fewer for each question.');
    let hashes;
    const kept = Number.isInteger(it.from) ? before[it.from] : null;
    if (given.length) hashes = Array.from(new Set(given.map((a) => hashJoinAnswerV2(hubId, a))));
    else if (kept) hashes = kept.a;
    else throw new Error(list.length > 1 ? 'Add at least one answer for each question.' : 'Add at least one answer.');
    return { q, a: hashes };
  });
  run('UPDATE hubs SET join_questions = ?, join_question = ?, join_answers = ? WHERE id = ?',
    [JSON.stringify(saved), saved[0].q, JSON.stringify(saved[0].a), hubId]);
  persist();
  return getJoinSettings(hubId);
}

function setJoinQuestion(hubId, question, answers) {
  return setJoinQuestions(hubId, [{ question, answers }]);
}

function clearJoinQuestion(hubId) {
  run("UPDATE hubs SET join_question = '', join_answers = '', join_questions = '' WHERE id = ?", [hubId]);
  persist();
  return getJoinSettings(hubId);
}

function setJoinOpen(hubId, open) {
  run('UPDATE hubs SET join_open = ? WHERE id = ?', [open ? 1 : 0, hubId]);
  persist();
  return getJoinSettings(hubId);
}

// Brief 068: every question must be answered, each against its own list.
function checkJoinAnswers(hubId, answers) {
  const stored = storedJoinQuestions(getHubRow(hubId));
  if (!stored.length) return false;
  const given = Array.isArray(answers) ? answers : [answers];
  return stored.every((x, i) => answerMatchesHashes(hubId, given[i], x.a));
}

function checkJoinAnswer(hubId, answer) {
  return checkJoinAnswers(hubId, [answer]);
}

// Brief 067: an agent's request to join by invite. The parent approves at
// /approve/<id>; the agent collects with its poll secret. Requests last 10
// minutes; an approved one can be collected for 30 minutes after approval.
const AGENT_CONNECT_TTL_MS = 10 * 60 * 1000;
const AGENT_CONNECT_COLLECT_MS = 30 * 60 * 1000;
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeUserCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return code.slice(0, 4) + '-' + code.slice(4);
}

function hashPollSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

function countOpenAgentConnects(inviteToken) {
  const row = one(
    "SELECT COUNT(*) AS n FROM agent_connects WHERE invite_token = ? AND status = 'pending' AND expires_at > ?",
    [inviteToken, new Date().toISOString()]
  );
  return row ? Number(row.n) : 0;
}

function createAgentConnect(inviteToken, hubId, agentName) {
  const id = crypto.randomBytes(16).toString('base64url');
  const pollSecret = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const name = String(agentName || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'AI agent';
  run(
    `INSERT INTO agent_connects (id, invite_token, hub_id, agent_name, user_code, poll_hash, status, profile_id, membership, created_at, expires_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
    [id, inviteToken, hubId, name, makeUserCode(), hashPollSecret(pollSecret), now.toISOString(),
      new Date(now.getTime() + AGENT_CONNECT_TTL_MS).toISOString()]
  );
  persist();
  return { connect: getAgentConnect(id), pollSecret };
}

function getAgentConnect(id) {
  if (!id) return null;
  const row = one('SELECT * FROM agent_connects WHERE id = ?', [String(id)]);
  if (!row) return null;
  const expired = row.status === 'pending' && Date.parse(row.expires_at) <= Date.now();
  return { ...row, status: expired ? 'expired' : row.status };
}

function decideAgentConnect(id, decision) {
  const row = getAgentConnect(id);
  if (!row || row.status !== 'pending') return null;
  if (decision.approve) {
    run("UPDATE agent_connects SET status = 'approved', profile_id = ?, membership = ?, decided_at = ? WHERE id = ?",
      [decision.profileId, decision.membership, new Date().toISOString(), row.id]);
  } else {
    run("UPDATE agent_connects SET status = 'declined', decided_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
  }
  persist();
  return getAgentConnect(row.id);
}

// The one moment a token exists: minted for the approving family and handed
// to whoever holds the poll secret, once. Returns { status, ... }.
function collectAgentConnect(id, pollSecret) {
  const row = getAgentConnect(id);
  if (!row || !pollSecret || row.poll_hash !== hashPollSecret(pollSecret)) return { status: 'unknown' };
  if (row.status === 'pending') return { status: 'pending' };
  if (row.status === 'declined') return { status: 'declined' };
  if (row.status !== 'approved') return { status: 'expired' };
  if (Date.now() - Date.parse(row.decided_at || 0) > AGENT_CONNECT_COLLECT_MS) return { status: 'expired' };
  const created = createAgentToken(row.profile_id, row.agent_name, 'invite approval');
  if (!created) return { status: 'expired' };
  run("UPDATE agent_connects SET status = 'consumed' WHERE id = ?", [row.id]);
  persist();
  const profile = getProfileRowById(row.profile_id);
  const hub = getHubRow(row.hub_id);
  return {
    status: 'approved',
    token: created.token,
    hub: hub ? { id: hub.id, name: hub.name } : null,
    membership: row.membership,
    family_first_name: profile ? String(profile.parent_name || '').trim().split(' ')[0] : '',
  };
}

// Drops agent requests that can no longer be approved or collected. Run by
// the service on a timer, not at boot, so a deploy's boot stays write-free.
function sweepAgentConnects() {
  const cutoff = new Date(Date.now() - AGENT_CONNECT_COLLECT_MS).toISOString();
  run("DELETE FROM agent_connects WHERE (status IN ('pending', 'consumed', 'declined') AND expires_at < ?) OR (status = 'approved' AND decided_at < ?)", [cutoff, cutoff]);
  const removed = db.getRowsModified();
  if (removed) persist();
  return removed;
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
    note: r.note || '',
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

function createMaterial(hubId, uploadedBy, kind, title, rawText, status, scope, scopeValue, file, meta) {
  const id = crypto.randomUUID();
  const fileData = file && file.data ? new Uint8Array(file.data) : null;
  const extra = meta || {};
  run(
    'INSERT INTO materials (id, hub_id, uploaded_by, kind, title, raw_text, created_at, status, scope, scope_value, file_data, file_name, file_size, file_mime, may_have_unread_pictures, pictures_read_with_ocr, fingerprint, email_from, email_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, hubId, uploadedBy || '', kind || 'paste', title || '', rawText || '', new Date().toISOString(), status || 'stored', scope || 'school', scopeValue || '', fileData, fileData ? String(file.name || '') : '', fileData ? fileData.length : 0, fileData ? String(file.mime || '') : '', file && file.pictureRisk ? 1 : 0, file && file.picturesReadWithOcr ? 1 : 0, String(extra.fingerprint || ''), String(extra.emailFrom || ''), String(extra.emailDate || '')]
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
    "SELECT id, hub_id, uploaded_by, kind, title, raw_text, created_at, status, scope, scope_value, file_name, file_size, file_mime, may_have_unread_pictures, pictures_read_with_ocr, unverified_count, email_from, email_date, (file_data IS NOT NULL) AS has_file FROM materials WHERE id = ?",
    [id]
  );
  if (!row) return null;
  return { ...row, has_file: Boolean(row.has_file), may_have_unread_pictures: Boolean(row.may_have_unread_pictures), pictures_read_with_ocr: Boolean(row.pictures_read_with_ocr), unverified_count: Number(row.unverified_count || 0), email_from: row.email_from || '', email_date: row.email_date || '' };
}

// Brief 062: the hub's earliest non-failed material with this fingerprint,
// or null. A failed add never blocks adding the same text again.
function findMaterialByFingerprint(hubId, fingerprint) {
  if (!hubId || !fingerprint) return null;
  const row = one(
    "SELECT id FROM materials WHERE hub_id = ? AND fingerprint = ? AND status != 'failed' ORDER BY created_at ASC LIMIT 1",
    [hubId, String(fingerprint)]
  );
  return row ? getMaterial(row.id) : null;
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

// Brief 053: a file material's title read from its content.
function updateMaterialTitle(id, title) {
  run('UPDATE materials SET title = ? WHERE id = ?', [String(title || ''), id]);
  persist();
}

// Quote verification: an image's own read (the vision transcript) becomes
// part of its stored text, so its facts verify against what was read.
function updateMaterialText(id, text) {
  run('UPDATE materials SET raw_text = ? WHERE id = ?', [String(text || ''), id]);
  persist();
}

// Quote verification outcome for one extraction: the dropped items go to
// the audit log and the material records how many were left out.
function recordFactRejections(hubId, materialId, rejected) {
  if (!materialId) return 0;
  const now = new Date().toISOString();
  for (const r of rejected || []) {
    run(
      'INSERT INTO fact_rejections (id, hub_id, material_id, fact_title, fact_detail, quote, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), hubId || '', materialId, String(r.title || ''), String(r.detail || ''), String(r.quote || ''), String(r.reason || ''), now]
    );
  }
  run('UPDATE materials SET unverified_count = ? WHERE id = ?', [(rejected || []).length, materialId]);
  persist();
  return (rejected || []).length;
}

function saveEveningCheck(profileId, { result, ran_at, moment_label, fingerprint }) {
  if (!profileId) return;
  run(
    'INSERT OR REPLACE INTO evening_checks (profile_id, result_json, ran_at, moment_label, fingerprint) VALUES (?, ?, ?, ?, ?)',
    [profileId, JSON.stringify(result || {}), ran_at || new Date().toISOString(), moment_label || '', fingerprint || '']
  );
  persist();
}

function getEveningCheck(profileId) {
  const row = profileId ? one('SELECT * FROM evening_checks WHERE profile_id = ?', [profileId]) : null;
  if (!row) return null;
  let result = null;
  try { result = JSON.parse(row.result_json); } catch { result = null; }
  if (!result) return null;
  return { result, ran_at: row.ran_at, moment_label: row.moment_label || '', fingerprint: row.fingerprint || '' };
}

// Evening email preferences. Kept out of rowToProfile on purpose: the
// profile object is sent to the evening-check model, which has no use for
// them.
function getEveningEmailPrefs(profileId) {
  const row = profileId ? one('SELECT parent_email, is_demo, evening_email, evening_email_time, evening_email_last_day FROM profiles WHERE id = ?', [profileId]) : null;
  if (!row) return null;
  return {
    enabled: Boolean(row.evening_email),
    time: row.evening_email_time || '19:00',
    last_day: row.evening_email_last_day || '',
    email: row.parent_email || '',
    is_demo: Boolean(row.is_demo),
  };
}

function setEveningEmailPrefs(profileId, enabled, time) {
  run('UPDATE profiles SET evening_email = ?, evening_email_time = ? WHERE id = ?', [enabled ? 1 : 0, String(time || '19:00'), profileId]);
  persist();
  return getEveningEmailPrefs(profileId);
}

function markEveningEmailSent(profileId, day) {
  run('UPDATE profiles SET evening_email_last_day = ? WHERE id = ?', [String(day || ''), profileId]);
  persist();
}

// Server-side secret that signs email links (unsubscribe). Created once and
// kept in the database, so it survives deploys with the durable store.
function emailLinkSecret() {
  let secret = getSetting('email_link_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('email_link_secret', secret);
    persist();
  }
  return secret;
}

// Real families who asked for the evening email and have an address.
function listEveningEmailProfiles() {
  return all(
    "SELECT id, evening_email_time, evening_email_last_day, parent_email FROM profiles WHERE evening_email = 1 AND is_demo = 0 AND COALESCE(parent_email, '') != ''"
  ).map((r) => ({ id: r.id, time: r.evening_email_time || '19:00', last_day: r.evening_email_last_day || '', email: r.parent_email }));
}

function listFactRejections(materialId) {
  if (!materialId) return [];
  return all('SELECT fact_title, fact_detail, quote, reason, created_at FROM fact_rejections WHERE material_id = ? ORDER BY created_at ASC', [materialId]);
}

// Brief 068: how many notes each material in a hub produced, before any
// family's grade/class filter — so a card can tell "nothing pulled out
// yet" apart from "nothing for your family".
function countFactsByMaterial(hubId) {
  const out = {};
  for (const r of all('SELECT material_id, COUNT(*) AS n FROM facts WHERE hub_id = ? GROUP BY material_id', [hubId])) {
    if (r.material_id) out[r.material_id] = Number(r.n);
  }
  return out;
}

function listMaterials(hubId, profileId) {
  const rows = all("SELECT id, hub_id, uploaded_by, kind, title, created_at, status, scope, scope_value, file_name, file_size, file_mime, may_have_unread_pictures, pictures_read_with_ocr, unverified_count, email_from, email_date, (file_data IS NOT NULL) AS has_file FROM materials WHERE hub_id = ? ORDER BY created_at ASC", [hubId]).map(scopedMaterialRow);
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
      // Only rows with an empty field the seed can fill, so an unchanged
      // database boots with zero row changes (see initDb).
      const label = String(f.group_label || '');
      const summary = String(f.group_summary || '');
      run(
        "UPDATE facts SET group_label = COALESCE(NULLIF(group_label, ''), ?), group_summary = COALESCE(NULLIF(group_summary, ''), ?) " +
          "WHERE id = ? AND ((COALESCE(group_label, '') = '' AND ? <> '') OR (COALESCE(group_summary, '') = '' AND ? <> ''))",
        [label, summary, String(f.id), label, summary]
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
    quote_verified: Boolean(r.quote_verified),
  };
}

function scopedMaterialRow(r) {
  return {
    id: r.id,
    hub_id: r.hub_id,
    uploaded_by: r.uploaded_by || '',
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
    unverified_count: Number(r.unverified_count || 0),
    email_from: r.email_from || '',
    email_date: r.email_date || '',
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
         (id, hub_id, material_id, type, title, detail, date, time, applies_to, action_required, action, link, source_document, source_text, published_at, extracted_at, confidence, supersedes, scope, scope_value, group_label, group_summary, quote_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          incoming.id, hubId, materialId || '', incoming.type, incoming.title, incoming.detail || '', incoming.date || '', incoming.time || '',
          incoming.applies_to || '', incoming.action_required ? 1 : 0, incoming.action || '', incoming.link || '',
          incoming.source_document || '', incoming.source_text || '', incoming.published_at || '', incoming.extracted_at || '',
          typeof incoming.confidence === 'number' ? incoming.confidence : 0, incoming.supersedes || '',
          derived.scope, derived.value, incoming.group_label || '', incoming.group_summary || '',
          incoming.quote_verified ? 1 : 0,
        ]
      );
      known.push(incoming);
      continue;
    }
    const merged = mergeFactPair(hit, incoming);
    // A merged row's quotes are all proven only when both sides were.
    run(
      `UPDATE facts
       SET type = ?, title = ?, detail = ?, date = ?, time = ?, applies_to = ?, action_required = ?,
           action = ?, link = ?, source_document = ?, source_text = ?, confidence = ?,
           scope = ?, scope_value = ?, group_label = ?, group_summary = ?, quote_verified = ?
       WHERE id = ?`,
      [
        merged.type, merged.title, merged.detail || '', merged.date || '', merged.time || '',
        merged.applies_to || '', merged.action_required ? 1 : 0, merged.action || '', merged.link || '',
        merged.source_document || '', merged.source_text || '',
        typeof merged.confidence === 'number' ? merged.confidence : 0,
        merged.scope || 'school', merged.scope_value || '', merged.group_label || '', merged.group_summary || '',
        hit.quote_verified && incoming.quote_verified ? 1 : 0,
        hit.id,
      ]
    );
    Object.assign(hit, merged, { id: hit.id, hub_id: hit.hub_id, material_id: hit.material_id, quote_verified: Boolean(hit.quote_verified && incoming.quote_verified) });
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
  durableTransferTimeoutMs,
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
  createGmailState,
  consumeGmailState,
  completeGoogleSignIn,
  getLinkOffer,
  acceptLinkOffer,
  declineLinkOffer,
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
  deleteAgentToken,
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
  hubMemberKey,
  findHubMemberByKey,
  removeHubMember,
  purgeDemoMemberships,
  removeDemoTestMaterial,
  derivePasteTitle,
  legacyPasteTitle,
  retitleLegacyPastes,
  moveDemoSkateFitting,
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
  inviteState,
  listActiveInvites,
  turnOffInvite,
  createJoinRequest,
  requestToJoin,
  countPendingJoinRequests,
  listPendingHubsForProfile,
  getJoinSettings,
  setJoinQuestion,
  clearJoinQuestion,
  setJoinOpen,
  checkJoinAnswer,
  countOpenAgentConnects,
  createAgentConnect,
  getAgentConnect,
  decideAgentConnect,
  collectAgentConnect,
  sweepAgentConnects,
  listJoinRequests,
  countFactsByMaterial,
  setJoinQuestions,
  checkJoinAnswers,
  normalizeJoinAnswerV2,
  decideJoinRequest,
  createMaterial,
  deleteMaterial,
  renameMaterial,
  getMaterial,
  findMaterialByFingerprint,
  getMaterialText,
  getMaterialFile,
  findMaterial,
  updateMaterialStatus,
  updateMaterialTitle,
  updateMaterialText,
  recordFactRejections,
  listFactRejections,
  saveEveningCheck,
  getEveningCheck,
  getEveningEmailPrefs,
  setEveningEmailPrefs,
  markEveningEmailSent,
  listEveningEmailProfiles,
  emailLinkSecret,
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
