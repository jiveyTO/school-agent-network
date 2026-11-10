// School Agent — Phase 1 server (Node stdlib only, no build step).
// Start: node server.js
// The browser never calls the Meta Model API; this server does, using
// SCHOOL_AGENT_API_KEY from .env. Only data/mock-newsletter.txt is read.

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./db');
const { sendRecoveryEmail, sendEmail, isRecoveryMailConfigured } = require('./recovery-mail');
const pdfParse = require('pdf-parse');
const zlib = require('zlib');
const crypto = require('crypto');
const { mergeSameEventFacts, detectConflicts } = require('./event-dedupe');
const { eveningEmailContent, friendlyDay, escapeHtml } = require('./evening-email');

const ROOT = __dirname;
const NEWSLETTER_PATH = path.join(ROOT, 'data', 'mock-newsletter.txt');
const FACTS_PATH = path.join(ROOT, 'data', 'facts.json');
const FAMILY_PROFILE_PATH = path.join(ROOT, 'data', 'family-profile.json');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const PRIVACY_PATH = path.join(ROOT, 'public', 'privacy.html');

// Simulated scheduler moment for the Phase 2 evening check (demo only).
const SIMULATED_NOW_LABEL = 'Thursday, November 5, 2026, 7:30 PM';
const SIMULATED_TODAY = '2026-11-05';
// Real families' evening checks run on real local time (the hosted
// families are in Ontario); only the demo family keeps the simulated moment,
// so its fixed counts stay the regression baseline.
const FAMILY_TIME_ZONE = 'America/Toronto';

// The moment an evening check is written for. label goes into the prompt;
// day decides when a saved check goes stale (a new day needs a new check).
function eveningMoment(profile, overrideLabel, now) {
  if (overrideLabel) return { label: String(overrideLabel), tomorrow: '', simulated: true, day: 'simulated:' + overrideLabel };
  if (!profile || profile.is_demo) {
    return { label: SIMULATED_NOW_LABEL, tomorrow: 'Friday, November 6, 2026', simulated: true, day: 'simulated', today: SIMULATED_TODAY };
  }
  const at = now instanceof Date ? now : new Date();
  const fmt = (d, opts) => d.toLocaleString('en-US', { timeZone: FAMILY_TIME_ZONE, ...opts });
  const dayKey = (d) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: FAMILY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const tomorrow = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  return {
    label: fmt(at, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    tomorrow: fmt(tomorrow, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    simulated: false,
    day: dayKey(at),
    today: dayKey(at),
  };
}
const PRIVACY_CHECK_LINE =
  "PRIVACY CHECK: family profile data used only inside this Parent Agent run — nothing sent to the school or group.";

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const API_KEY = process.env.SCHOOL_AGENT_API_KEY || '';
// The strong model (Spark). Every call not routed below uses it (OCR,
// school/team identity reads), and it is the escalation target.
const MODEL = process.env.SCHOOL_AGENT_MODEL || 'muse-spark-1.3';
// Brief 022: model routing. Material extraction and the evening check's
// relevance filtering run on the fast model (Ember) first and escalate to
// MODEL only on a concrete failure signal (see extractionEscalationReason
// and eveningEscalationReason). SCHOOL_AGENT_MODEL_ROUTING=spark-only
// flips every call back to MODEL with today's behavior, no code change.
const FAST_MODEL = process.env.SCHOOL_AGENT_FAST_MODEL || 'muse-ember-1.0';
const MODEL_ROUTING =
  String(process.env.SCHOOL_AGENT_MODEL_ROUTING || 'ember-first').trim().toLowerCase() === 'spark-only'
    ? 'spark-only'
    : 'ember-first';
const EMBER_FIRST = MODEL_ROUTING === 'ember-first';
// USD per 1M tokens, for the usage log's cost estimate only. Ember's
// prices triple for the whole request above 200K input tokens; requests
// are per material / per check and stay far below that.
const MODEL_PRICES = {
  'muse-ember-1.0': { input: 0.10, cached: 0.004, output: 0.50, longContextTokens: 200000, longContextFactor: 3 },
  'muse-spark-1.3': { input: 1.25, cached: 1.25, output: 4.25 },
};
const EMBER_LONG_CONTEXT_TOKENS = 200000;
const API_URL =
  process.env.SCHOOL_AGENT_API_URL || 'https://api.meta.ai/v1/chat/completions';
const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const LOGIN_SCOPES = 'openid email profile';
const TEST_AUTH_ENABLED = process.env.PARENTLOOP_TEST_AUTH === '1';
// Brief 073: tests that only need a working family (not the email check
// itself) set this; never set in production (deploys take .env keys only,
// and the post-deploy gate checks /api/auth/status signup_verification).
const SIGNUP_VERIFY_SKIPPED_FOR_TESTS = process.env.PARENTLOOP_TEST_SIGNUP_VERIFIED === '1';
// Largest PDF whose original bytes are retained with its material. The cap
// also bounds how much one material can grow the durable database file,
// which is written back whole on each save. Brief 051: raised 5 MB -> 10 MB
// for real-world scanned school PDFs.
const MAX_PDF_BYTES = 10 * 1024 * 1024;
// Brief 044: pasted/picked images keep their own 5 MB cap (brief 051 is
// PDFs only), so this no longer aliases MAX_PDF_BYTES.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Uploads travel base64 inside the JSON body: a 10 MB PDF is ~13.3 MB
// encoded. Only the hub-materials route gets this larger body limit; every
// other route keeps the default in readJsonBody.
const MAX_MATERIAL_JSON_BYTES = 16 * 1024 * 1024;

// The image type is decided by the bytes themselves, never by a claimed
// name or MIME type: PNG, JPEG, and WebP are the accepted formats.
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function imageExtForMime(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

// A page with fewer non-whitespace characters than this carried almost no
// readable text — in a school PDF that usually means a flyer or graphic
// whose words live inside a picture, which pdf-parse cannot read.
const PICTURE_RISK_PAGE_CHARS = 25;
const PICTURE_RISK_AVG_CHARS_PER_PAGE = 80;
const PICTURE_RISK_BYTES_PER_CHAR = 200;

// Same rendering as pdf-parse's default pagerender, except each page's
// text is also collected so sparse or picture-only pages can be detected.
function collectingPagerender(pageTexts) {
  return function renderPage(pageData) {
    const renderOptions = {
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    };
    return pageData.getTextContent(renderOptions).then(function (textContent) {
      let lastY;
      let text = '';
      for (const item of textContent.items) {
        if (lastY == item.transform[5] || !lastY) {
          text += item.str;
        } else {
          text += '\n' + item.str;
        }
        lastY = item.transform[5];
      }
      pageTexts.push(text);
      return text;
    });
  };
}

// True when a PDF's readable text looks sparse relative to the document
// itself: a page with almost no text, very little text per page overall,
// or a large file carrying very few characters (image-heavy / scanned).
// The flag only ever adds a visible caution on the material; it never
// changes extraction.
function assessPdfPictureRisk(pageTexts, text, fileBytes) {
  const perPage = (pageTexts || []).map((t) => String(t || '').replace(/\s/g, '').length);
  const totalChars = String(text || '').replace(/\s/g, '').length;
  if (perPage.length >= 2 && perPage.some((n) => n < PICTURE_RISK_PAGE_CHARS)) return true;
  if (perPage.length >= 1 && totalChars / perPage.length < PICTURE_RISK_AVG_CHARS_PER_PAGE) return true;
  if (fileBytes > 0 && totalChars > 0 && totalChars < 2000 && fileBytes / totalChars > PICTURE_RISK_BYTES_PER_CHAR) return true;
  return false;
}

// Brief 048: OCR pass caps, in line with the file-size caps above. Only
// flagged pages are read, at most this many, one vision call per page.
const MAX_OCR_PAGES = 10;
// Brief 051d: crash guards for picture reading. Absurd images are dropped,
// not decoded (~50 MP cap); decoded pixels are downscaled to at most this
// long edge before PNG encoding; no new OCR page starts after this budget.
const OCR_MAX_IMAGE_PIXELS = 50 * 1024 * 1024;
const OCR_DOWNSCALE_LONG_EDGE = 2000;
const OCR_TIME_BUDGET_MS = 120000;
// OCR text at or above this many non-whitespace characters counts as a
// substantial recovery: the picture caution is replaced by the OCR note.
const OCR_SUBSTANTIAL_CHARS = PICTURE_RISK_PAGE_CHARS;

// 1-based page numbers the OCR pass should read: near-zero-text pages
// first; when the document is flagged only by an aggregate signal, the
// low-density pages (or, failing those, every page).
function flaggedPdfPages(pageTexts, text, fileBytes) {
  if (!assessPdfPictureRisk(pageTexts, text, fileBytes)) return [];
  const perPage = (pageTexts || []).map((t) => String(t || '').replace(/\s/g, '').length);
  let pages = perPage.map((n, i) => (n < PICTURE_RISK_PAGE_CHARS ? i + 1 : 0)).filter(Boolean);
  if (!pages.length) pages = perPage.map((n, i) => (n < PICTURE_RISK_AVG_CHARS_PER_PAGE ? i + 1 : 0)).filter(Boolean);
  if (!pages.length) pages = perPage.map((_, i) => i + 1);
  return pages.slice(0, MAX_OCR_PAGES);
}

// --- Page pictures -> PNG -------------------------------------------------
// This stack has no rasterizer (Node stdlib + the pdf.js bundled with
// pdf-parse; no canvas/poppler). A picture-carried page in a school PDF
// is an embedded image, so "rendering" a flagged page means: pull the
// page's largest embedded image out with pdf.js and re-encode its decoded
// pixels as a PNG (pure JS: zlib + CRC32 below) for the vision call.
// Pages with no embedded image yield nothing and the caller degrades to
// today's text-layer behavior.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Brief 051d: decoded pixels are normalized to { width, height, channels,
// data } first (channels 1/3/4), so the downscale and the PNG encoder each
// see one shape. pdf.js image kinds: 1 = 1bpp grayscale, 2 = RGB 24bpp,
// 3 = RGBA 32bpp. Anything else is inferred from the decoded data length.
function normalizeImagePixels(img) {
  if (!img || !img.width || !img.height || !img.data || !img.data.length) return null;
  const { width, height } = img;
  let kind = img.kind;
  if (kind !== 1 && kind !== 2 && kind !== 3) {
    if (img.data.length >= width * height * 4) kind = 3;
    else if (img.data.length >= width * height * 3) kind = 2;
    else if (img.data.length >= width * height) kind = 4; // 8-bit grayscale
    else return null;
  }
  if (kind === 1) {
    const rowBytes = Math.ceil(width / 8);
    const data = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = img.data[y * rowBytes + (x >> 3)] || 0;
        data[y * width + x] = byte & (0x80 >> (x & 7)) ? 0 : 255;
      }
    }
    return { width, height, channels: 1, data };
  }
  const channels = kind === 3 ? 4 : kind === 2 ? 3 : 1;
  const need = width * height * channels;
  if (img.data.length < need) return null;
  // A view over the decoded bytes, not a copy: the bytes are only read
  // from here on (downscale, then PNG rows), and dropping every
  // reference is what lets GC reclaim them.
  const data = Buffer.from(img.data.buffer, img.data.byteOffset, need);
  return { width, height, channels, data };
}

// Pure-JS area-average (box filter) downscale to at most maxEdge on the
// long edge. Only one page's pixels are ever live (the caller cleans the
// page up first), and the returned small copy is all the encoder keeps.
function boxDownscale(pix, maxEdge) {
  if (!pix) return null;
  if (Math.max(pix.width, pix.height) <= maxEdge) return pix;
  const scale = maxEdge / Math.max(pix.width, pix.height);
  const nw = Math.max(1, Math.round(pix.width * scale));
  const nh = Math.max(1, Math.round(pix.height * scale));
  const out = Buffer.alloc(nw * nh * pix.channels);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y / scale);
    const y1 = Math.min(pix.height, Math.max(y0 + 1, Math.ceil((y + 1) / scale)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x / scale);
      const x1 = Math.min(pix.width, Math.max(x0 + 1, Math.ceil((x + 1) / scale)));
      for (let c = 0; c < pix.channels; c++) {
        let sum = 0;
        let n = 0;
        for (let sy = y0; sy < y1; sy++) {
          const row = (sy * pix.width + x0) * pix.channels + c;
          for (let sx = x0; sx < x1; sx++) {
            sum += pix.data[row + (sx - x0) * pix.channels];
            n++;
          }
        }
        out[(y * nw + x) * pix.channels + c] = n ? Math.round(sum / n) : 0;
      }
    }
  }
  return { width: nw, height: nh, channels: pix.channels, data: out };
}

function encodePixelsAsPng(pix) {
  if (!pix || !pix.width || !pix.height || !pix.data || !pix.data.length) return null;
  const { width, height, channels } = pix;
  const colorType = channels === 3 ? 2 : channels === 4 ? 6 : 0;
  const stride = width * channels;
  const rows = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    rows[y * (1 + stride)] = 0;
    pix.data.copy(rows, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Largest-image -> pixels -> downscale -> PNG, in that order.
function encodeImageAsPng(img) {
  return encodePixelsAsPng(boxDownscale(normalizeImagePixels(img), OCR_DOWNSCALE_LONG_EDGE));
}

let pdfJsLibCache = undefined;
function pdfJsLib() {
  if (pdfJsLibCache !== undefined) return pdfJsLibCache;
  try {
    // Same pdf.js build pdf-parse uses by default. The binding must not
    // be named PDFJS: the bundle references that as a global and a
    // same-named local const puts it in the temporal dead zone.
    pdfJsLibCache = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
    pdfJsLibCache.disableWorker = true;
    // Brief 051d: the bundled pdf.js assumes a browser DOM in three
    // places. The production crash (ReferenceError: document is not
    // defined in FontLoader) and the untested JPEG native-decoder path
    // both die without these. The lib exposes its PDFJS settings object,
    // which getDocument reads for all three flags.
    pdfJsLibCache.PDFJS = pdfJsLibCache.PDFJS || {};
    pdfJsLibCache.PDFJS.maxImageSize = OCR_MAX_IMAGE_PIXELS;
    pdfJsLibCache.PDFJS.disableFontFace = true;
    pdfJsLibCache.PDFJS.isEvalSupported = false;
  } catch {
    pdfJsLibCache = null;
  }
  return pdfJsLibCache;
}

// Largest embedded image on ONE page, as a downscaled PNG. Never throws.
// The page is cleaned up before returning, and pixel/PNG references are
// dropped by the caller before the next page, so at most one page's
// pixels are ever live at once.
async function extractOnePageImagePng(doc, lib, pageNumber, imageOps) {
  let page = null;
  try {
    page = await doc.getPage(pageNumber);
    const opList = await page.getOperatorList();
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (!imageOps.has(opList.fnArray[i])) continue;
      const arg = (opList.argsArray[i] || [])[0];
      let img = null;
      if (arg && typeof arg === 'object' && arg.data) {
        img = arg; // inline image
      } else if (typeof arg === 'string') {
        try { img = page.objs.get(arg); } catch { img = null; }
        if (!img) { try { img = doc.commonObjs.get(arg); } catch { img = null; } }
      }
      if (img && img.width && img.height) {
        const area = img.width * img.height;
        if (area > bestArea) { bestArea = area; best = img; }
      }
    }
    if (!best) return null;
    const png = encodeImageAsPng(best);
    best = null;
    return png;
  } catch {
    return null;
  } finally {
    if (page) { try { page.cleanup(); } catch { /* already gone */ } }
    page = null;
  }
}

const FACT_TYPES = ['deadline', 'event', 'requirement', 'change', 'announcement'];

function nowIso() {
  return new Date().toISOString();
}

function slugify(text) {
  return String(text || 'fact')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'fact';
}

function clampConfidence(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

// Normalize a model-returned object to exactly the fields in docs/fact-schema.md.
function normalizeFact(raw, extractedAt) {
  const type = FACT_TYPES.includes(raw.type) ? raw.type : 'announcement';
  const title = String(raw.title || 'Untitled fact').trim();
  const date = raw.date ? String(raw.date).trim() : '';
  const rawId = raw.id ? String(raw.id).trim() : '';
  // Numeric-only ids (e.g. "6") are not stable/descriptive — regenerate a slug id.
  const id =
    rawId && !/^\d+$/.test(rawId)
      ? rawId
      : `fact-${slugify(title)}${date ? `-${date}` : ''}`;
  const rawScope = raw.scope ? String(raw.scope).trim().toLowerCase() : '';
  return {
    scope: ['school', 'grade', 'class'].includes(rawScope) ? rawScope : '',
    scope_value: raw.scope_value ? String(raw.scope_value).trim() : '',
    group_label: raw.group_label ? String(raw.group_label).trim() : '',
    group_summary: raw.group_summary ? String(raw.group_summary).trim() : '',
    id,
    type,
    title,
    detail: String(raw.detail || '').trim(),
    date,
    time: raw.time ? String(raw.time).trim() : '',
    applies_to: raw.applies_to ? String(raw.applies_to).trim() : '',
    action_required: Boolean(raw.action_required),
    action: raw.action ? String(raw.action).trim() : '',
    link: raw.link ? String(raw.link).trim() : '',
    source_document: raw.source_document
      ? String(raw.source_document).trim()
      : 'Maple Grove Elementary newsletter (mock)',
    source_text: String(raw.source_text || '').trim(),
    published_at: raw.published_at ? String(raw.published_at).trim() : '',
    extracted_at: extractedAt,
    confidence: clampConfidence(raw.confidence),
    supersedes: raw.supersedes ? String(raw.supersedes).trim() : '',
  };
}

function buildPrompt(newsletterText) {
  const system = [
    'You are the School Agent for Maple Grove Elementary (fictional demo school).',
    'Extract every discrete fact from the school newsletter below.',
    'Return ONLY a JSON array. No markdown fences, no commentary.',
    'Each element must have exactly these fields (same names, no extras):',
    'id (string), type (one of: deadline, event, requirement, change, announcement),',
    'title (string), detail (string), date (ISO date YYYY-MM-DD or ""), time (string or ""),',
    'applies_to (string), action_required (boolean), action (string), link (URL string or ""),',
    'source_document (string), source_text (the exact passage from the newsletter the fact came from),',
    'published_at (ISO datetime or ""), extracted_at (leave "" — the server fills it),',
    'confidence (number 0-1), supersedes (string, "" unless this fact replaces an earlier one),',
    'group_label (string: the short heading of the newsletter section this item came from, in the newsletter’s own words — e.g. "Halloween Costumes"; "" if the item has no natural section).',
    'group_summary (string: one plain sentence saying what that section is about, for a parent skimming — e.g. "Winners and prizes from the fall chocolate fundraiser."; "" if the item has no group).',
    'Rules:',
    '- source_text must be copied verbatim from the newsletter for every fact.',
    '- group_label uses the newsletter’s own section wording, not a paraphrase.',
    '- Rules, dress codes, and conduct guidelines are informational facts, not actions: set action_required false for them unless the text names a form, an order, a payment, or a deadline.',
    '- confidence reflects how certain the extraction is (1.0 = explicit in the text).',
    '- The newsletter covers the week of November 2-6, 2026 (Mon Nov 2 to Fri Nov 6, 2026).',
    '  Resolve relative dates ("Friday", "November 18") to ISO dates in 2026.',
    '  Friday of that week is 2026-11-06.',
    '- source_document should name the Maple Grove Elementary newsletter.',
    '- applies_to must name the audience explicitly: "all students" for whole-school items, "Grade N" or "Grades N-M" when the text targets a grade, "Class X" when it targets a specific class or teacher. Default to the school-wide audience; when the audience is ambiguous, choose the narrower (more specific) one.',
    '- Extract deadlines, events, requirements, and announcements. Do not invent facts.',
    '- If a fact has no date, use "" for date. Do not omit any field.',
  ].join('\n');
  const user = `Newsletter text:\n\n${newsletterText}`;
  return { system, user };
}

function extractJsonArray(text) {
  let t = String(text || '').trim();
  // Strip markdown code fences if the model added them anyway.
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = t.indexOf('[');
  if (start === -1) {
    throw new Error(
      'Model did not return a JSON array. First 300 chars: ' + t.slice(0, 300)
    );
  }
  const end = t.lastIndexOf(']');
  const slice = end > start ? t.slice(start, end + 1) : t.slice(start);
  try {
    const parsed = JSON.parse(slice);
    if (!Array.isArray(parsed)) throw new Error('Model JSON was not an array.');
    return parsed;
  } catch (err) {
    // Salvage a truncated response: keep complete objects, close the array.
    const lastBrace = slice.lastIndexOf('}');
    if (lastBrace > 0) {
      try {
        const salvaged = JSON.parse(slice.slice(0, lastBrace + 1) + ']');
        if (Array.isArray(salvaged) && salvaged.length) return salvaged;
      } catch {
        // fall through to the real parse error below
      }
    }
    throw new Error(
      'Could not parse model JSON (' + err.message + '). First 300 chars: ' +
        t.slice(0, 300)
    );
  }
}

// Brief 053: a titled extraction reply is {"material_title", "facts"}; a
// plain array (older prompt, or a model that ignored the object form)
// still parses with no title. A truncated object keeps its complete facts
// (via extractJsonArray from the "facts" key on) and any readable title.
// Quote verification adds source_transcript (an image's own read) the same
// way.
function parseExtractionReply(content) {
  const t = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    const end = t.lastIndexOf('}');
    try {
      const parsed = JSON.parse(t.slice(firstObj, end + 1));
      if (parsed && Array.isArray(parsed.facts)) {
        return {
          facts: parsed.facts,
          title: typeof parsed.material_title === 'string' ? parsed.material_title : '',
          transcript: typeof parsed.source_transcript === 'string' ? parsed.source_transcript : '',
        };
      }
    } catch {
      // truncated or malformed: salvage below
    }
    const stringField = (key) => {
      const m = t.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
      if (!m) return '';
      try { return JSON.parse('"' + m[1] + '"'); } catch { return ''; }
    };
    const factsAt = t.indexOf('"facts"');
    return {
      facts: extractJsonArray(factsAt === -1 ? t : t.slice(factsAt)),
      title: stringField('material_title'),
      transcript: stringField('source_transcript'),
    };
  }
  return { facts: extractJsonArray(t), title: '', transcript: '' };
}

// --- Quote verification ---------------------------------------------------
// A fact from a parent-added material is kept only when its quote
// (source_text) is found, by this code and not the model, in the
// material's own text. Both sides are normalized the same way: Unicode
// compatibility forms (PDF ligatures, non-breaking spaces), lowercase,
// curly quotes and en/em dashes folded to plain ones, whitespace runs
// collapsed. Quotes shorter than this many normalized characters never pass.
const MIN_QUOTE_CHARS = 8;

function normalizeQuoteText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// { ok, reason } for one quote against already-normalized source text. A
// quote wrapped in its own quotation marks is checked without them.
function verifyQuote(quote, normalizedSource) {
  const q = normalizeQuoteText(quote).replace(/^["']+|["']+$/g, '').trim();
  if (!q) return { ok: false, reason: 'no quote given' };
  if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: 'quote too short to verify' };
  if (!normalizedSource.includes(q)) return { ok: false, reason: 'quote not found in the original' };
  return { ok: true, reason: '' };
}

// --- Duplicate stop (brief 062) --------------------------------------------
// A material's fingerprint is the SHA-256 of its source text after the
// same normalization quote verification uses, so the same newsletter added
// twice to a hub (by a parent, an agent, or one of each) lands on one
// material. Pasted text and emails share one namespace ('text:'), so an
// agent's email and a parent's paste of it match. A file is matched by its
// own bytes instead: a PDF's or image's full source text is only known
// after the model reads it (and OCR reads differ run to run), and two PDFs
// can share a text layer but not their picture pages. So a file matches
// only the same file ('pdf:' bytes; 'image:' bytes plus any pasted text),
// and a pasted newsletter never swallows the uploaded original.
// '' = nothing to match.
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function materialFingerprint(text) {
  const normalized = normalizeQuoteText(text);
  return normalized ? 'text:' + sha256Hex(normalized) : '';
}

function fileFingerprint(kind, buffer, text) {
  if (!buffer || !buffer.length) return '';
  const caption = normalizeQuoteText(text);
  return kind + ':' + sha256Hex(caption ? Buffer.concat([buffer, Buffer.from('\n' + caption, 'utf8')]) : buffer);
}

// Materials whose extraction call is running right now. A matching
// material that is 'stored' but not in this set had its extraction call
// fail earlier (facts pending): a re-add retries it in place rather than
// answering "already here" for a material that never gave any notes.
const materialsExtracting = new Set();

function needsExtractionRetry(material) {
  return Boolean(material) && material.status === 'stored' && !materialsExtracting.has(material.id);
}

// The material fields every add-material response carries, from a saved row.
function materialPayload(material) {
  return {
    id: material.id,
    hub_id: material.hub_id,
    kind: material.kind,
    title: material.title,
    status: material.status,
    created_at: material.created_at,
    has_file: Boolean(material.has_file),
    file_name: material.file_name || '',
    file_mime: material.file_mime || '',
    may_have_unread_pictures: Boolean(material.may_have_unread_pictures),
    pictures_read_with_ocr: Boolean(material.pictures_read_with_ocr),
    unverified_count: Number(material.unverified_count || 0),
    email_from: material.email_from || '',
    email_date: material.email_date || '',
  };
}

// Brief 062: an email's sender and date as the agent sent them, one line
// each. A parseable date is stored as ISO so the hub shows it like other
// dates; anything else is kept as given.
function cleanEmailLine(value, max) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEmailDate(value) {
  const raw = cleanEmailLine(value, 100);
  if (!raw) return '';
  const at = new Date(raw);
  return isNaN(at.getTime()) ? raw : at.toISOString();
}

const FILE_NAME_TITLE = /\.(png|jpe?g|webp|gif|heic|pdf|docx?)\b|^(cleanshot|screen ?shot|screenshot|img[_-]|pxl[_-]|dsc[_-])|\b\d{4}-\d{2}-\d{2} at \d/i;

// A model-proposed material title, or '' when it is unusable: empty, a
// file name or file timestamp, or (for text sources) carrying a number the
// source text does not contain. Long subject lines are cut on a word.
function cleanMaterialTitle(raw, sourceText, fileName) {
  let title = String(raw || '').replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/\.$/, '').trim();
  if (!title) return '';
  if (FILE_NAME_TITLE.test(title)) return '';
  const stem = String(fileName || '').replace(/\.[a-z0-9]+$/i, '').trim().toLowerCase();
  if (stem && (title.toLowerCase() === stem || (/\d/.test(stem) && stem.length >= 6 && title.toLowerCase().includes(stem)))) return '';
  const source = String(sourceText || '');
  if (source) {
    const numbers = title.match(/\d+/g) || [];
    if (numbers.some((n) => !source.includes(n))) return '';
  }
  if (title.length > 90) {
    const cut = title.slice(0, 90);
    title = (cut.lastIndexOf(' ') > 40 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,;:—-]+$/, '') + '…';
  }
  return title;
}

// Neutral label for a file material whose content gave no usable title:
// the date ADDED in the hub list's style ("Added Mon, Nov 2" reads the
// same UTC date), e.g. "Photo — Nov 2" / "Document — Nov 2". Never the
// file name.
function neutralFileMaterialTitle(kind, at) {
  const when = at instanceof Date && !isNaN(at.getTime()) ? at : new Date();
  const day = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${kind === 'image' ? 'Photo' : 'Document'} — ${day}`;
}

function metaChoiceOf(data) {
  return (data && data.choices && data.choices[0]) || null;
}

function metaContentOf(data) {
  const choice = metaChoiceOf(data);
  return (choice && choice.message && choice.message.content) || null;
}

function metaFinishReasonOf(data) {
  const choice = metaChoiceOf(data);
  return (choice && choice.finish_reason) || null;
}

function metaContentUsable(content) {
  return typeof content === 'string' && !!content.trim();
}

// Brief 022: one usage line per Meta Model API call (every attempt,
// retries included), so the escalation rate and savings show in the logs:
//   model usage: {"purpose":"extraction","model":"muse-ember-1.0",...}
// est_usd prices the call; spark_equiv_usd prices the same tokens on
// Spark, so (spark_equiv_usd - est_usd) summed over Ember calls is the
// saving. Token counts only — no prompt or reply text is logged.
function priceModelCall(model, usage) {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const prompt = usage.prompt_tokens;
  const cached = Math.min(usage.cached_tokens, prompt);
  const factor = price.longContextTokens && prompt > price.longContextTokens ? price.longContextFactor : 1;
  const usd = ((prompt - cached) * price.input + cached * price.cached + usage.completion_tokens * price.output) * factor / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

function modelUsageOf(data) {
  const u = (data && data.usage) || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    prompt_tokens: n(u.prompt_tokens),
    cached_tokens: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
    completion_tokens: n(u.completion_tokens),
    reasoning_tokens: n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
  };
}

function logModelUsage(entry, sink) {
  if (sink && Array.isArray(sink.calls)) sink.calls.push(entry);
  console.log('model usage: ' + JSON.stringify(entry));
  if (entry.model === FAST_MODEL && entry.prompt_tokens > EMBER_LONG_CONTEXT_TOKENS) {
    console.warn(`model usage WARNING: ${entry.purpose} sent ${entry.prompt_tokens} input tokens to ${entry.model} (over ${EMBER_LONG_CONTEXT_TOKENS}; long-context price applies to the whole request)`);
  }
}

// call = { model, purpose, sink } — model defaults to MODEL (Spark);
// purpose labels the usage line; sink (optional, { calls: [] }) collects
// the usage entries for a per-extraction / per-check summary.
async function postMetaChat(system, user, maxTokens, timeoutMs, call) {
  const callTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 90000;
  const model = (call && call.model) || MODEL;
  const purpose = (call && call.purpose) || 'other';
  const sink = call && call.sink;
  async function attempt() {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), callTimeout);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.1,
          max_tokens: maxTokens,
        }),
      });
    } catch (err) {
      logModelUsage({ purpose, model, error: (err && err.name) || 'fetch failed', ms: Date.now() - startedAt }, sink);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    const bodyText = await res.text();
    if (!res.ok) {
      logModelUsage({ purpose, model, status: res.status, ms: Date.now() - startedAt }, sink);
      throw new Error(`Meta Model API error ${res.status}: ${bodyText.slice(0, 1000)}`);
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      logModelUsage({ purpose, model, status: res.status, ms: Date.now() - startedAt, non_json: true }, sink);
      throw new Error('Meta Model API returned non-JSON: ' + bodyText.slice(0, 500));
    }
    const usage = modelUsageOf(data);
    const entry = {
      purpose,
      model,
      served_model: (data && data.model) || '',
      ...usage,
      finish_reason: metaFinishReasonOf(data) || '',
      ms: Date.now() - startedAt,
      est_usd: priceModelCall(model, usage),
    };
    if (model !== MODEL) entry.spark_equiv_usd = priceModelCall(MODEL, usage);
    logModelUsage(entry, sink);
    return { data, bodyText };
  }
  // First attempt. A blank reply usually means the model spent its token
  // budget on reasoning and hit finish_reason "length" with content: null;
  // a non-blank reply with finish_reason "length" may be truncated JSON.
  // Retry ONCE in either case so every caller (identity extraction, the
  // evening check, newsletter extraction) benefits.
  const first = await attempt();
  const firstContent = metaContentOf(first.data);
  const firstLength = metaFinishReasonOf(first.data) === 'length';
  if (metaContentUsable(firstContent) && !firstLength) return firstContent;
  let second = null;
  try {
    second = await attempt();
  } catch (err) {
    // A failed retry must not hide a usable first response.
    if (metaContentUsable(firstContent)) return firstContent;
    throw err;
  }
  const secondContent = metaContentOf(second.data);
  if (metaContentUsable(secondContent)) return secondContent;
  // The retry was no better: keep a usable first response (newsletter
  // extraction can salvage a truncated array), otherwise give up.
  if (metaContentUsable(firstContent)) return firstContent;
  throw new Error(
    'Meta Model API returned no message content: ' + second.bodyText.slice(0, 500)
  );
}

// Brief 053: materials added from a file (pasted/picked image, uploaded PDF)
// get their title from the same extraction read: the reply becomes an
// object carrying material_title alongside the usual facts array. Emails
// and (Brief 072) pastes ask for it too; the demo school run keeps the
// plain-array prompt unchanged.
const JSON_ARRAY_FORMAT_LINE = 'Return ONLY a JSON array. No markdown fences, no commentary.';
const MATERIAL_TITLE_RULES = [
  '- material_title names what this document IS, for a parent scanning a list of materials.',
  '  Prefer the document’s own subject line or main heading when it has one (a short descriptor may follow, e.g. "Remembrance Day & Anti-Bullying Week — principal’s email").',
  '  Otherwise write a brief descriptive title of at most 8 words (e.g. "November lunch menu", "Photo Day notice").',
  '- material_title must be grounded in the document: no events, dates, or names that are not in it. Never use a file name, a file timestamp, or a file extension.',
].join('\n');

// Quote verification: an image has no text of its own, so the same read
// also returns its transcript, which is kept as the material's text and is
// what the image's quotes are checked against.
const TRANSCRIPT_RULES = [
  '- source_transcript is every word visible in the image, transcribed exactly as written, in reading order. Copy each fact\'s source_text from it.',
].join('\n');
const QUOTE_RULES = [
  '- source_text is checked by code against the source: copy ONE short span (a sentence or less) character-for-character from the pasted text, the document text, or source_transcript.',
  '  Do not paraphrase, fix spelling, abbreviate, or join separate passages. A fact whose source_text is not found in the source is discarded.',
].join('\n');
// Brief 061: a rule the source attaches to an item (a parenthetical "no
// masks", "helmets required", small print) must reach the note a parent
// reads, not only the quote. Same quote-verified extractions only, so the
// demo school run and existing facts are unchanged.
const RULE_CARRY_RULES = [
  '- HARD RULE: when the source attaches a condition, restriction, prohibition, requirement, or exception that changes what a family must do, bring, wear, or avoid',
  '  (e.g. "no masks", "helmets required", "no nuts", "bring indoor shoes", "no rentals on site", "please remember…"), carry that rule into the same fact\'s detail,',
  '  or into its action when it is something to do, in your own summary words. Never summarize away small print, capitals, or parentheticals that carry a rule.',
  '- Keep the rule on the fact it qualifies (the dress-up day, the skate, the lunch order). Make it a separate fact only when it has its own date or stands alone as an instruction.',
  '- When a fact\'s detail or action carries such a rule, its source_text must be one unbroken span that covers both the main claim and the rule, even if that is longer than a sentence',
  '  (for one day of a poster or calendar, copy that day\'s whole block). Never put a rule in detail or action that the source does not state.',
].join('\n');

// The extraction reply shape for one call: a plain facts array, or an
// object when a title and/or an image transcript is asked for too.
function withExtractionOptions(system, options) {
  const opts = options || {};
  let out = system;
  if (opts.withTitle || opts.withTranscript) {
    const keys = [];
    if (opts.withTitle) keys.push('"material_title": "..."');
    if (opts.withTranscript) keys.push('"source_transcript": "..."');
    keys.push('"facts": [ ... ]');
    out = out.replace(JSON_ARRAY_FORMAT_LINE, [
      'Return ONLY a JSON object of the form {' + keys.join(', ') + '}, in that order. No markdown fences, no commentary.',
      'facts is the array of extracted facts.',
    ].join('\n'));
  }
  if (opts.withTitle) out += '\n' + MATERIAL_TITLE_RULES;
  if (opts.withTranscript) out += '\n' + TRANSCRIPT_RULES;
  if (opts.verifyQuotes) out += '\n' + QUOTE_RULES + '\n' + RULE_CARRY_RULES;
  return out;
}

async function callMetaApi(newsletterText, options, call) {
  const built = buildPrompt(newsletterText);
  const system = withExtractionOptions(built.system, options);
  const user = built.user;
  // Brief 051e: extraction waits on long text and long model reasoning,
  // so it gets a 180 s call budget (vision and other calls keep the 90 s
  // default). Worst case per upload stays bounded: 120 s OCR budget +
  // 180 s extraction + parse overhead ≈ 300 s, ~2x inside the 600 s
  // Cloud Run request timeout (see the Deploy recipe).
  return postMetaChat(system, user, 32768, 180000, call);
}

// Brief 044: the same extraction pipeline, reading an image. The image is
// sent as a vision (image_url data-URL) part alongside any pasted text, and
// facts are held to the same standard: grounded in what the image shows,
// with source_text transcribed exactly from the image (or pasted text).
function buildImagePrompt(accompanyingText) {
  const system = [
    'You are the School Agent for a school hub in ParentLoop.',
    'Read the attached image of a school newsletter or notice, plus any pasted text sent with it, and extract every discrete fact.',
    'Return ONLY a JSON array. No markdown fences, no commentary.',
    'Each element must have exactly these fields (same names, no extras):',
    'id (string), type (one of: deadline, event, requirement, change, announcement),',
    'title (string), detail (string), date (ISO date YYYY-MM-DD or ""), time (string or ""),',
    'applies_to (string), action_required (boolean), action (string), link (URL string or ""),',
    'source_document (string), source_text (the exact words from the image or pasted text the fact came from, transcribed verbatim),',
    'published_at (ISO datetime or ""), extracted_at (leave "" — the server fills it),',
    'confidence (number 0-1), supersedes (string, "" unless this fact replaces an earlier one),',
    'group_label (string: the short heading of the section this item came from, in the source’s own words; "" if none).',
    'group_summary (string: one plain sentence saying what that section is about; "" if the item has no group).',
    'Rules:',
    '- Only extract what the image or pasted text actually shows. Do not invent facts, dates, or details you cannot read.',
    '- source_text must be transcribed verbatim from the image or pasted text for every fact.',
    '- Rules, dress codes, and conduct guidelines are informational facts, not actions: set action_required false for them unless the source names a form, an order, a payment, or a deadline.',
    '- confidence reflects how certain the extraction is (1.0 = clearly readable in the image).',
    '- Resolve relative dates ("Friday", "November 18") to ISO dates in 2026 when the source gives a year context; otherwise keep the clearest ISO date the source supports.',
    '- applies_to must name the audience explicitly: "all students" for whole-school items, "Grade N" or "Grades N-M" when the source targets a grade, "Class X" when it targets a specific class or teacher. Default to the school-wide audience; when ambiguous, choose the narrower one.',
    '- If a fact has no date, use "" for date. Do not omit any field.',
  ].join('\n');
  const text = String(accompanyingText || '').trim();
  const userText = text
    ? 'Pasted text sent with the image:\n\n' + text + '\n\nNow read the attached image and extract every fact from the image and the pasted text together.'
    : 'Read the attached image and extract every fact it shows.';
  return { system, userText };
}

async function callMetaApiImage(accompanyingText, image, options, call) {
  const built = buildImagePrompt(accompanyingText);
  const system = withExtractionOptions(built.system, options);
  const userText = built.userText;
  const dataUrl = `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}`;
  const user = [
    { type: 'text', text: userText },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
  // Same 180 s extraction budget as the text path (brief 051e).
  return postMetaChat(system, user, 32768, 180000, call);
}

// Brief 048: the OCR read. Same vision transport as brief 044's image
// pipeline (postMetaChat with an image_url part), but it asks only for a
// verbatim transcription; the recovered words then feed the SAME text
// extraction as the PDF's text layer, so facts stay grounded in quotes.
async function callMetaApiOcr(image) {
  const system = [
    'You are reading a picture of a school document page for ParentLoop.',
    'Transcribe every word visible in the attached image exactly as written, in reading order.',
    'Return ONLY the transcribed text. No commentary, no markdown, no JSON.',
    'Preserve names, dates, times, and places exactly. If a word is unreadable, leave it out rather than guessing.',
    'If the image contains no readable text, return an empty response.',
  ].join('\n');
  const dataUrl = `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}`;
  const user = [
    { type: 'text', text: 'Transcribe all text in this page image verbatim.' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
  return postMetaChat(system, user, 8192, undefined, { model: MODEL, purpose: 'ocr' });
}

// Read the flagged pages of a picture-risk PDF as images. Returns the
// recovered text and whether it is substantial. Never throws: any
// failure (no extractable image, vision error) yields empty text and
// the caller keeps today's text-layer-only behavior.
async function readFlaggedPagesWithOcr(pdfBuffer, pageTexts, text, logs) {
  const push = logs ? (m) => logs.push({ at: nowIso(), message: m }) : () => {};
  const pages = flaggedPdfPages(pageTexts, text, pdfBuffer ? pdfBuffer.length : 0);
  if (!pages.length) return { ocrText: '', picturesRead: false, pages: [] };
  const lib = pdfJsLib();
  if (!lib) return { ocrText: '', picturesRead: false, pages };
  const recovered = [];
  const readPages = [];
  // One page at a time: get page -> operator list -> largest image ->
  // downscale -> PNG -> vision call -> page.cleanup(), with references
  // dropped before the next page. A stop-the-clock budget keeps a slow
  // file from hitting the platform request timeout; unread pages keep
  // the material's picture caution.
  const deadline = Date.now() + OCR_TIME_BUDGET_MS;
  let doc = null;
  try {
    const task = lib.getDocument({
      data: new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.length),
      nativeImageDecoderSupport: 'none',
    });
    doc = await (task && task.promise ? task.promise : task);
    const imageOps = new Set(
      [lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintJpegXObject]
        .filter((v) => typeof v === 'number')
    );
    for (const pageNumber of pages) {
      if (Date.now() > deadline) {
        push('picture reading stopped at the time budget; unread pages keep the caution');
        break;
      }
      let png = null;
      try {
        png = await extractOnePageImagePng(doc, lib, pageNumber, imageOps);
      } catch {
        png = null;
      }
      if (!png) continue;
      readPages.push(pageNumber);
      try {
        const raw = await callMetaApiOcr({ data: png, mime: 'image/png' });
        png = null;
        const pageText = String(raw || '').trim();
        if (pageText) recovered.push(pageText);
      } catch (err) {
        png = null;
        push(`picture read failed for page ${pageNumber}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  } catch {
    // Whole-document failure: fall through with whatever was recovered
    // (possibly nothing) and keep the text-layer-only behavior.
  } finally {
    if (doc) { try { doc.destroy(); } catch { /* already gone */ } }
    doc = null;
  }
  const ocrText = recovered.join('\n\n');
  const substantial = ocrText.replace(/\s/g, '').length >= OCR_SUBSTANTIAL_CHARS;
  if (substantial) push(`pictures read with OCR: ${recovered.length} page(s) recovered text`);
  return { ocrText, picturesRead: substantial, pages: readPages };
}

function extractJsonObject(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'Model did not return a JSON object. First 300 chars: ' + t.slice(0, 300)
    );
  }
  const parsed = JSON.parse(t.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Model JSON was not an object.');
  }
  return parsed;
}

function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script\s*>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style\s*>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  const clean = t.replace(/\s+/g, ' ').trim();
  // School identity (name, postal address) often lives in the page footer,
  // past a head-only slice. Keep the head and the tail so the model sees both.
  if (clean.length <= 6000) return clean;
  return clean.slice(0, 4500) + ' … ' + clean.slice(-1500);
}

async function fetchPageText(pageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'ParentLoop/1.0', Accept: 'text/html' },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error('Page returned status ' + res.status + '.');
  return htmlToText(await res.text());
}

function extractPageTitle(html) {
  const t = String(html || '');
  const ogAfter = t.match(/<meta[^>]+property=["']og:title["'][^>]*>/i);
  if (ogAfter) {
    const c = ogAfter[0].match(/content=["']([^"']+)["']/i);
    if (c && c[1].trim()) return c[1].trim().slice(0, 200);
  }
  const ogBefore = t.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i);
  if (ogBefore && ogBefore[1].trim()) return ogBefore[1].trim().slice(0, 200);
  const m = t.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (m) return m[1].replace(/\s+/g, ' ').trim().slice(0, 200);
  return '';
}

async function fetchPageParts(pageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'ParentLoop/1.0', Accept: 'text/html' },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error('Page returned status ' + res.status + '.');
  const html = await res.text();
  return { pageText: htmlToText(html), pageTitle: extractPageTitle(html) };
}

// Best-effort school/team name from a page title such as
// "St. Richard Catholic School | Toronto Catholic District School Board".
function deriveNameFromTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const segments = t
    .split(/\s*\|\s*|\s+::\s+|\s+[—–-]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const generic = /^(home|homepage|welcome|main page)$/i;
  const pick = segments.find((s) => !generic.test(s)) || segments[0] || '';
  return pick.slice(0, 200);
}

function withTitleFallback(fields, kind, pageTitle) {
  const name = deriveNameFromTitle(pageTitle);
  if (!name || !fields) return fields;
  if (kind === 'team' || kind === 'activity') {
    if (!fields.name) return { ...fields, name };
  } else if (!fields.school_name) {
    return { ...fields, school_name: name };
  }
  return fields;
}

function cleanField(value) {
  return value ? String(value).trim() : '';
}

// First letter of a Canadian postal code maps to a province or territory.
const POSTAL_PROVINCES = {
  A: 'Newfoundland and Labrador', B: 'Nova Scotia', C: 'Prince Edward Island',
  E: 'New Brunswick', G: 'Quebec', H: 'Quebec', J: 'Quebec',
  K: 'Ontario', L: 'Ontario', M: 'Ontario', N: 'Ontario', P: 'Ontario',
  R: 'Manitoba', S: 'Saskatchewan', T: 'Alberta', V: 'British Columbia',
  X: 'Northwest Territories', Y: 'Yukon',
};

// Deterministic fallback for school pages whose text carries a Canadian
// postal address such as "2 Glass Dr., Aurora L4G 2E8". Returns
// { city, province, country } or null when no such address is present.
// Only fills fields the model left blank; never overrides the model.
function extractPostalCityProvince(pageText) {
  const t = String(pageText || '');
  const m = t.match(/,\s*([A-Za-zÀ-ÿ'’.\- ]+?)\s+[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/);
  if (!m) return null;
  const city = m[1].replace(/\s+/g, ' ').trim().replace(/^[^A-Za-zÀ-ÿ]+/, '');
  if (!/^[A-Za-zÀ-ÿ'’.\- ]{2,60}$/.test(city)) return null;
  const letter = m[0].match(/[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/)[0][0].toUpperCase();
  return { city, province: POSTAL_PROVINCES[letter] || '', country: 'Canada' };
}

async function extractIdentityFields(pageText, kind, opts) {
  if (!API_KEY) throw new Error('SCHOOL_AGENT_API_KEY is missing or empty in .env.');
  const pageTitle = (opts && opts.pageTitle) || '';
  const pageUrl = (opts && opts.pageUrl) || '';
  const ACTIVITY_SYSTEM = 'You read the web page of an activity provider (a club, studio, academy, or class: for example martial arts, dance, music, art, or swimming lessons) and return its identity as JSON. Return ONLY a JSON object, no markdown fences. Keys: name (the organization or program name as the page gives it, for example "Willow Creek Taekwondo Academy"), city (the city of its location, from the street or postal address if the page shows one). The page URL and page title are given along with the page text; the title often names the organization. Use "" for anything you cannot find.';
  const system = kind === 'activity' ? ACTIVITY_SYSTEM : kind === 'team'
    ? 'You read a team or league web page and return the team identity as JSON. Return ONLY a JSON object, no markdown fences. Keys: name (team or organization name), sport (one of: Hockey, Soccer, Baseball, Softball, Basketball, Volleyball, Lacrosse, Swimming, Other), level (House League, Select, Rep, A, AA, AAA, or "" if unclear). The page URL and page title are given along with the page text; the title often names the team. Use "" for anything you cannot find.'
    : 'You read a school web page and return the school identity as JSON. Return ONLY a JSON object, no markdown fences. Keys: school_name, city, province, country. The page URL and page title are given along with the page text; the title often names the school. Look for the school\u2019s postal or street address (often in the page footer, for example "2 Glass Dr., Aurora L4G 2E8") and take the city from that address. Fill in province and country whenever they are reasonably inferable instead of leaving them blank: infer them from the city when you know it (for example Toronto means Toronto, Ontario, Canada) or from a school board or district named on the page (for example a Toronto Catholic District School Board page means Toronto, Ontario, Canada). Use "" only for what you cannot find or reasonably infer.';
  const user =
    'Page URL:\n' + pageUrl + '\n\nPage title:\n' + pageTitle +
    '\n\nWeb page text:\n\n' + pageText;
  const content = await postMetaChat(system, user, 4096, undefined, { model: MODEL, purpose: 'identity' });
  const parsed = extractJsonObject(content);
  if (kind === 'activity') {
    const fields = { name: cleanField(parsed.name), city: cleanField(parsed.city) };
    if (!fields.city) {
      const postal = extractPostalCityProvince(pageText);
      if (postal) fields.city = postal.city;
    }
    return fields;
  }
  if (kind === 'team') {
    return { name: cleanField(parsed.name), sport: cleanField(parsed.sport), level: cleanField(parsed.level) };
  }
  const fields = {
    school_name: cleanField(parsed.school_name),
    city: cleanField(parsed.city),
    province: cleanField(parsed.province),
    country: cleanField(parsed.country),
  };
  if (!fields.city || !fields.province || !fields.country) {
    const postal = extractPostalCityProvince(pageText);
    if (postal) {
      if (!fields.city) fields.city = postal.city;
      if (!fields.province) fields.province = postal.province;
      if (!fields.country) fields.country = postal.country;
    }
  }
  return fields;
}

function buildParentPrompt(profile, facts, moment, placementLines) {
  const when = moment || eveningMoment(profile);
  const soul = profile.soul || {};
  const child = profile.child || {};
  const children = profile.children && profile.children.length ? profile.children : [child];
  const childText = children.map((c) => c.name || 'the child').join('; ');
  const hubNames = [...new Set((facts || []).map((f) => f.hub_name || f.hub).filter(Boolean))];
  const system = [
    `You are the Parent Agent for ONE family. Children: ${childText}. Facts come from the family's hubs; each fact names its hub.`,
    'Soul rules (shared core — obey exactly):',
    '- I work for this family alone.',
    "- I never share this family's private information anywhere (not to the school, not to any group, not to anyone).",
    when.simulated
      ? '- I say where my facts came from (source: School Agent facts from the Maple Grove Elementary newsletter).'
      : '- I say where my facts came from (source: the newsletters and notices in the family\'s hubs).',
    '- I am a secretary, not a decision-maker: I surface, remind, and prepare; the parent decides.',
    'Family soul:',
    `- Priorities: ${(soul.priorities || []).join('; ')}`,
    `- Nudge style: ${soul.nudge_style || 'one short message in the evening'}`,
    `- Wishes: ${(soul.wishes || []).join('; ')}`,
    when.simulated
      ? `Simulated current moment: ${when.label}. Tomorrow is Friday, November 6, 2026.`
      : `Current moment: ${when.label} (${FAMILY_TIME_ZONE} time). Tomorrow is ${when.tomorrow}.`,
    `The family belongs to these hubs and takes part in each one: ${hubNames.join(', ') || 'none'}. Belonging to a hub means that hub's context applies to the family — for example, U9 Hockey facts apply to the child because the child plays U9 hockey. Never filter out a hub's facts only because they name the hub's team, activity, or cohort.`,
    (placementLines && placementLines.length
      ? 'Placements (each child’s grade and class inside each school hub — a grade- or class-scoped fact applies only when it matches that child’s placement in the hub the fact came from):\n' +
        placementLines.map((line) => '- ' + line).join('\n')
      : 'No school-hub placements yet: only school-wide facts apply to this family.'),
    'Task: filter the hub facts for this family\'s children only, then build the evening check. Include every dated event or deadline that applies to a child, across all of the family\'s hubs.',
    'Return ONLY a JSON object. No markdown fences, no commentary. Keys exactly:',
    'relevant_facts, nudges, calendar_hold, filtered_out_count, filtering_summary.',
    'Shapes:',
    '- relevant_facts: array of objects {id, title} copied from the input facts, ONLY facts that apply to this family\'s children (school-wide, all grades, all students, the child\'s placement grade or class in the hub the fact came from, or a hub activity the family joined count as applying — hub membership means the activity applies; facts explicitly limited to other grades, groups, teams, places, or communities do not).',
    '- nudges: array of objects {fact_id, title, action, deadline, source}. Create a nudge ONLY for a fact with action_required=true whose tracked action state in profile.actions is still open. Open states: not_ordered, not_done, pending, open. Closed states (NO nudge): ordered, done, scheduled, completed, planning_to_attend. Match each action key to its fact by meaning (for example pizza_order -> the pizza orders fact, uniform_survey -> the uniform survey fact, hot_lunch -> a hot lunch ordering fact). Do NOT create nudges for untracked requirement facts in this evening check; keep them in relevant_facts only.',
    '- Each nudge action must say what to do in plain language; deadline must be the fact date; source must name the school newsletter source (use the fact source_document).',
    '- calendar_hold: ONE object {title, date, note} for the most urgent open deadline. If a pizza order fact is open, it must be the pizza order deadline (for the demo week, date "2026-11-06", Friday, November 6, 2026) and the note must mention the pizza order is not yet ordered. Otherwise use the earliest open action deadline, or null if there is none.',
    '- filtered_out_count: number of input facts NOT in relevant_facts.',
    '- filtering_summary: ONE line explaining why facts were filtered out. Name every child the kept facts apply to in that line — or say "your family" when they apply across the children — never just the first child.',
    'Keep nudge wording short and calm (evening, combined message). Do not invent facts, dates, or actions.',
  ].join('\n');
  // Brief 073: account state (whether the email is confirmed yet) is not
  // family information and stays out of the model prompt.
  const promptProfile = Object.assign({}, profile);
  delete promptProfile.email_pending;
  const user =
    'Family profile (private to this Parent Agent run):\n' +
    JSON.stringify(promptProfile, null, 2) +
    '\n\nSchool Agent facts:\n' +
    JSON.stringify(facts, null, 2);
  return { system, user };
}

// Resolves a model-returned relevant/nudge item to one of the checked facts
// (by id, then title), or null.
function makeFactLookup(facts) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const byTitle = new Map(facts.map((f) => [f.title, f]));
  return (item) => {
    if (!item) return null;
    if (typeof item === 'string') return byId.get(item) || byTitle.get(item) || null;
    if (item.fact_id && byId.has(item.fact_id)) return byId.get(item.fact_id);
    if (item.id && byId.has(item.id)) return byId.get(item.id);
    if (item.title && byTitle.has(item.title)) return byTitle.get(item.title);
    return null;
  };
}

// Brief 022: the evening check's failure signal for escalating a fast-model
// reply to MODEL. The reply has already parsed as a JSON object (a parse
// failure escalates on its own); it fails when relevant_facts is missing
// or not an array, or when more than half of the items it lists do not
// resolve to a fact that was actually checked (invented or garbled ids).
// '' means the reply is accepted.
function eveningEscalationReason(raw, facts) {
  if (!raw || !Array.isArray(raw.relevant_facts)) return 'reply has no relevant_facts array';
  const listed = raw.relevant_facts.length;
  if (!listed) return '';
  const lookupFact = makeFactLookup(facts);
  const unresolved = raw.relevant_facts.filter((item) => !lookupFact(item)).length;
  if (unresolved * 2 > listed) return `${unresolved} of ${listed} relevant items match no checked fact`;
  return '';
}

function normalizeParentResult(raw, facts) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const lookupFact = makeFactLookup(facts);

  const relevant = [];
  const seenRelevant = new Set();
  const rawRelevant = Array.isArray(raw.relevant_facts) ? raw.relevant_facts : [];
  for (const item of rawRelevant) {
    const fact = lookupFact(item);
    if (!fact || seenRelevant.has(fact.id)) continue;
    seenRelevant.add(fact.id);
    relevant.push({
      id: fact.id,
      title: fact.title,
      type: fact.type,
      date: fact.date,
      time: fact.time,
      applies_to: fact.applies_to,
      action_required: fact.action_required,
      action: fact.action,
      source: fact.source_document,
      source_text: fact.source_text,
      group_label: fact.group_label || '',
      scope: fact.scope || 'school',
      scope_value: fact.scope_value || '',
      hub_id: fact.hub_id || '',
      hub_name: fact.hub_name || fact.hub || '',
      hub: fact.hub_name || fact.hub || '',
    });
  }

  const nudges = [];
  const rawNudges = Array.isArray(raw.nudges) ? raw.nudges : [];
  for (const item of rawNudges) {
    if (!item || typeof item !== 'object') continue;
    const fact = lookupFact(item);
    nudges.push({
      fact_id: fact ? fact.id : String(item.fact_id || item.id || ''),
      title: String(item.title || (fact ? fact.title : '')).trim(),
      action: String(item.action || item.what_to_do || (fact ? fact.action : '')).trim(),
      deadline: String(item.deadline || item.date || (fact ? fact.date : '')).trim(),
      source: String(item.source || (fact ? fact.source_document : '')).trim(),
    });
  }

  let calendarHold = null;
  if (raw.calendar_hold && typeof raw.calendar_hold === 'object') {
    calendarHold = {
      title: String(raw.calendar_hold.title || '').trim(),
      date: String(raw.calendar_hold.date || '').trim(),
      note: String(raw.calendar_hold.note || '').trim(),
    };
  }

  // Fold same-event duplicates (one event named in two newsletter sections, or
  // arriving via two materials) so the evening check never reports them as
  // conflicts with each other. Duplicates scoped to different audiences stay
  // separate rows; conflict detection still skips them as the same event.
  const mergedRelevant = mergeSameEventFacts(relevant);
  const mergedIds = new Set(mergedRelevant.map((f) => f.id));

  const groupsMap = new Map();
  for (const fact of mergedRelevant) {
    const key = fact.hub_id || fact.hub_name || 'hub';
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        hub_id: fact.hub_id || '',
        hub_name: fact.hub_name || '',
        hub: fact.hub_name || '',
        facts: [],
        nudges: [],
      });
    }
    groupsMap.get(key).facts.push(fact);
  }
  for (const nudge of nudges) {
    const fact = nudge.fact_id ? byId.get(nudge.fact_id) : null;
    const key = fact ? fact.hub_id || fact.hub_name || 'hub' : 'hub';
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        hub_id: fact ? fact.hub_id || '' : '',
        hub_name: fact ? fact.hub_name || '' : '',
        hub: fact ? fact.hub_name || '' : '',
        facts: [],
        nudges: [],
      });
    }
    groupsMap.get(key).nudges.push(nudge);
  }
  const groups = Array.from(groupsMap.values());
  const conflicts = detectConflicts(mergedRelevant);

  const filteredOutCount = facts.length - mergedIds.size;
  const summaryText = String(
    raw.filtering_summary || raw.summary || ''
  ).trim() ||
    `${filteredOutCount} facts filtered out because they do not apply to this child.`;

  return {
    relevant_facts: mergedRelevant,
    nudges,
    calendar_hold: calendarHold,
    filtered_out_count: filteredOutCount,
    filtering_summary: summaryText,
    summary: summaryText,
    checked_count: facts.length,
    relevant_count: mergedRelevant.length,
    open_action_count: nudges.length,
    groups,
    grouped_by_hub: groups,
    conflicts,
    conflict_count: conflicts.length,
  };
}

async function callParentMetaApi(profile, facts, moment, placementLines, call) {
  const { system, user } = buildParentPrompt(profile, facts, moment, placementLines);
  // 16k (was 8k): the model can spend most of 8k reasoning and return no
  // content (finish_reason "length"); the evening check is now the home
  // screen and the nightly email, so it gets room to finish.
  return postMetaChat(system, user, 16384, undefined, call);
}

// What a saved evening check was computed from. When any of it changes —
// the family's facts, placements, tracked actions, children, or (for real
// families) the day — the saved check is stale and gets recomputed.
// --- Nudge rules -----------------------------------------------------------
// The model nudges only actions the family tracks (profile.actions, e.g.
// pizza_order: not_ordered). On top of that, any relevant fact that needs an
// action and is due today through DUE_SOON_DAYS days ahead is nudged too, so a
// real family's "Needs your attention tonight" is not empty while a form is
// due tomorrow. A fact the family marked done ("fact:<id>": "done" in
// profile.actions) is hidden from the nudges wherever a check is served; the
// saved check keeps it, so Undo brings it back without a new run.
const DUE_SOON_DAYS = 2;
const CLOSED_ACTION_STATES = new Set(['ordered', 'done', 'scheduled', 'completed', 'planning_to_attend']);
const FACT_DONE_PREFIX = 'fact:';

function trackedActions(actions) {
  const out = {};
  for (const [k, v] of Object.entries(actions || {})) {
    if (!k.startsWith(FACT_DONE_PREFIX)) out[k] = v;
  }
  return out;
}

function factMarkedDone(factId, actions) {
  return Boolean(factId) && CLOSED_ACTION_STATES.has(String((actions || {})[FACT_DONE_PREFIX + factId] || ''));
}

// A fact that a tracked action key names (every word of pizza_order appears
// in "Pizza orders due / Submit pizza order") stays the model's to nudge or
// not, by that action's state; the due-soon rule leaves it alone.
function factHasTrackedAction(fact, actions) {
  const text = `${fact.title || ''} ${fact.action || ''}`.toLowerCase();
  return Object.keys(trackedActions(actions)).some((key) => {
    const words = key.toLowerCase().split(/[_\s-]+/).filter(Boolean);
    return words.length > 0 && words.every((w) => text.includes(w));
  });
}

function isoPlusDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addDueSoonNudges(result, profile, moment) {
  if (!result || !moment || !moment.today) return result;
  const actions = (profile && profile.actions) || {};
  const end = isoPlusDays(moment.today, DUE_SOON_DAYS);
  const have = new Set((result.nudges || []).map((n) => n.fact_id).filter(Boolean));
  const added = [];
  for (const f of result.relevant_facts || []) {
    if (!f || !f.action_required || !f.date || have.has(f.id)) continue;
    const day = String(f.date).slice(0, 10);
    if (day < moment.today || day > end) continue;
    if (factHasTrackedAction(f, actions)) continue;
    added.push({
      fact_id: f.id,
      title: f.title,
      action: f.action || 'Action needed',
      deadline: day,
      source: f.source || '',
      due_soon: true,
      hub_id: f.hub_id || '',
    });
    have.add(f.id);
  }
  added.sort((a, b) => a.deadline.localeCompare(b.deadline));
  for (const n of added) {
    const group = (result.groups || []).find((g) => n.hub_id && g.hub_id === n.hub_id);
    if (group) group.nudges.push(n);
  }
  result.nudges = (result.nudges || []).concat(added);
  result.open_action_count = result.nudges.length;
  return result;
}

// The check as served: nudges the family marked done are left out.
function withDoneApplied(result, actions) {
  if (!result) return result;
  const keep = (n) => !(n && factMarkedDone(n.fact_id, actions));
  const nudges = (result.nudges || []).filter(keep);
  const groups = (result.groups || result.grouped_by_hub || []).map((g) => ({ ...g, nudges: (g.nudges || []).filter(keep) }));
  const doneFactIds = (result.relevant_facts || []).filter((f) => f && factMarkedDone(f.id, actions)).map((f) => f.id);
  return { ...result, nudges, open_action_count: nudges.length, groups, grouped_by_hub: groups, done_fact_ids: doneFactIds };
}

// How the page may tick things off: 'saved' for a family's own page (stored
// in its actions), 'browser' for the demo (kept in the visitor's browser only;
// the shared demo never changes), '' for an agent token.
function doneModeFor(actor, bearerAuth) {
  if (bearerAuth || !actor) return '';
  return actor.is_demo ? 'browser' : 'saved';
}

function eveningFingerprint(profile, facts, moment) {
  const basis = {
    day: moment.day,
    kids: (profile.children || [profile.child]).map((c) => (c && c.name) || ''),
    actions: trackedActions(profile.actions),
    placements: placementLinesForRun(profile),
    facts: (facts || []).map((f) => [f.id, f.title, f.detail, f.date, f.time, f.action_required, f.action, f.scope, f.scope_value]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}

// --- Evening email ---------------------------------------------------------
// Opt-in, once per local day, at the family's chosen time. A scheduler
// (Cloud Scheduler, every 15 minutes) calls POST /api/cron/evening-emails
// with EVENING_EMAIL_CRON_SECRET; families whose time has come (within a
// 3-hour window, so an outage never sends at midnight) get their last saved
// check in one email (none saved yet: none sent). Unsubscribe is a signed
// one-click link.
const EVENING_EMAIL_TIMES = [];
for (let h = 16; h <= 21; h += 1) for (const m of ['00', '30']) EVENING_EMAIL_TIMES.push(`${h}:${m}`);
const EVENING_EMAIL_WINDOW_MINUTES = 180;
const EVENING_EMAILS_PER_RUN = 5;

function localClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FAMILY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now instanceof Date ? now : new Date()).map((x) => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function clockMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 19 * 60;
}

function eveningUnsubscribeToken(profileId) {
  return crypto.createHmac('sha256', store.emailLinkSecret()).update('evening-email-off:' + profileId).digest('hex').slice(0, 40);
}

// One scheduler tick: send the evening email to every family whose time has
// come today. Never throws for one family's failure; returns counts only.
async function sendDueEveningEmails(now) {
  const clock = localClock(now);
  const out = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  const base = PUBLIC_BASE_URL || '';
  for (const candidate of store.listEveningEmailProfiles()) {
    out.considered += 1;
    const late = clock.minutes - clockMinutes(candidate.time);
    if (candidate.last_day === clock.day || late < 0 || late > EVENING_EMAIL_WINDOW_MINUTES || out.sent >= EVENING_EMAILS_PER_RUN) {
      out.skipped += 1;
      continue;
    }
    try {
      const profile = store.rowToProfile(store.getProfileRowById(candidate.id));
      if (!profile || profile.is_demo) { out.skipped += 1; continue; }
      // The email carries the family's last saved check; it never runs one
      // (a model call). Checks run only when the parent taps "Run my evening
      // check" (owner request, 2026-11-04). No saved check yet: no email.
      const latest = latestEveningCheck(profile);
      if (!latest.check) { out.skipped += 1; continue; }
      const result = latest.check;
      const content = eveningEmailContent(profile, result, {
        app: base + '/',
        unsubscribe: base + '/evening-email/off?t=' + eveningUnsubscribeToken(profile.id),
      }, clock.day);
      const sent = await sendEmail({
        to: candidate.email,
        subject: content.subject,
        text: content.text,
        html: content.html,
        headers: { 'List-Unsubscribe': '<' + base + '/evening-email/off?t=' + eveningUnsubscribeToken(profile.id) + '>' },
      });
      if (!sent || !sent.sent) { out.failed += 1; continue; }
      store.markEveningEmailSent(profile.id, clock.day);
      out.sent += 1;
    } catch (err) {
      out.failed += 1;
      console.warn('evening email failed for one family:', err && err.message ? err.message : err);
    }
  }
  return out;
}

// The hubs and facts a family's evening check reads (and an agent's context
// bundle carries): the family's own hubs only, and for a real family never a
// demo hub — the sample notes must not reach a real family's check, even if
// it joined a demo hub through a demo visitor's invite.
function checkHubsFor(profile) {
  return store.listHubsForProfile(profile.id).filter((h) => profile.is_demo || !h.is_demo);
}

function checkFactsFor(profile) {
  const ids = new Set(checkHubsFor(profile).map((h) => h.id));
  return store.listFactsForProfile(profile.id).filter((f) => ids.has(f.hub_id));
}

// The family's latest saved check plus whether it is still current.
function latestEveningCheck(profile) {
  const saved = store.getEveningCheck(profile.id);
  const fingerprint = eveningFingerprint(profile, checkFactsFor(profile), eveningMoment(profile));
  return {
    check: saved ? withDoneApplied(saved.result, profile.actions) : null,
    ran_at: saved ? saved.ran_at : '',
    moment_label: saved ? saved.moment_label : '',
    stale: !saved || saved.fingerprint !== fingerprint,
  };
}

// --- Agent context bundle (evening check mode 2b) -------------------------
// Everything a parent's own agent needs to write the evening check itself, in
// the parent's environment: the family's own children, tracked actions and
// placements, plus the shared materials and facts (with their source quotes
// and caution flags) of every hub the family belongs to — the same facts the
// prepared check reads. Never another family's children, placements, grades
// or emails, never a contributor's identity, never a demo hub for a real
// family. since (ISO time) keeps only materials and facts added after it.
const LOW_CONFIDENCE = 0.7;

function materialCautions(m) {
  const out = [];
  if (m.may_have_unread_pictures && !m.pictures_read_with_ocr) out.push('may_have_unread_pictures');
  if (m.pictures_read_with_ocr) out.push('pictures_read_with_ocr');
  if (Number(m.unverified_count) > 0) out.push('items_dropped_unverified_quote');
  return out;
}

function factCautions(f, material) {
  const out = [];
  if (!f.quote_verified) out.push('quote_not_verified');
  if (typeof f.confidence === 'number' && f.confidence > 0 && f.confidence < LOW_CONFIDENCE) out.push('low_confidence');
  if (material) {
    for (const c of materialCautions(material)) if (c !== 'items_dropped_unverified_quote') out.push(c);
  }
  return out;
}

function agentContextBundle(profile, sinceMs) {
  const after = (iso) => sinceMs == null || Date.parse(iso || '') > sinceMs;
  const hubs = [];
  let materialCount = 0;
  let factCount = 0;
  for (const hub of checkHubsFor(profile)) {
    // Arrival times for every material in the hub (a fact can be in the
    // family's scope while its material is listed under a narrower one).
    const allMaterials = new Map(store.listMaterials(hub.id).map((m) => [m.id, m]));
    const materials = store.listMaterials(hub.id, profile.id)
      .filter((m) => after(m.created_at))
      .map((m) => ({
        id: m.id,
        title: m.title,
        kind: m.kind,
        added_at: m.created_at,
        status: m.status,
        scope: m.scope,
        scope_value: m.scope_value,
        cautions: materialCautions(m),
      }));
    const facts = store.listFacts(hub.id, profile.id)
      .filter((f) => {
        const material = allMaterials.get(f.material_id);
        return after((material && material.created_at) || f.extracted_at);
      })
      .map((f) => {
        const material = allMaterials.get(f.material_id);
        return {
          id: f.id,
          material_id: f.material_id,
          added_at: (material && material.created_at) || f.extracted_at || '',
          type: f.type,
          title: f.title,
          detail: f.detail,
          date: f.date,
          time: f.time,
          applies_to: f.applies_to,
          scope: f.scope,
          scope_value: f.scope_value,
          action_required: f.action_required,
          action: f.action,
          link: f.link,
          source_document: f.source_document,
          source_quote: f.source_text,
          quote_verified: f.quote_verified,
          confidence: f.confidence,
          supersedes: f.supersedes,
          group_label: f.group_label,
          published_at: f.published_at,
          cautions: factCautions(f, material),
        };
      });
    materialCount += materials.length;
    factCount += facts.length;
    hubs.push({
      id: hub.id,
      name: hub.name,
      kind: hub.kind || 'other',
      school_name: hub.school_name || '',
      city: hub.city || '',
      province: hub.province || '',
      country: hub.country || '',
      website: hub.website || '',
      placements: store.effectivePlacements(hub.id, profile.id).map((p) => ({
        child_id: p.child_id,
        child_name: p.child_name,
        grade: p.grade || '',
        class: p.class || '',
      })),
      materials,
      facts,
    });
  }
  const children = (profile.children || [profile.child]).filter(Boolean).map((c) => ({ id: c.id || '', name: c.name || '' }));
  return {
    ok: true,
    generated_at: nowIso(),
    since: sinceMs == null ? '' : new Date(sinceMs).toISOString(),
    family: {
      children,
      actions: profile.actions || {},
      nudge_style: (profile.soul && profile.soul.nudge_style) || '',
    },
    hubs,
    counts: { hubs: hubs.length, materials: materialCount, facts: factCount },
    caution_flags: {
      quote_not_verified: 'The quote was not code-checked against the source text. Treat the item with care and prefer the source document.',
      low_confidence: 'The extractor was unsure about this item.',
      may_have_unread_pictures: 'The source has pages that are mostly pictures; some notes may be missing.',
      pictures_read_with_ocr: 'Some text was read from pictures and may contain reading errors.',
      items_dropped_unverified_quote: 'Some items in this material were dropped because their quotes did not verify.',
    },
  };
}

// Structured placements for the prompt's profile JSON: each child's grade and
// class in each school hub. Team hubs carry no placement.
function placementRecordsForRun(profile) {
  const records = [];
  for (const hub of checkHubsFor(profile)) {
    if ((hub.kind || 'other') === 'team') continue;
    for (const p of store.effectivePlacements(hub.id, profile.id)) {
      records.push({ hub: hub.name, child: p.child_name, grade: p.grade || '', class: p.class || '' });
    }
  }
  return records;
}

function placementLinesForRun(profile) {
  const lines = [];
  for (const hub of checkHubsFor(profile)) {
    if ((hub.kind || 'other') === 'team') {
      lines.push(`${hub.name} is a team hub: no placement, its notes apply to the whole family.`);
      continue;
    }
    const placed = store.effectivePlacements(hub.id, profile.id);
    const parts = placed.map((p) =>
      `${p.child_name} — ${p.grade || 'no grade yet'}${p.class ? ', Class ' + p.class : ''}`
    );
    lines.push(`${hub.name}: ${parts.join('; ') || 'no children placed yet'}`);
  }
  return lines;
}

async function runParentAgent(logs, simulatedLabel, viewer) {
  const push = (message) => logs.push({ at: nowIso(), message });
  const moment = eveningMoment(viewer, simulatedLabel);
  push('evening check started');
  push(moment.simulated ? `simulated time: ${moment.label}` : `current time: ${moment.label}`);
  const profile = viewer;
  if (!profile) {
    throw new Error('No family profile found — finish setup or switch to the demo family.');
  }
  // A family whose hubs have no notes yet (a brand-new member, a new hub)
  // gets a real, saved empty check at once — no model call, no waiting.
  if (!checkFactsFor(profile).length) return emptyEveningCheck(profile, moment, simulatedLabel, push);
  if (!API_KEY) {
    throw new Error(
      'SCHOOL_AGENT_API_KEY is missing or empty in .env. Add it and restart the server.'
    );
  }
  if (profile.is_demo && fs.existsSync(FAMILY_PROFILE_PATH)) {
    try {
      const seed = JSON.parse(fs.readFileSync(FAMILY_PROFILE_PATH, 'utf8'));
      if (seed.soul && Array.isArray(seed.soul.wishes)) {
        profile.soul.wishes = seed.soul.wishes;
      }
    } catch {
      // Demo wishes are optional; the stored soul still drives the run.
    }
  }
  const facts = checkFactsFor(profile);
  const hubs = checkHubsFor(profile);
  const childNames = (profile.children || [profile.child])
    .map((c) => c && c.name)
    .filter(Boolean);
  const childName = childNames.join(' and ') || 'the child';
  push(`family profile loaded for ${childName} (private to this Parent Agent)`);
  push(`${hubs.length} ${hubs.length === 1 ? 'hub' : 'hubs'} checked: ${hubs.map((h) => h.name).join(', ') || 'none yet'}`);
  push(`${facts.length} facts checked against the family profile`);
  const promptProfile = { ...profile, actions: trackedActions(profile.actions), placements: placementRecordsForRun(profile) };
  const placementLines = placementLinesForRun(profile);
  const raw = await routedEveningRead(promptProfile, facts, moment, placementLines, push);
  const full = addDueSoonNudges(normalizeParentResult(raw, facts), profile, moment);
  const result = withDoneApplied(full, profile.actions);
  push(
    `${result.relevant_count} ${result.relevant_count === 1 ? 'fact' : 'facts'} relevant to ${childName}`
  );
  push(
    `${result.filtered_out_count} ${result.filtered_out_count === 1 ? 'fact' : 'facts'} filtered out — ${result.filtering_summary}`
  );
  push(
    `${result.open_action_count} open ${result.open_action_count === 1 ? 'action needs' : 'actions need'} a nudge`
  );
  if (result.calendar_hold) {
    push(
      `calendar hold created: ${result.calendar_hold.title} on ${result.calendar_hold.date}`
    );
  }
  if (result.conflicts && result.conflicts.length) {
    for (const conflict of result.conflicts) push(`CONFLICTS: ${conflict.message}`);
  }
  push(PRIVACY_CHECK_LINE);
  // The latest check is saved per family so the home screen, agents, and
  // the evening email can show it without recomputing (an explicit
  // simulated_now override is a what-if and is not saved).
  if (!simulatedLabel) {
    store.saveEveningCheck(profile.id, {
      result: full,
      ran_at: nowIso(),
      moment_label: moment.label,
      fingerprint: eveningFingerprint(profile, facts, moment),
    });
  }
  return result;
}

// Brief 022: the evening check's model call. Ember-first: the fast model's
// reply is accepted unless the call fails (other than a timeout), the reply
// does not parse, or eveningEscalationReason flags it; then the check is
// redone once on MODEL and that reply is used (validated as before).
// spark-only: one MODEL call, exactly as before brief 022.
async function routedEveningRead(promptProfile, facts, moment, placementLines, push) {
  const sink = { calls: [] };
  const readOn = async (model) => {
    push(`API called: POST ${API_URL} (model: ${model})`);
    const content = await callParentMetaApi(promptProfile, facts, moment, placementLines, { model, purpose: 'evening_check', sink });
    push('API responded — validating filtering result');
    return extractJsonObject(content);
  };
  let raw = null;
  let model = MODEL;
  let reason = '';
  if (EMBER_FIRST) {
    model = FAST_MODEL;
    try {
      raw = await readOn(FAST_MODEL);
      reason = eveningEscalationReason(raw, facts);
    } catch (err) {
      if (extractionTimedOut(err)) throw err;
      reason = 'reply failed: ' + shortErrorText(err);
    }
    if (reason) {
      push(`${FAST_MODEL} reply not accepted (${reason}) — escalating to ${MODEL}`);
      model = MODEL;
      raw = await readOn(MODEL);
    }
  } else {
    raw = await readOn(MODEL);
  }
  logModelRoute('evening_check', { routing: MODEL_ROUTING, accepted_model: model, escalated: Boolean(reason), reason, facts_checked: facts.length }, sink);
  return raw;
}

// A log-safe failure label: never the model's reply text or an API body.
function shortErrorText(err) {
  const message = err && err.message ? String(err.message) : String(err);
  const api = message.match(/^Meta Model API (error \d+|returned non-JSON|returned no message content)/);
  if (api) return 'Meta Model API ' + api[1];
  if ((err && err.name === 'SyntaxError') || /^Could not parse model JSON/.test(message)) return 'reply JSON did not parse';
  if (/^Model (did not return|JSON was not)/.test(message)) return message.split('. First ')[0].slice(0, 60);
  if (/fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket/i.test(message)) return 'connection failed';
  return 'reply failed validation';
}

function extractionTimedOut(err) {
  if (!err) return false;
  const message = err.message ? String(err.message) : String(err);
  return err.name === 'AbortError' || /aborted|abort|timed out|timeout/i.test(message);
}

// One routing line per extraction / evening check: which model's result was
// accepted, whether it escalated and why, and the summed usage of every
// call it made. Count "escalated":true over all lines for the rate.
function logModelRoute(purpose, fields, sink) {
  const calls = (sink && sink.calls) || [];
  const sum = (k) => calls.reduce((n, c) => n + (Number(c[k]) || 0), 0);
  const entry = {
    purpose,
    ...fields,
    calls: calls.length,
    prompt_tokens: sum('prompt_tokens'),
    completion_tokens: sum('completion_tokens'),
    est_usd: Math.round(sum('est_usd') * 1e6) / 1e6,
  };
  console.log('model route: ' + JSON.stringify(entry));
  return entry;
}

function emptyEveningCheck(profile, moment, simulatedLabel, push) {
  const hubs = checkHubsFor(profile);
  const childName = (profile.children || [profile.child]).map((c) => c && c.name).filter(Boolean).join(' and ') || 'the child';
  push(`family profile loaded for ${childName} (private to this Parent Agent)`);
  push(`${hubs.length} ${hubs.length === 1 ? 'hub' : 'hubs'} checked: ${hubs.map((h) => h.name).join(', ') || 'none yet'}`);
  push('0 facts checked — no school notes in these hubs yet; no model call');
  push(PRIVACY_CHECK_LINE);
  const result = {
    ...normalizeParentResult({ relevant_facts: [], nudges: [], calendar_hold: null }, []),
    empty: true,
    empty_reason: hubs.length ? 'no_notes_yet' : 'no_hubs_yet',
    filtering_summary: hubs.length
      ? 'Your hubs have no school notes yet. When a newsletter or notice is added, tonight’s check picks it up.'
      : 'You are not in any hubs yet. Join or start a hub to get an evening check.',
  };
  result.summary = result.filtering_summary;
  if (!simulatedLabel) {
    store.saveEveningCheck(profile.id, {
      result,
      ran_at: nowIso(),
      moment_label: moment.label,
      fingerprint: eveningFingerprint(profile, [], moment),
    });
  }
  return result;
}

function narrowestScope(facts) {
  let best = { scope: 'school', value: '' };
  for (const f of facts || []) {
    const scope = String((f && f.scope) || 'school').toLowerCase();
    if (scope === 'class') return { scope, value: f.scope_value || '' };
    if (scope === 'grade' && best.scope !== 'class') {
      best = { scope, value: f.scope_value || '' };
    }
  }
  return best;
}

const EMPTY_EXTRACTION_MESSAGE =
  'We couldn\'t pull any notes out of that one — try pasting it again.';

// Brief 051e: an extraction CALL failure (timeout/abort, connection drop,
// model HTTP error) must not lose the upload. The material stays 'stored'
// with its text and the caller reports facts_pending + a plain message.
// An empty extraction RESULT (the model returned no facts twice) keeps
// today's 500 + 'failed' behavior, pinned by extraction-retry.test.js.
const FACTS_PENDING_MESSAGE =
  'Saved, but ParentLoop could not pull out the notes this time — the read did not finish. The text is kept, so nothing is lost.';

function extractionCallFailed(err) {
  if (!err) return false;
  const message = err.message ? String(err.message) : String(err);
  if (message === EMPTY_EXTRACTION_MESSAGE) return false;
  return (
    err.name === 'AbortError' ||
    /aborted|abort|timed out|timeout|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE/i.test(message) ||
    /^Meta Model API error \d+/.test(message)
  );
}

// When stampSource is true (parent-added paste/PDF/email material), the server
// stamps every extracted fact's source_document from the actual material being
// extracted — the material's title when it has one, otherwise the hub's display
// name — replacing whatever the model returned for that field (it copies the
// extraction prompt's Maple Grove example). The demo school run passes no flag,
// so seeded/demo labels stay exactly as they are.
// Brief 053: titleFrom = { fileName } asks the same read for a material
// title; a usable one replaces the material's neutral title BEFORE facts
// are stamped, so source_document and group labels carry it too.
// Quote verification: verifyQuotes keeps only facts whose quote is found in
// the material's own text (pasted text; a PDF's text layer plus OCR reads;
// an image's transcript from this same read). Dropped items go to the
// material's audit log and its unverified count. Off for the demo run.
// Brief 022: the escalation rule for a fast-model (Ember) extraction. The
// read is redone on MODEL (Spark) when any of these holds, else accepted:
//   - the call failed (HTTP error, non-JSON, no content) or the reply did
//     not parse — but not a timeout, which keeps the facts_pending path;
//   - it yielded zero facts from a non-trivial source;
//   - quote verification is on and fewer than half of its facts passed
//     (QUOTE_PASS_FLOOR), i.e. it quoted text the source does not contain.
// '' means accepted.
const QUOTE_PASS_FLOOR = 0.5;
function extractionEscalationReason(read, nonTrivial, verifyQuotes) {
  if (read.error) return 'reply failed: ' + shortErrorText(read.error);
  if (!read.facts.length) return nonTrivial ? 'zero facts from a non-trivial source' : '';
  if (verifyQuotes && read.verified.length < read.facts.length * QUOTE_PASS_FLOOR) {
    return `quote verification kept ${read.verified.length} of ${read.facts.length}`;
  }
  return '';
}

async function extractAndSaveFacts(newsletterText, logs, hubId, materialId, scopeOverride, stampSource, image, titleFrom, verifyQuotes) {
  const push = (message) => logs.push({ at: nowIso(), message });
  const hasImage = Boolean(image && image.data && image.mime);
  const modelOptions = {
    withTitle: Boolean(titleFrom),
    withTranscript: Boolean(verifyQuotes && hasImage),
    verifyQuotes: Boolean(verifyQuotes),
  };
  const sink = { calls: [] };
  const callModel = (model) => {
    const call = { model, purpose: 'extraction', sink };
    return hasImage ? callMetaApiImage(newsletterText, image, modelOptions, call) : callMetaApi(newsletterText, modelOptions, call);
  };
  const parseReply = (reply) => (titleFrom || verifyQuotes
    ? parseExtractionReply(reply)
    : { facts: extractJsonArray(reply), title: '', transcript: '' });
  // One read on one model: call, parse, normalize, and (when on) check
  // each quote against the source. No side effects, so a read that is
  // escalated past leaves nothing behind. With catchErrors, a failed call
  // or unparseable reply comes back as { error } instead of throwing.
  const readOn = async (model, catchErrors) => {
    let parsedReply;
    try {
      push(`API called: POST ${API_URL} (model: ${model})`);
      const content = await callModel(model);
      push('API responded — parsing facts');
      parsedReply = parseReply(content);
    } catch (err) {
      if (!catchErrors || extractionTimedOut(err)) throw err;
      return { model, error: err, facts: [], verified: [], rejected: [], title: '', transcript: '' };
    }
    const extractedAt = nowIso();
    const facts = parsedReply.facts.map((f) => normalizeFact(f, extractedAt));
    // Guarantee id uniqueness even if two facts slugify the same.
    const seen = new Set();
    for (const fact of facts) {
      if (seen.has(fact.id)) {
        let n = 2;
        while (seen.has(`${fact.id}-${n}`)) n += 1;
        fact.id = `${fact.id}-${n}`;
      }
      seen.add(fact.id);
    }
    const transcript = parsedReply.transcript || '';
    const verified = [];
    const rejected = [];
    if (verifyQuotes) {
      const readText = String(transcript).trim();
      const source = normalizeQuoteText([newsletterText, readText].filter(Boolean).join('\n'));
      for (const fact of facts) {
        const check = verifyQuote(fact.source_text, source);
        if (check.ok) verified.push({ ...fact, quote_verified: true });
        else rejected.push({ title: fact.title, detail: fact.detail, quote: fact.source_text, reason: check.reason });
      }
    }
    return { model, error: null, facts, verified, rejected, title: parsedReply.title || '', transcript };
  };
  // The model sometimes returns a valid but empty fact list for a
  // non-trivial source. Retry the model call ONCE before giving up, so one
  // flaky reply cannot silently save zero facts as a success. An image
  // counts as a non-trivial source on its own. Ember-first, that one
  // retry is the escalation to MODEL.
  const nonWhitespace = String(newsletterText || '').replace(/\s/g, '').length;
  const nonTrivial = nonWhitespace > 100 || hasImage;
  let read;
  let reason = '';
  if (EMBER_FIRST) {
    const first = await readOn(FAST_MODEL, true);
    reason = extractionEscalationReason(first, nonTrivial, verifyQuotes);
    read = first;
    if (reason) {
      push(`${FAST_MODEL} extraction not accepted (${reason}) — escalating to ${MODEL}`);
      let second;
      try {
        second = await readOn(MODEL, false);
      } catch (err) {
        // A failed escalation must not hide usable first-read facts.
        if (first.error || !first.verified.length) throw err;
        second = null;
        push(`${MODEL} read failed — keeping the ${FAST_MODEL} read`);
      }
      // Spark's read wins unless it kept fewer notes than Ember's did.
      const kept = (r) => (verifyQuotes ? r.verified.length : r.facts.length);
      if (second && (first.error || kept(second) >= kept(first))) {
        read = { ...second, title: second.title || first.title, transcript: second.transcript || first.transcript };
      } else if (second) {
        push(`${MODEL} kept fewer notes than ${FAST_MODEL} — keeping the ${FAST_MODEL} read`);
      }
    }
  } else {
    read = await readOn(MODEL, false);
    if (read.facts.length === 0 && nonTrivial) {
      reason = 'zero facts from a non-trivial source';
      push('no facts parsed from a non-trivial source — retrying the model call once');
      const second = await readOn(MODEL, false);
      read = { ...second, title: second.title || read.title, transcript: second.transcript || read.transcript };
    }
  }
  logModelRoute('extraction', {
    routing: MODEL_ROUTING,
    accepted_model: read.model,
    escalated: EMBER_FIRST && Boolean(reason),
    reason,
    material_id: materialId || '',
    image: hasImage,
    facts: read.facts.length,
    quotes_verified: verifyQuotes ? read.verified.length : null,
    quotes_rejected: verifyQuotes ? read.rejected.length : null,
  }, sink);
  push(`extraction accepted from ${read.model}`);
  if (read.facts.length === 0 && nonTrivial) {
    // Every material route marks the material 'failed' on a throw and
    // returns this message, so the hub list shows the failure instead of
    // an empty success. Tiny pastes keep today's behavior below.
    throw new Error(EMPTY_EXTRACTION_MESSAGE);
  }
  if (titleFrom && materialId) {
    const title = cleanMaterialTitle(read.title, hasImage ? '' : newsletterText, titleFrom.fileName);
    // Brief 072: a rename made while the read was running wins.
    const current = typeof titleFrom.ifTitle === 'string' ? store.getMaterial(materialId) : null;
    if (current && String(current.title || '') !== titleFrom.ifTitle) {
      push('material was renamed during the read — keeping its name');
    } else if (title) {
      store.updateMaterialTitle(materialId, title);
      push('material titled from its content');
    } else {
      push('no usable title in the read — material keeps its neutral label');
    }
  }
  let facts = read.facts;
  push(`${facts.length} facts extracted`);
  if (verifyQuotes) {
    const readText = String(read.transcript || '').trim();
    if (hasImage && materialId && readText) {
      const pasted = String(newsletterText || '').trim();
      store.updateMaterialText(materialId, pasted ? pasted + '\n\n' + readText : readText);
    }
    if (materialId) store.recordFactRejections(hubId, materialId, read.rejected);
    push(`quotes verified against the original: ${read.verified.length} kept, ${read.rejected.length} left out`);
    facts = read.verified;
  }
  let materialTitle = '';
  if (materialId) {
    try {
      const material = store.getMaterial(materialId);
      materialTitle = material && material.title ? String(material.title) : '';
    } catch {
      materialTitle = '';
    }
  }
  let stampedSource = '';
  if (stampSource) {
    stampedSource = materialTitle;
    if (!stampedSource && hubId) {
      try {
        const hub = store.getHub(hubId);
        stampedSource = hub && hub.name ? String(hub.name) : '';
      } catch {
        stampedSource = '';
      }
    }
  }
  const withHub = facts.map((f) => {
    const stamped = scopeOverride
      ? { ...f, hub_id: hubId || '', material_id: materialId || '', scope: scopeOverride.scope, scope_value: scopeOverride.value, group_label: f.group_label || materialTitle }
      : { ...f, hub_id: hubId || '', material_id: materialId || '', group_label: f.group_label || materialTitle };
    if (stampedSource) stamped.source_document = stampedSource;
    return stamped;
  });
  // One newsletter section can name an event the Looking Ahead list repeats:
  // fold those same-event duplicates before saving so the hub facts list stays
  // clean. Cross-material duplicates merge again inside insertFacts.
  const deduped = mergeSameEventFacts(withHub);
  if (deduped.length !== withHub.length) {
    push(`merged ${withHub.length - deduped.length} same-event duplicate(s)`);
  }
  if (hubId) {
    store.insertFacts(hubId, materialId || '', deduped, true);
    if (materialId) {
      const materialScope = scopeOverride || narrowestScope(deduped);
      store.updateMaterialScope(materialId, materialScope.scope, materialScope.value);
    }
  }
  push('facts saved');
  return deduped;
}

// One-box adding has no title field: a paste starts with a short title
// from its first line (Brief 072: one line, capped, never the whole
// paste), and the extraction read then proposes a content title.
function deriveMaterialTitle(text, now) {
  return store.derivePasteTitle(text, now);
}

// Brief 072: a title the app set itself, which a content title may replace
// when an earlier failed read is retried. Anything else is a parent's
// rename and always stays.
function isAutoMaterialTitle(material, text, emailMeta) {
  const title = String((material && material.title) || '');
  if (!title) return true;
  if (/^(Photo|Document) — [A-Z][a-z]{2} \d{1,2}$/.test(title)) return true;
  if (/^Newsletter — \d{4}-\d{2}-\d{2}$/.test(title)) return true;
  if (title === deriveMaterialTitle(text) || title === store.legacyPasteTitle(text)) return true;
  return Boolean(emailMeta && emailMeta.subject && title === emailMeta.subject);
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('That website link doesn’t look complete — paste the full address starting with http:// or https://.');
  }
  return raw;
}

function resolveAudience(actor, audience, hubId) {
  const mode = String(audience || 'auto').toLowerCase();
  if (mode === '' || mode === 'auto') return null;
  if (mode === 'school') return { scope: 'school', value: '' };
  const placed = actor ? store.effectivePlacements(hubId, actor.id) : [];
  if (mode === 'grade') {
    const grade = placed.map((p) => p.grade).find((g) => String(g || '').trim());
    if (!grade) throw new Error('Add your child’s grade for this hub first, then choose that scope.');
    return { scope: 'grade', value: store.canonicalGrade(String(grade)) };
  }
  if (mode === 'class') {
    const className = placed.map((p) => p.class).find((c) => String(c || '').trim());
    if (!className) throw new Error('Add your child’s class for this hub first, then choose that scope.');
    return { scope: 'class', value: String(className) };
  }
  throw new Error('Choose who this is for: automatic, whole school, grade, or class.');
}

async function runSchoolAgent(logs) {
  const push = (message) => logs.push({ at: nowIso(), message });
  push('run started');
  if (!API_KEY) {
    throw new Error(
      'SCHOOL_AGENT_API_KEY is missing or empty in .env. Add it and restart the server.'
    );
  }
  push(`newsletter loaded: data/mock-newsletter.txt`);
  const newsletterText = fs.readFileSync(NEWSLETTER_PATH, 'utf8');
  const demoHub = store.getDemoHub();
  let material = demoHub ? store.findMaterial(demoHub.id, 'Maple Grove newsletter (mock)') : null;
  if (demoHub && !material) {
    const demo = store.getDemoProfile();
    material = store.createMaterial(demoHub.id, demo ? demo.id : '', 'paste', 'Maple Grove newsletter (mock)', newsletterText, 'stored');
  }
  return extractAndSaveFacts(
    newsletterText,
    logs,
    demoHub ? demoHub.id : '',
    material ? material.id : ''
  );
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const SESSION_COOKIE = 'parentloop_session';

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function sessionUsesSecureCookie(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwarded === 'https') return true;
  if (forwarded === 'http') return false;
  return Boolean(req.socket && req.socket.encrypted);
}

// The session captured when a request arrives can predate a family switch
// from a concurrent request, so re-read the row and resolve the viewer late.
function currentViewer(session) {
  const fresh = session && session.id ? store.getSession(session.id) : null;
  return store.getSessionViewer(fresh || session);
}

// Brief 046: agent tokens arrive as `Authorization: Bearer pl_agent_…` and
// resolve to exactly one family (never the demo family). Management of
// tokens stays browser-only; a token can never mint or revoke tokens.
const AGENT_TOKEN_401 = 'That agent token is not valid. Check it, or ask the parent for a fresh one.';
// Brief 064: an Authorization header that carries no Bearer token at all
// (empty, "Bearer" alone, another scheme, a bare token) — usually an unset
// $TOKEN in the caller. Refused, never served the session's (demo) view.
const AGENT_TOKEN_MISSING_401 = 'The Authorization header didn’t carry a token — send Authorization: Bearer <token>.';
const AGENT_TOKEN_MANAGE_403 = 'Agent tokens are managed in the browser — open My family to see them.';

// Brief 047: public machine-readable front door for agents. Static by
// design — it describes the shipped agent surface and contains no family,
// hub, or member data. Keep it truthful: paths/methods mirror the handlers
// below (lookup 045, family/hubs/placements/materials/invite-accept 046).
const AGENT_RECIPE = [
  {
    step: 1,
    action: 'Look up the hub before creating anything',
    method: 'GET',
    path: '/api/hubs/lookup?school={school}&city={city}&province={province}&country={country}',
    description: 'Hub lookup first. match is exact, similar, or none; an exact or similar match already has a hub — do not create a duplicate (create returns 409 for an exact school).',
  },
  {
    step: 2,
    action: 'Join/redeem an invite, or create the hub when lookup found none',
    method: 'POST',
    path: '/api/join/{token}/accept',
    alternate: { method: 'POST', path: '/api/hubs' },
    description: 'If a parent gave you an invite link but no token, POST /api/join/{token}/connect, show the parent the approval_url AND the user_code, and poll /api/agent-connect/{request_id}/token with your poll_secret every `interval` seconds until it returns your token. The parent answers any join question on that approval page — never ask them to tell you the answer. If the parent has no family yet, the approval page sets one up first and ParentLoop emails them a 6-digit code to confirm their address (needs_email_code) — that is an expected step, not an error: tell your parent to check their inbox and enter the code on the page, and keep polling. If membership is pending_approval, tell the parent the hub admin must let them in, and watch GET /api/hubs → pending_hubs until the hub moves to hubs. With a token already, redeem the invite with POST /api/join/{token}/accept (202 means it waits for the admin; 409 needs_answer means ask the parent to open the invite link in their browser). If lookup returned none, create the hub with POST /api/hubs. If create returns 409, the school already has a hub — ask the parent for an invite instead of forcing a duplicate.',
  },
  {
    step: 3,
    action: 'Save placements for the family in the hub',
    method: 'POST',
    path: '/api/hubs/{hub_id}/placements',
    description: 'Read GET /api/family-profile for the family child ids, then save placements with POST /api/hubs/{hub_id}/placements as { placements: [{ child_id, grade, class }] }. Re-read the hub and check needs_placement is false.',
  },
  {
    step: 4,
    action: 'Report back to the parent',
    method: 'GET',
    path: '/api/hubs/{hub_id}',
    description: 'Confirm with GET /api/hubs/{hub_id} (or GET /api/hubs), then report back which hub you joined or created, the placements you saved, and any material you added.',
  },
];
const AGENT_MANIFEST = {
  service: 'ParentLoop',
  name: 'ParentLoop',
  purpose: 'ParentLoop turns school newsletters and notices in a family hub into the few things a parent needs to do, in time.',
  description: 'ParentLoop turns school newsletters and notices in a family hub into the few things a parent needs to do, in time.',
  version: 1,
  auth: {
    scheme: 'Bearer',
    type: 'bearer',
    header: 'Authorization',
    format: 'Authorization: Bearer <token>',
    issued_by: 'A human parent issues a Bearer agent token from My family → Agent access in ParentLoop.',
    how_to_get: 'Ask the parent to open My family → Agent access, create a named token, and give it to you. The token is shown only once, so store it like a password. If the parent gave you an invite link instead, you can get a token by asking to join: POST /api/join/{token}/connect, then the parent taps one approval link (see recipe step 2).',
    scope: 'Tokens are scoped to one family: the token acts only as that family and can only reach that family\'s hubs.',
    scoped_to: 'one family',
    revocable: true,
    notes: [
      'Tokens are revocable: the parent can revoke a token at any time in My family → Agent access, and a revoked token stops working immediately.',
      'A token can never issue, list, or revoke agent tokens — token management is browser-only.',
      'Send the token on every agent request as Authorization: Bearer <token>. A request whose Authorization header is not a valid token is refused with 401. With no Authorization header at all you get the browser session\'s view, which for a cookie-less client is the public demo — never use that as a family\'s data.',
    ],
  },
  endpoints: [
    {
      name: 'hub lookup',
      method: 'GET',
      path: '/api/hubs/lookup',
      auth: 'none (public)',
      query: { school: 'school name (or school_name)', city: 'city', province: 'state or province', country: 'country' },
      description: 'Find whether a school already has a hub. Returns { match: exact|similar|none, hub } with a public hub card only (name, place, family count, founder first name) — no member data.',
    },
    {
      name: 'family read',
      method: 'GET',
      path: '/api/family-profile',
      auth: 'Bearer agent token',
      description: 'Read the token\'s own family profile ({ profile }), including child ids needed to save placements.',
    },
    {
      name: 'my hubs',
      method: 'GET',
      path: '/api/hubs',
      auth: 'Bearer agent token',
      description: 'List the hubs the token\'s family belongs to ({ hubs }).',
    },
    {
      name: 'create hub',
      method: 'POST',
      path: '/api/hubs',
      auth: 'Bearer agent token',
      body: { school_name: 'school name', city: 'city', province: 'state or province', country: 'country', kind: 'school' },
      description: 'Create a hub for the token\'s family. For a school send kind school with school_name, city, province, country. An existing exact school returns 409 with the existing hub — never create a duplicate.',
    },
    {
      name: 'placements',
      method: 'POST',
      path: '/api/hubs/{hub_id}/placements',
      auth: 'Bearer agent token',
      body: { placements: [{ child_id: 'id from family read', grade: 'Grade 3', class: '3B' }] },
      description: 'Save the family\'s per-child grade/class placements in a hub the family belongs to. Returns { ok, placements, needs_placement }.',
    },
    {
      name: 'invite accept',
      method: 'POST',
      path: '/api/join/{token}/accept',
      auth: 'Bearer agent token',
      description: 'Redeem an invite token from a /join/{token} link for the token\'s family. Returns 200 { ok, hub } when joined, 202 { status: "pending_approval" } when the hub admin must let the family in, or 409 { needs_answer } when the hub has a join question (ask the parent to open the invite link in their browser and answer it there).',
    },
    {
      name: 'join by invite with parent approval',
      method: 'POST',
      path: '/api/join/{token}/connect',
      auth: 'none (the parent approves in their browser)',
      body: { agent_name: 'what you call yourself, e.g. "Muse" (max 40 characters)' },
      description: 'For an agent with an invite link but no token. Returns { approval_url, user_code, request_id, poll_secret, interval, expires_in }. Send the parent approval_url and user_code; keep poll_secret to yourself. The request expires in 10 minutes.',
    },
    {
      name: 'collect your token after approval',
      method: 'POST',
      path: '/api/agent-connect/{request_id}/token',
      auth: 'poll_secret in the body',
      body: { poll_secret: 'from the connect response' },
      description: 'Poll every `interval` seconds. 202 = still waiting; 403 = the parent said no; 410 = expired or already collected; 200 = { token, hub, membership: member|pending_approval } exactly once — store the token like a password and use it as Authorization: Bearer <token>.',
    },
    {
      name: 'hub read',
      method: 'GET',
      path: '/api/hubs/{hub_id}',
      auth: 'Bearer agent token',
      description: 'Read one hub the family belongs to: hub, materials, facts, placements, and needs_placement. Members only — another family\'s hub returns 403.',
    },
    {
      name: 'add material',
      method: 'POST',
      path: '/api/hubs/{hub_id}/materials',
      auth: 'Bearer agent token',
      body: { kind: 'paste', title: 'notice title', text: 'newsletter or notice text' },
      email_body: { kind: 'email', subject: 'the email subject', from: 'the sender as shown in the mailbox', date: 'the date the email was sent', text: 'the email body text' },
      description: 'Add material to a hub the family belongs to and extract its facts. For pasted text send kind paste with title and text. For a school email send kind email with subject, from, date, and text (the body); send a PDF attachment separately as kind pdf. Returns { ok, duplicate, material, facts_added }. Adds are idempotent: if the hub already has the same material, the response is { ok: true, duplicate: true, material } pointing at the existing one, and nothing new is added.',
    },
    {
      name: 'rename material',
      method: 'PATCH',
      path: '/api/hubs/{hub_id}/materials/{material_id}',
      auth: 'Bearer agent token',
      body: { title: 'a clearer name, 1-120 characters' },
      description: 'Give a material a clearer name (its notes keep the new name too). Allowed for material the token\'s family added, or any material when the family is a hub admin; GET /api/hubs/{hub_id} marks each material can_rename. Returns { ok, material }. Demo hubs refuse.',
    },
    {
      name: 'remove material',
      method: 'DELETE',
      path: '/api/hubs/{hub_id}/materials/{material_id}',
      auth: 'Bearer agent token',
      description: 'Remove a material and every note pulled from it — for something out of date or added by mistake. Same rule as rename: material the token\'s family added, or any when the family is a hub admin; GET /api/hubs/{hub_id} marks each material can_remove. Cannot be undone. Returns { ok }. Demo hubs refuse.',
    },
    {
      name: 'evening check',
      method: 'POST',
      path: '/api/parent/run',
      auth: 'Bearer agent token',
      description: 'Run the evening check for the token\'s family: its hubs, children, and facts. Returns { ok, nudges, conflicts, relevant_facts, relevant_count, filtered_out_count, summary, logs }. Can take up to a minute.',
    },
    {
      name: 'latest evening check',
      method: 'GET',
      path: '/api/parent/latest',
      auth: 'Bearer agent token',
      description: 'Read the token\'s family\'s most recent evening check instantly: { ok, check, ran_at, moment_label, stale }. check has the same shape as the evening check result (or null if none yet). stale is true when the family\'s notes, placements, or the day changed since it ran — then POST /api/parent/run to refresh. A family whose hubs have no notes yet gets a real empty check (empty: true) at once.',
    },
    {
      name: 'context bundle',
      method: 'GET',
      path: '/api/agent/context',
      auth: 'Bearer agent token (required)',
      query: { since: 'optional ISO date or time; only materials and facts added after it' },
      description: 'Everything you need to write the evening check yourself (agent check, style b): { ok, generated_at, since, family: { children, actions, nudge_style }, hubs: [{ id, name, kind, placements, materials, facts }], counts, caution_flags }. Covers every hub the token\'s family belongs to and only those; placements are the family\'s own. Each fact carries source_quote, quote_verified, and cautions; each material carries cautions (see caution_flags). Never contains another family\'s children, grades, or contact details.',
    },
  ],
  // The evening check is ParentLoop's main output. A connected agent keeps
  // its parent informed by reading it each evening; ParentLoop does not
  // push to agents.
  // Two first-class ways to run the evening check. A family uses one.
  evening_check_modes: {
    app_check: {
      who_runs_it: 'ParentLoop',
      summary: 'ParentLoop prepares the check itself: the Tonight page, saved checks, the nightly email, and the token-scoped check endpoints. Nothing is needed from an agent.',
      endpoints: ['GET /api/parent/latest', 'POST /api/parent/run'],
    },
    agent_check: {
      who_runs_it: 'the parent\'s own agent',
      styles: {
        relay: {
          summary: 'Call ParentLoop\'s prepared check with your token and deliver it to the parent, optionally adding local context only you know (their calendar, commute, reminders).',
          steps: [
            'GET /api/parent/latest with the token; if check is null or stale is true, POST /api/parent/run.',
            'Tell the parent each nudge, each conflict, and the dated items for the next few days, adding any local context you hold.',
          ],
        },
        generate: {
          summary: 'Fetch the context bundle and write the check yourself, in the parent\'s environment, combining hub context with private context ParentLoop never receives.',
          steps: [
            'GET /api/agent/context with the token (add ?since=<generated_at of your last fetch> to get only what is new, and keep what you fetched before).',
            'Keep the facts that apply to the family\'s children using hubs[].placements (grade and class) and each fact\'s scope; team hubs apply to the whole family.',
            'Nudge only for facts with action_required whose tracked state in family.actions is still open; flag events that overlap in time as conflicts.',
            'Quote source_quote when you cite an item, and tell the parent when a fact carries a caution (see caution_flags).',
            'Your private context and your finished check stay with you: never send them to ParentLoop.',
          ],
        },
      },
    },
  },
  evening_routine: [
    'Each evening (around 6–8 PM in the family\'s time zone), GET /api/parent/latest with the token.',
    'If check is null or stale is true, POST /api/parent/run, then use its result.',
    'Tell the parent in a few lines: each nudge (title, action, deadline), each conflict, and the dated items for the next few days. If there is nothing open, say it is a calm evening.',
    'Never share the family\'s check with anyone but the parent.',
  ],
  // Brief 062: agents keep the hub fed from their parent's mailbox, in the
  // parent's own environment — ParentLoop itself never reads Gmail here.
  keep_hub_fed: [
    'You may contribute school material you find in your parent\'s mailbox to their hubs, using their token (POST /api/hubs/{hub_id}/materials with kind email).',
    'Share only what applies to other families too. Anything about your parent\'s own child specifically stays out of the hub.',
    'Adds are idempotent: re-sending something the hub already has is safe and returns { ok: true, duplicate: true } with the existing material. Treat that as done and move on.',
    'When you can, check the hub\'s materials first (GET /api/hubs/{hub_id}), and send one clean copy of the original rather than a forward.',
    'Keep it tidy: rename a material with a clearer title (PATCH /api/hubs/{hub_id}/materials/{material_id}) or remove one that is out of date or was added by mistake (DELETE on the same path) — material your family added, or any material when your family is the hub admin. Ask the parent before removing something another family added.',
  ],
  recipe: AGENT_RECIPE,
  find_or_create: AGENT_RECIPE,
};

function bearerRaw(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : '';
}

function hasAuthorizationHeader(req) {
  return Boolean(req.headers) && Object.prototype.hasOwnProperty.call(req.headers, 'authorization');
}

// --- Brief 073: verify the email when a family is created ------------------
// A family made by typing an email is pending until the 6-digit code sent
// to that address is entered. A pending family can't create or join a hub
// or mint an agent token. Google sign-in already proves its own address,
// so a family whose typed email is the signed-in Google email (one Google
// marks verified) skips it.
// With no way to send email at all (no mail transport), nothing could ever
// be verified, so the check is off — production always has mail (the
// post-deploy gate requires recovery_configured).
// PARENTLOOP_TEST_SIGNUP_RESEND_COOLDOWN_MS: tests only.
const SIGNUP_RESEND_COOLDOWN_MS = process.env.PARENTLOOP_TEST_SIGNUP_RESEND_COOLDOWN_MS !== undefined
  ? Number(process.env.PARENTLOOP_TEST_SIGNUP_RESEND_COOLDOWN_MS) : 60 * 1000;

function signupVerifyOn() {
  return !SIGNUP_VERIFY_SKIPPED_FOR_TESTS && isRecoveryMailConfigured();
}

function pendingFamilyRefusal(profile) {
  if (!profile || profile.is_demo || !profile.email_pending) return null;
  const to = profile.parent_email || 'your email';
  return {
    status: 403,
    body: {
      error: `Confirm your email first — enter the 6-digit code we sent to ${to}. Then you can create or join hubs.`,
      needs_email_code: true,
      email_pending: true,
      sent_to: profile.parent_email || '',
    },
  };
}

function signupCodeEmail(code) {
  return {
    subject: 'Your ParentLoop code: ' + code,
    text: [
      'Hello,',
      '',
      'Here is your code to finish setting up your ParentLoop family:',
      '',
      '    ' + code,
      '',
      'Enter it on the page within 15 minutes, so we know this email is really yours.',
      '',
      'If you didn’t try to set up a family, you can ignore this email — nothing happens without the code.',
      '',
      '— ParentLoop',
    ].join('\n'),
  };
}

// Sends a fresh code to a pending family. The code is never logged.
async function sendSignupCode(profileId, email) {
  const code = store.issueSignupCode(profileId, email);
  try {
    const result = await sendEmail({ to: email, ...signupCodeEmail(code) });
    if (!result.sent) {
      console.warn('signup code not sent: sender not configured');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('signup code send failed: ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

// Sends per email address and per client address, counted before any
// lookup (the brief 041 recovery pattern).
function signupSendAllowed(email, ip) {
  const emailOk = store.hitRecoveryRateLimit('signup-email:' + String(email).trim().toLowerCase(), 5, HOUR_MS);
  const ipOk = store.hitRecoveryRateLimit('signup-ip:' + (ip || 'unknown'), 10, HOUR_MS);
  return emailOk && ipOk;
}

const SIGNUP_RATE_ERROR = 'Too many codes asked for just now. Please wait a while and try again.';

function emailHasFamilyBody() {
  return {
    error: 'This email already has a family. Sign in with Google, or get a recovery link sent to that address, to get back in.',
    email_has_family: true,
    recovery_available: isRecoveryMailConfigured(),
  };
}

function emailVerificationInfo(email, sent) {
  return {
    required: true,
    sent_to: email,
    sent: Boolean(sent),
    expires_in_minutes: Math.round(store.SIGNUP_CODE_TTL_MS / 60000),
    resend_after_seconds: Math.round(SIGNUP_RESEND_COOLDOWN_MS / 1000),
  };
}

// --- Brief 067: joining by invite link -------------------------------------
// A hub with a join question admits a family that answers it; three wrong
// answers in a day turn into a request for the admin instead. A hub with no
// question asks the admin. A hub set to "let anyone with a link join" admits
// straight away. Wrong-answer and rate counts live in memory only, so no IP
// address or answer is ever written down.
const INVITE_MISSING = 'That invite link is no longer available.';
const INVITE_EXPIRED = 'This invite link has expired — ask for a new one.';
const JOIN_WRONG_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const joinWrongByFamily = new Map();
const joinWrongByIp = new Map();
const agentConnectByIp = new Map();

function recentCount(map, key, windowMs) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length) map.set(key, list);
  else map.delete(key);
  return list.length;
}

function bumpCount(map, key) {
  map.set(key, (map.get(key) || []).concat(Date.now()));
}

// Cloud Run's front end appends the real client address to
// X-Forwarded-For, so the LAST entry is trusted; earlier entries can be
// sent by the client itself and would let it dodge the per-IP limits.
function clientIp(req) {
  const parts = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')
    .map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : ((req.socket && req.socket.remoteAddress) || '');
}

function hubAdminFirstName(hubId) {
  const contact = store.listHubContacts(hubId)[0];
  const name = contact ? String(contact.parent_name || contact.name || '').trim().split(' ')[0] : '';
  return name || 'the hub admin';
}

// The shared demo hubs keep instant joins: every demo visitor is their
// admin, so asking that admin first would protect nothing.
function linkJoinsOpen(hubId, settings) {
  const hub = store.getHub(hubId);
  return Boolean((settings && settings.open) || (hub && hub.is_demo));
}

// Brief 068: the answers a join request carries, one per question. A 067
// client sends a single `answer`; a newer one sends `answers`.
function joinAnswersFrom(body) {
  if (!body) return [];
  if (Array.isArray(body.answers)) return body.answers.map((a) => String(a == null ? '' : a));
  return body.answer === undefined ? [] : [String(body.answer == null ? '' : body.answer)];
}

// Brief 068: a belonging check, not a password. Shown on the join card.
// Brief 070: the wording follows the hub's actual question count.
const JOIN_WRONG_NOTE = 'Couldn’t answer the hub’s questions.';

function challengePhrase(count) {
  if (count >= 3) return 'a few quick questions';
  if (count === 2) return 'a couple of quick questions';
  return 'a quick question';
}

function challengeWho(hubId) {
  const hub = store.getHub(hubId);
  return hub && hub.kind === 'school' ? 'only parents from this school would know' : 'only families in this group would know';
}

function joinChallengeNote(hubId, count) {
  const phrase = challengePhrase(count);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1) + ' ' + challengeWho(hubId) + ', so a forwarded link alone can’t join.';
}

// Brief 070: shown on the invite landing to a visitor with no family yet.
// The question itself is asked once, after setup, right before joining.
function joinChallengeSignpost(hubId, count) {
  return 'You’ll answer ' + challengePhrase(count) + ' ' + challengeWho(hubId) + ' — right after you sign in or set up your family.';
}

function questionCount(settings) {
  return settings && settings.has_question ? (settings.questions || []).length || 1 : 0;
}

// Decides one family's join through an invite. Returns { status, body }.
// `answer` is one answer (067) or a list, one per question (068).
function joinByLink(info, profile, answer, via, ip) {
  const hub = { id: info.hub_id, name: info.hub_name };
  const pending = pendingFamilyRefusal(profile);
  if (pending) return pending;
  if (store.isMember(info.hub_id, profile.id)) {
    return { status: 200, body: { ok: true, membership: 'member', hub: store.getHub(info.hub_id) } };
  }
  const admit = () => {
    store.addMember(info.hub_id, profile.id, 'member', via);
    return { status: 200, body: { ok: true, membership: 'member', hub: store.getHub(info.hub_id) } };
  };
  const askAdmin = (lead, note) => {
    const asked = store.requestToJoin(info.hub_id, profile.id, note || '');
    if (asked.error) return { status: asked.status, body: { error: asked.error } };
    const admin = hubAdminFirstName(info.hub_id);
    return {
      status: 202,
      body: {
        ok: true,
        status: 'pending_approval',
        membership: 'pending_approval',
        hub,
        admin_first_name: admin,
        message: (lead ? lead + ' ' : '') + `We’ve asked ${admin} to let you in.`,
      },
    };
  };
  const settings = store.getJoinSettings(info.hub_id);
  if (linkJoinsOpen(info.hub_id, settings)) return admit();
  if (!settings.has_question) return askAdmin('');
  const familyKey = info.hub_id + ':' + profile.id;
  if (recentCount(joinWrongByFamily, familyKey, DAY_MS) >= JOIN_WRONG_LIMIT) return askAdmin('', JOIN_WRONG_NOTE);
  // Only the prompts ever leave the server — never an accepted answer.
  const prompts = {
    question: settings.question,
    questions: settings.questions,
    challenge_note: joinChallengeNote(info.hub_id, questionCount(settings)),
  };
  const given = (Array.isArray(answer) ? answer : [answer]).map((a) => String(a == null ? '' : a).trim());
  if (settings.questions.some((q, i) => !given[i])) {
    return {
      status: 409,
      body: {
        error: settings.questions.length > 1 ? 'Answer the hub’s questions to join.' : 'Answer the hub’s question to join.',
        needs_answer: true,
        ...prompts,
      },
    };
  }
  if (ip && recentCount(joinWrongByIp, ip, HOUR_MS) >= 10) {
    return { status: 429, body: { error: 'Too many tries. Please wait a while and try again.' } };
  }
  if (store.checkJoinAnswers(info.hub_id, given)) return admit();
  bumpCount(joinWrongByFamily, familyKey);
  if (ip) bumpCount(joinWrongByIp, ip);
  const triesLeft = JOIN_WRONG_LIMIT - recentCount(joinWrongByFamily, familyKey, DAY_MS);
  if (triesLeft <= 0) return askAdmin('That doesn’t match.', JOIN_WRONG_NOTE);
  // Generic on purpose: which answer missed is never said.
  return {
    status: 400,
    body: {
      error: 'That doesn’t match — ' + triesLeft + (triesLeft === 1 ? ' try' : ' tries') + ' left.',
      wrong_answer: true,
      needs_answer: true,
      ...prompts,
      tries_left: triesLeft,
    },
  };
}

// What an agent may learn from an invite link: the public card the browser
// join page already shows, plus how to join. Never answers or member data.
function inviteAgentCard(token) {
  const state = store.inviteState(token);
  if (state === 'expired') return { status: 404, body: { error: INVITE_EXPIRED, expired: true } };
  const info = state === 'ok' ? store.getInvite(token) : null;
  if (!info) return { status: 404, body: { error: INVITE_MISSING } };
  const settings = store.getJoinSettings(info.hub_id);
  return {
    status: 200,
    body: {
      hub: { name: info.hub_name },
      invited_by_first_name: info.inviter_first_name,
      has_question: settings.has_question,
      needs_admin_ok: !linkJoinsOpen(info.hub_id, settings) && !settings.has_question,
      how_to_join: `POST /api/join/${token}/connect`,
      guide: '/api/agent',
    },
  };
}

function wantsJson(req) {
  const accept = String((req.headers && req.headers.accept) || '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/html');
}

function agentCanIssue(profileId) {
  const row = profileId ? store.getProfileRowById(profileId) : null;
  return Boolean(row && !row.is_demo && String(row.google_sub || '').trim());
}

function ensureSession(req, res) {
  const cookies = parseCookies(req);
  let session = cookies[SESSION_COOKIE] ? store.getSession(cookies[SESSION_COOKIE]) : null;
  if (!session) {
    session = store.createSession();
    const parts = [SESSION_COOKIE + '=' + encodeURIComponent(session.id), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (sessionUsesSecureCookie(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  return session;
}

function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto =
    (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function gmailConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function googleAuthUrl(req, state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${publicBaseUrl(req)}/api/email/callback`,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function googleTokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok || !data.access_token) {
    const code = data.error ? ` (${data.error})` : '';
    throw new Error(`Google sign-in failed${code}. Please try connecting again.`);
  }
  return data;
}

function googleLoginUrl(req, state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${publicBaseUrl(req)}/api/auth/callback`,
    response_type: 'code',
    scope: LOGIN_SCOPES,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Identity scopes only (openid email profile) — never Gmail scopes. Verified
// server-side via the userinfo endpoint; nothing token-like leaves the server.
async function googleUserinfo(accessToken) {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok || !data.sub) {
    throw new Error('Google sign-in failed (identity check). Please try signing in again.');
  }
  // Brief 074: Google's own word on whether the email is verified.
  return { sub: String(data.sub), email: String(data.email || ''), emailVerified: data.email_verified === true || data.email_verified === 'true' };
}

async function gmailFetch(accessToken, urlPath) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${urlPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(`Gmail request failed (${res.status}). Please reconnect Gmail.`);
  }
  return data;
}

async function getGmailAccessToken(profileId) {
  const tokens = store.getGmailTokens(profileId);
  if (!tokens || !tokens.access_token) {
    throw new Error('Gmail is not connected yet.');
  }
  const expiresAt = Number(tokens.expires_at || 0);
  if (expiresAt && expiresAt > Date.now() + 60000) return tokens.access_token;
  if (!tokens.refresh_token) return tokens.access_token;
  const refreshed = await googleTokenRequest({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  const next = {
    email: tokens.email || '',
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
  };
  store.saveGmailTokens(profileId, next);
  return next.access_token;
}

function decodeBase64Url(data) {
  const normalized = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function gmailMessageText(payload) {
  let plain = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    if (part.body && part.body.data) {
      if (part.mimeType === 'text/plain') plain += decodeBase64Url(part.body.data) + '\n';
      if (part.mimeType === 'text/html') html += decodeBase64Url(part.body.data) + '\n';
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return (plain.trim() || stripHtml(html)).trim();
}

function gmailHeaders(payload) {
  const out = {};
  for (const h of (payload && payload.headers) || []) {
    out[String(h.name || '').toLowerCase()] = h.value || '';
  }
  return out;
}

function classifyGmailMessage(headers, snippet, body) {
  const hay = `${headers.from || ''} ${headers.subject || ''} ${snippet || ''} ${body.slice(0, 1200)}`.toLowerCase();
  if (
    hay.includes('healthy hunger') ||
    hay.includes('hot lunch') ||
    hay.includes('order confirmation') ||
    hay.includes('order receipt') ||
    (hay.includes('receipt') && hay.includes('lunch'))
  ) {
    return 'order';
  }
  if (
    hay.includes('schoolmessenger') ||
    hay.includes('newsletter') ||
    hay.includes('parent preview') ||
    hay.includes('notice')
  ) {
    return 'newsletter';
  }
  return 'other';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const session = ensureSession(req, res);
  try {
    // A Bearer token on any API request must resolve, or the request is
    // refused outright — a revoked or unknown token never falls through
    // to session (demo) data. So is an Authorization header with no token
    // in it (brief 064); only a request with no such header at all gets
    // the session's view.
    const rawBearer = bearerRaw(req);
    let bearerAuth = null;
    if (url.pathname.startsWith('/api/') && !rawBearer && hasAuthorizationHeader(req)) {
      sendJson(res, 401, { error: AGENT_TOKEN_MISSING_401 });
      return;
    }
    if (rawBearer) {
      bearerAuth = store.resolveAgentToken(rawBearer);
      if (!bearerAuth && url.pathname.startsWith('/api/')) {
        sendJson(res, 401, { error: AGENT_TOKEN_401 });
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/agent') {
      sendJson(res, 200, AGENT_MANIFEST);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(INDEX_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // Brief 076: public privacy policy page for the OAuth branding review.
    // No sign-in required.
    if (req.method === 'GET' && url.pathname === '/privacy') {
      const html = fs.readFileSync(PRIVACY_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/newsletter') {
      const viewer = store.getSessionViewer(session);
      if (viewer && !viewer.is_demo) {
        sendJson(res, 200, { text: '' });
        return;
      }
      const text = fs.readFileSync(NEWSLETTER_PATH, 'utf8');
      sendJson(res, 200, { text });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/facts') {
      const viewer = store.getSessionViewer(session);
      if (viewer && !viewer.is_demo) {
        sendJson(res, 200, { facts: [] });
        return;
      }
      const demoHub = store.getDemoHub();
      sendJson(res, 200, { facts: demoHub ? store.listFacts(demoHub.id, viewer ? viewer.id : null) : [] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/family-profile') {
      const profile = bearerAuth ? bearerAuth.profile : store.getSessionViewer(session);
      if (!profile) {
        sendJson(res, 404, { error: 'family profile not found' });
        return;
      }
      sendJson(res, 200, { profile });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/onboarding/status') {
      const active = store.getSessionViewer(session);
      sendJson(res, 200, {
        hasActiveProfile: Boolean(active),
        has_active_profile: Boolean(active),
        isDemo: Boolean(active && active.is_demo),
        is_demo: Boolean(active && active.is_demo),
        needsOnboarding: !(active && !active.is_demo),
        needsEmail: Boolean(active && !active.is_demo && !(active.parent && active.parent.email)),
        needs_email: Boolean(active && !active.is_demo && !(active.parent && active.parent.email)),
        // Brief 073: the family exists but its email isn't confirmed yet.
        emailPending: Boolean(active && !active.is_demo && active.email_pending),
        email_pending: Boolean(active && !active.is_demo && active.email_pending),
        pending_email: active && !active.is_demo && active.email_pending ? active.parent_email : '',
        profile: active,
        auth: store.getSessionIdentity(session),
        // Brief 074: "is this your family?" for a signed-in session with
        // no family of its own (null when there is nothing to offer).
        link_offer: bearerAuth ? null : store.getLinkOffer(session),
      });
      return;
    }
    // Brief 074: the parent's answer to the offer. Browser session only.
    if (req.method === 'POST' && (url.pathname === '/api/auth/link-offer/accept' || url.pathname === '/api/auth/link-offer/decline')) {
      if (bearerAuth) { sendJson(res, 403, { error: 'Only the parent, in their own browser, can answer this.' }); return; }
      if (url.pathname.endsWith('/decline')) {
        store.declineLinkOffer(session.id);
        sendJson(res, 200, { ok: true });
        return;
      }
      const body = await readJsonBody(req);
      const linked = store.acceptLinkOffer(session.id, body.key);
      if (!linked) { sendJson(res, 409, { error: 'That family can’t be linked from here any more. Try signing in again.' }); return; }
      sendJson(res, 200, { ok: true, profile: linked });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/login') {
      if (!gmailConfigured()) {
        sendJson(res, 400, {
          error: 'Google sign-in is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.',
          setup_needed: true,
        });
        return;
      }
      const state = store.createLoginState(session.id);
      res.writeHead(302, { Location: googleLoginUrl(req, state) });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/callback') {
      try {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') || '';
        if (!code) throw new Error('Google did not return a sign-in code.');
        if (!store.consumeLoginState(state, session.id)) {
          throw new Error('This sign-in attempt expired. Please try signing in again.');
        }
        if (!gmailConfigured()) throw new Error('Google sign-in is not set up yet.');
        const tokens = await googleTokenRequest({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${publicBaseUrl(req)}/api/auth/callback`,
          grant_type: 'authorization_code',
        });
        const identity = await googleUserinfo(tokens.access_token);
        store.completeGoogleSignIn(session.id, identity.sub, identity.email, identity.emailVerified);
        res.writeHead(302, { Location: '/' });
        res.end();
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        res.writeHead(302, {
          Location: `/?signin=error&message=${encodeURIComponent(message)}`,
        });
        res.end();
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      sendJson(res, 200, {
        ...store.getSessionIdentity(session),
        configured: gmailConfigured(),
        setup_needed: !gmailConfigured(),
        recovery_configured: isRecoveryMailConfigured(),
        // Brief 073: new families with a typed email confirm it by code.
        signup_verification: signupVerifyOn(),
      });
      return;
    }
    // Brief 041: recovery link request. The response is always the same
    // generic confirmation, matched or not, so the endpoint can never be
    // used to probe which emails have families. Rate limits are counted
    // before any lookup, for matched and unmatched emails alike.
    if (req.method === 'POST' && url.pathname === '/api/recovery/request') {
      const body = await readJsonBody(req);
      const email = String(body.email || body.parent_email || '').trim().toLowerCase();
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        (req.socket && req.socket.remoteAddress) || 'unknown';
      const emailOk = store.hitRecoveryRateLimit('email:' + email, 5, 60 * 60 * 1000);
      const ipOk = store.hitRecoveryRateLimit('ip:' + ip, 15, 60 * 60 * 1000);
      if (!emailOk || !ipOk) {
        sendJson(res, 429, { error: 'Too many recovery requests. Please wait a bit and try again.' });
        return;
      }
      const profile = email ? store.findProfileByParentEmail(email) : null;
      if (profile) {
        const created = store.createRecoveryToken(profile.id);
        if (created) {
          const link = `${publicBaseUrl(req)}/recover/${created.token}`;
          try {
            const result = await sendRecoveryEmail({ to: email, link });
            if (!result.sent) console.warn('recovery email not sent: sender not configured');
          } catch (err) {
            console.warn('recovery email send failed: ' + (err && err.message ? err.message : String(err)));
          }
        }
      }
      sendJson(res, 200, {
        ok: true,
        message: 'If that email has a family with us, a recovery link is on its way.',
      });
      return;
    }
    // Brief 041: clicking a recovery link burns the token and sets this
    // browser's session to the profile — the same restore as Google
    // sign-in (setSessionProfile), with no Google identity attached, so
    // the brief 034 "sign in with Google to keep it that way" guidance
    // applies as usual.
    const recoverMatch = url.pathname.match(/^\/recover\/([^/]+)$/);
    if (req.method === 'GET' && recoverMatch) {
      const profile = store.consumeRecoveryToken(decodeURIComponent(recoverMatch[1]));
      if (!profile) {
        res.writeHead(302, {
          Location: '/?recovery=error&message=' +
            encodeURIComponent('That recovery link has expired or was already used. Please request a new one.'),
        });
        res.end();
        return;
      }
      store.setSessionProfile(session.id, profile.id);
      res.writeHead(302, { Location: '/?recovered=1' });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      store.signOutSession(session.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    // Test-only sign-in completion: runs the exact linking logic the OAuth
    // callback runs, without Google network calls. Enabled only when the
    // server boots with PARENTLOOP_TEST_AUTH=1 (never set in production).
    if (req.method === 'POST' && url.pathname === '/api/auth/test-complete') {
      if (!TEST_AUTH_ENABLED) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const body = await readJsonBody(req);
      const sub = String(body.sub || '').trim();
      const email = String(body.email || '').trim();
      if (!sub) {
        sendJson(res, 400, { error: 'sub is required' });
        return;
      }
      const result = store.completeGoogleSignIn(session.id, sub, email, body.email_verified === true);
      const fresh = store.getSession(session.id);
      sendJson(res, 200, { ok: true, ...store.getSessionIdentity(fresh), profile: result && result.profile });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const body = await readJsonBody(req);
      const parentName = String(body.parent_name || '').trim();
      let kidNames = [];
      if (Array.isArray(body.children)) {
        kidNames = body.children
          .map((k) => String((k && k.name) || '').trim())
          .filter(Boolean);
      }
      if (!kidNames.length && String(body.child_name || '').trim()) {
        kidNames = [String(body.child_name || '').trim()];
      }
      if (!parentName || !kidNames.length) {
        sendJson(res, 400, { error: 'Please add a parent name and at least one child name.' });
        return;
      }
      const parentEmail = store.parentEmailOf(body);
      if (!store.isValidParentEmail(parentEmail)) {
        sendJson(res, 400, { error: store.PARENT_EMAIL_ERROR });
        return;
      }
      // Brief 073: a typed email is confirmed by code before the family can
      // do anything — unless it is the Google address this session already
      // signed in with (Google proved that one).
      const googleEmail = Number(session.google_email_verified) === 1
        ? String(session.google_email || '').trim().toLowerCase() : '';
      const needsCode = signupVerifyOn() && !(googleEmail && googleEmail === parentEmail.toLowerCase());
      if (needsCode) {
        if (!signupSendAllowed(parentEmail, clientIp(req))) {
          sendJson(res, 429, { error: SIGNUP_RATE_ERROR, rate_limited: true });
          return;
        }
        // The session's own family (and any family its Google account holds)
        // may share the address; anyone else's verified family may not.
        const own = store.getSessionOwnProfile(session);
        const linked = session.google_sub ? store.getProfileByGoogleSub(session.google_sub) : null;
        if (store.findVerifiedProfileByEmail(parentEmail, [own && !own.is_demo ? own.id : '', linked && linked.id])) {
          sendJson(res, 409, emailHasFamilyBody());
          return;
        }
      }
      let profile = store.createProfileForSession(session.id, {
        parent_name: parentName,
        parent_email: parentEmail,
        children: kidNames.map((name) => ({ name })),
        priorities: body.priorities,
        nudge_style: body.nudge_style,
        actions: body.actions,
      });
      store.setSessionProfile(session.id, profile.id);
      if (!needsCode) {
        sendJson(res, 200, { ok: true, profile });
        return;
      }
      profile = store.setProfileEmailPending(profile.id, true);
      const sent = await sendSignupCode(profile.id, parentEmail);
      sendJson(res, 200, {
        ok: true,
        profile,
        needs_email_code: true,
        email_verification: emailVerificationInfo(parentEmail, sent),
        message: sent
          ? `We sent a 6-digit code to ${parentEmail}. Enter it so we know this email is really yours.`
          : 'We couldn’t send your code just now — tap “Send a new code” to try again.',
      });
      return;
    }
    // Brief 073: the code that confirms a new family's email.
    if (req.method === 'POST' && url.pathname === '/api/profile/verify-email') {
      const own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo) { sendJson(res, 400, { error: 'Set up your family first.', needsOnboarding: true }); return; }
      if (!own.email_pending) { sendJson(res, 200, { ok: true, verified: true, already_verified: true, profile: own }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const result = store.checkSignupCode(own.id, body.code);
      if (result.ok) { sendJson(res, 200, { ok: true, verified: true, profile: result.profile }); return; }
      const to = own.parent_email;
      if (result.reason === 'wrong') {
        sendJson(res, 400, {
          error: 'That code doesn’t match — ' + result.tries_left + (result.tries_left === 1 ? ' try' : ' tries') + ' left.',
          wrong_code: true, tries_left: result.tries_left, sent_to: to,
        });
        return;
      }
      if (result.reason === 'too_many') {
        sendJson(res, 429, { error: 'Too many wrong tries for that code. Send a new code and try again.', too_many: true, can_resend: true, sent_to: to });
        return;
      }
      if (result.reason === 'expired') {
        sendJson(res, 410, { error: 'That code has expired — codes last 15 minutes. Send a new code.', expired: true, can_resend: true, sent_to: to });
        return;
      }
      sendJson(res, 410, { error: 'There’s no live code for ' + to + ' — send a new one.', no_code: true, can_resend: true, sent_to: to });
      return;
    }
    // Brief 073: send a new code, optionally to a corrected address.
    if (req.method === 'POST' && url.pathname === '/api/profile/resend-code') {
      let own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo) { sendJson(res, 400, { error: 'Set up your family first.', needsOnboarding: true }); return; }
      if (!own.email_pending) { sendJson(res, 200, { ok: true, already_verified: true, profile: own }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const asked = store.parentEmailOf(body);
      const email = asked || own.parent_email;
      if (!store.isValidParentEmail(email)) { sendJson(res, 400, { error: store.PARENT_EMAIL_ERROR }); return; }
      const changed = email.toLowerCase() !== String(own.parent_email || '').toLowerCase();
      const meta = store.signupCodeMeta(own.id);
      const waitMs = meta && !changed ? SIGNUP_RESEND_COOLDOWN_MS - (Date.now() - new Date(meta.sent_at).getTime()) : 0;
      if (waitMs > 0) {
        const secs = Math.ceil(waitMs / 1000);
        sendJson(res, 429, { error: `A new code can be sent in ${secs} second${secs === 1 ? '' : 's'}.`, retry_after_seconds: secs, cooldown: true });
        return;
      }
      if (!signupSendAllowed(email, clientIp(req))) {
        sendJson(res, 429, { error: SIGNUP_RATE_ERROR, rate_limited: true });
        return;
      }
      const linked = session.google_sub ? store.getProfileByGoogleSub(session.google_sub) : null;
      if (store.findVerifiedProfileByEmail(email, [own.id, linked && linked.id])) {
        sendJson(res, 409, emailHasFamilyBody());
        return;
      }
      if (changed) own = store.updateProfileEmail(own.id, email);
      const sent = await sendSignupCode(own.id, email);
      sendJson(res, 200, {
        ok: true,
        profile: own,
        email_verification: emailVerificationInfo(email, sent),
        message: sent ? `We sent a new code to ${email}.` : 'We couldn’t send your code just now — please try again in a minute.',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/profile/update') {
      const active = store.getSessionViewer(session);
      if (!active || active.is_demo) {
        sendJson(res, 400, { error: 'Switch to your own family first, then edit it.' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const hasEmail = body.parent_email != null || body.email != null || body.parentEmail != null ||
          (body.parent && body.parent.email != null);
        const hasNames = body.parent_name != null || body.children != null;
        const profile = hasEmail && !hasNames
          ? store.updateProfileEmail(active.id, store.parentEmailOf(body))
          : store.updateProfileNames(active.id, {
              parent_name: body.parent_name,
              parent_email: hasEmail ? store.parentEmailOf(body) : undefined,
              children: body.children,
            });
        if (!profile) {
          sendJson(res, 400, { error: 'Switch to your own family first, then edit it.' });
          return;
        }
        sendJson(res, 200, { ok: true, profile });
      } catch (err) {
        sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/profile/reset') {
      store.setSessionProfile(session.id, null);
      sendJson(res, 200, { ok: true, hasActiveProfile: false, isDemo: false });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/profile/demo') {
      const profile = store.getDemoProfile();
      if (!profile) {
        sendJson(res, 404, { error: 'Demo family is not available.' });
        return;
      }
      store.setSessionProfile(session.id, profile.id);
      sendJson(res, 200, { ok: true, profile, isDemo: true });
      return;
    }
    // Brief 046: agent-token management. Browser session only — a token
    // can never list, mint, or revoke tokens. Issuance hangs off a
    // Google-linked family so the token always belongs to a family the
    // parent can get back; revoking stays available to the owning
    // session either way, so access can always be cut off.
    const agentRevokeMatch = url.pathname.match(/^\/api\/agent-tokens\/([^/]+)\/revoke$/);
    const agentDeleteMatch = url.pathname.match(/^\/api\/agent-tokens\/([^/]+)$/);
    if (req.method === 'GET' && url.pathname === '/api/agent-tokens') {
      if (bearerAuth) { sendJson(res, 403, { error: AGENT_TOKEN_MANAGE_403 }); return; }
      const own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo) { sendJson(res, 403, { error: 'Switch to your own family first, then manage agent access.' }); return; }
      const canIssue = agentCanIssue(own.id);
      sendJson(res, 200, {
        ok: true,
        tokens: store.listAgentTokens(own.id),
        can_issue: canIssue,
        needs_sign_in: !canIssue,
        signed_in: store.getSessionIdentity(session).signed_in,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent-tokens') {
      if (bearerAuth) { sendJson(res, 403, { error: AGENT_TOKEN_MANAGE_403 }); return; }
      const own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo) { sendJson(res, 403, { error: 'Switch to your own family first, then manage agent access.' }); return; }
      const pendingMint = pendingFamilyRefusal(own);
      if (pendingMint) { sendJson(res, pendingMint.status, pendingMint.body); return; }
      if (!agentCanIssue(own.id)) {
        sendJson(res, 403, {
          error: 'Sign in with Google first, so this token hangs off a family you can always get back.',
          needs_sign_in: true,
        });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const created = store.createAgentToken(own.id, body.name);
        if (!created) { sendJson(res, 403, { error: 'Switch to your own family first, then manage agent access.' }); return; }
        sendJson(res, 200, { ok: true, token: created.token, agent_token: created.record, tokens: store.listAgentTokens(own.id) });
      } catch (err) {
        sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
      }
      return;
    }
    if (req.method === 'POST' && agentRevokeMatch) {
      if (bearerAuth) { sendJson(res, 403, { error: AGENT_TOKEN_MANAGE_403 }); return; }
      const own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo) { sendJson(res, 403, { error: 'Switch to your own family first, then manage agent access.' }); return; }
      const updated = store.revokeAgentToken(own.id, decodeURIComponent(agentRevokeMatch[1]));
      if (!updated) { sendJson(res, 404, { error: 'That token could not be found.' }); return; }
      sendJson(res, 200, { ok: true, agent_token: updated, tokens: store.listAgentTokens(own.id) });
      return;
    }
    // A revoked token can be deleted from the list for good; an active one
    // must be revoked first.
    if (req.method === 'DELETE' && agentDeleteMatch) {
      if (bearerAuth) { sendJson(res, 403, { error: AGENT_TOKEN_MANAGE_403 }); return; }
      const own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo) { sendJson(res, 403, { error: 'Switch to your own family first, then manage agent access.' }); return; }
      const outcome = store.deleteAgentToken(own.id, decodeURIComponent(agentDeleteMatch[1]));
      if (!outcome) { sendJson(res, 404, { error: 'That token could not be found.' }); return; }
      if (outcome === 'active') { sendJson(res, 409, { error: 'Revoke this token first, then you can delete it.' }); return; }
      sendJson(res, 200, { ok: true, tokens: store.listAgentTokens(own.id) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sources') {
      const active = store.getSessionViewer(session);
      if (!active) {
        sendJson(res, 200, { sources: [] });
        return;
      }
      sendJson(res, 200, { sources: store.listSources(active.id) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sources') {
      const active = store.getSessionViewer(session);
      if (!active) {
        sendJson(res, 400, { error: 'Save your family first, then save each source.' });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.type) {
        sendJson(res, 400, { error: 'Choose a source to save.' });
        return;
      }
      const source = store.saveSource(active.id, {
        type: body.type,
        label: body.label,
        url: body.url,
        status: 'saved',
      });
      sendJson(res, 200, { ok: true, source });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/newsletter/run') {
      const logs = [];
      let material = null;
      let reusedExisting = false;
      try {
        const body = await readJsonBody(req);
        const text = String(body.text || '').trim();
        logs.push({ at: nowIso(), message: 'run started' });
        if (!API_KEY) throw new Error('SCHOOL_AGENT_API_KEY is missing or empty in .env. Add it and restart the server.');
        if (!text) throw new Error('Paste your newsletter or notice first.');
        const hub = body.hub_id ? store.getHub(body.hub_id) : store.getDemoHub();
        if (!hub) throw new Error('Choose a hub first.');
        const actor = store.getSessionViewer(session);
        const override = resolveAudience(actor, body.audience, hub.id);
        // Brief 062: the same text already in this hub is answered as a
        // duplicate (or re-read in place if its notes are still pending).
        const fingerprint = materialFingerprint(text);
        const existing = store.findMaterialByFingerprint(hub.id, fingerprint);
        if (existing && !needsExtractionRetry(existing)) {
          logs.push({ at: nowIso(), message: 'already in this hub — no duplicate added' });
          sendJson(res, 200, { ok: true, duplicate: true, facts: [], logs, material: materialPayload(existing), facts_added: 0 });
          return;
        }
        if (existing) {
          material = existing;
          reusedExisting = true;
        } else {
          material = store.createMaterial(hub.id, actor ? actor.id : '', 'paste', String(body.title || 'Pasted newsletter'), text, 'stored',
            undefined, undefined, undefined, { fingerprint });
        }
        logs.push({ at: nowIso(), message: 'pasted newsletter received' });
        materialsExtracting.add(material.id);
        let facts;
        try {
          facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override, true, undefined, null, true);
        } finally {
          materialsExtracting.delete(material.id);
        }
        store.updateMaterialStatus(material.id, 'extracted');
        sendJson(res, 200, {
          ok: true,
          duplicate: reusedExisting,
          facts,
          logs,
          material: { id: material.id, hub_id: hub.id, kind: material.kind || 'paste', title: material.title, status: 'extracted' },
          facts_added: facts.length,
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (material && extractionCallFailed(err)) {
          logs.push({ at: nowIso(), message: `extraction call failed, material kept: ${message}` });
          sendJson(res, 200, {
            ok: true,
            duplicate: reusedExisting,
            facts: [],
            logs,
            material: { id: material.id, hub_id: material.hub_id, kind: material.kind || 'paste', title: material.title, status: 'stored' },
            facts_added: 0,
            facts_pending: true,
            facts_error: FACTS_PENDING_MESSAGE,
          });
          return;
        }
        if (material) store.updateMaterialStatus(material.id, 'failed');
        logs.push({ at: nowIso(), message: `error: ${message}` });
        sendJson(res, 500, { ok: false, error: message, logs });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/email/auth') {
      if (!gmailConfigured()) {
        sendJson(res, 400, {
          error: 'Gmail setup is needed first. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.',
          setup_needed: true,
        });
        return;
      }
      const active = store.getSessionViewer(session);
      if (!active) {
        sendJson(res, 400, { error: 'Save your family first, then connect Gmail.' });
        return;
      }
      const state = store.createGmailState(session.id, active.id);
      res.writeHead(302, { Location: googleAuthUrl(req, state) });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/email/callback') {
      try {
        const code = url.searchParams.get('code');
        // state is a one-time token minted by /api/email/auth for this
        // session; the family comes from the token, never from the query.
        const profileId = store.consumeGmailState(url.searchParams.get('state') || '', session.id);
        const viewer = store.getSessionViewer(session);
        if (!profileId || !viewer || viewer.id !== profileId) {
          throw new Error('This Gmail connection attempt expired. Please try connecting again.');
        }
        if (!code) throw new Error('Google did not return a sign-in code.');
        if (!gmailConfigured()) throw new Error('Gmail setup is needed first.');
        const tokens = await googleTokenRequest({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${publicBaseUrl(req)}/api/email/callback`,
          grant_type: 'authorization_code',
        });
        const gmailProfile = await gmailFetch(tokens.access_token, 'users/me/profile');
        const email = gmailProfile.emailAddress || '';
        store.saveGmailTokens(profileId, {
          email,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || null,
          expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        });
        store.setSourceStatus(profileId, 'gmail', 'connected', email);
        res.writeHead(302, { Location: '/?onboarding=1&email=connected' });
        res.end();
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        res.writeHead(302, {
          Location: `/?onboarding=1&email=error&message=${encodeURIComponent(message)}`,
        });
        res.end();
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/email/status') {
      const active = store.getSessionViewer(session);
      const tokens = active ? store.getGmailTokens(active.id) : null;
      sendJson(res, 200, {
        connected: Boolean(tokens && tokens.access_token),
        email: tokens && tokens.access_token ? tokens.email || '' : '',
        configured: gmailConfigured(),
        setup_needed: !gmailConfigured(),
        setupNeeded: !gmailConfigured(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/email/scan') {
      try {
        const active = store.getSessionViewer(session);
        if (!active) throw new Error('Save your family first, then connect Gmail.');
        const accessToken = await getGmailAccessToken(active.id);
        const query =
          'newer_than:30d (SchoolMessenger OR newsletter OR "parent preview" ' +
          'OR "Healthy Hunger" OR "hot lunch")';
        const list = await gmailFetch(
          accessToken,
          `users/me/messages?maxResults=50&q=${encodeURIComponent(query)}`
        );
        const findings = [];
        const changes = [];
        let actions = { ...(active.actions || {}) };
        let actionsChanged = false;
        for (const item of list.messages || []) {
          const msg = await gmailFetch(accessToken, `users/me/messages/${item.id}`);
          const headers = gmailHeaders(msg.payload);
          const body = gmailMessageText(msg.payload);
          const kind = classifyGmailMessage(headers, msg.snippet, body);
          const base = {
            messageId: item.id,
            id: item.id,
            subject: headers.subject || '(no subject)',
            from: headers.from || '',
            date: headers.date || '',
            snippet: msg.snippet || '',
          };
          if (kind === 'order') {
            const before = actions.hot_lunch || '';
            actions.hot_lunch = 'ordered';
            actionsChanged = true;
            const change = {
              action: 'hot_lunch',
              from: before,
              to: 'ordered',
              label: 'Hot lunch: ordered',
              messageId: item.id,
              subject: base.subject,
            };
            changes.push(change);
            findings.push({ ...base, kind, type: 'order', change });
          } else if (kind === 'newsletter') {
            findings.push({
              ...base,
              kind,
              type: 'newsletter',
              preview: body.slice(0, 300),
            });
          } else {
            findings.push({ ...base, kind: 'other', type: 'other' });
          }
        }
        let updatedProfile = active;
        if (actionsChanged) {
          updatedProfile = store.updateProfileActions(active.id, actions) || active;
        }
        sendJson(res, 200, {
          ok: true,
          findings,
          changes,
          scanned: (list.messages || []).length,
          profile: updatedProfile,
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/email/use-newsletter') {
      const logs = [];
      let material = null;
      let reusedExisting = false;
      try {
        const active = store.getSessionViewer(session);
        if (!active) throw new Error('Save your family first, then connect Gmail.');
        const body = await readJsonBody(req);
        if (!body.hub_id) throw new Error('Choose a hub for this newsletter first.');
        const hub = store.getHub(body.hub_id);
        if (!hub) throw new Error('That hub could not be found.');
        if (!store.isMember(hub.id, active.id)) throw new Error('You are not a member of that hub yet.');
        if (!body.messageId) throw new Error('Choose a message to use.');
        const accessToken = await getGmailAccessToken(active.id);
        const msg = await gmailFetch(accessToken, `users/me/messages/${body.messageId}`);
        const headers = gmailHeaders(msg.payload);
        const text = gmailMessageText(msg.payload);
        if (!text) throw new Error('That message did not include readable text.');
        const override = resolveAudience(active, body.audience, hub.id);
        // Brief 062: same duplicate stop as every other add.
        const fingerprint = materialFingerprint(text);
        const existing = store.findMaterialByFingerprint(hub.id, fingerprint);
        if (existing && !needsExtractionRetry(existing)) {
          logs.push({ at: nowIso(), message: 'already in this hub — no duplicate added' });
          sendJson(res, 200, { ok: true, duplicate: true, facts: [], logs, material: materialPayload(existing), facts_added: 0 });
          return;
        }
        if (existing) {
          material = existing;
          reusedExisting = true;
        } else {
          material = store.createMaterial(hub.id, active.id, 'email', headers.subject || 'Email newsletter', text, 'stored',
            undefined, undefined, undefined, {
              fingerprint,
              emailFrom: cleanEmailLine(headers.from, 200),
              emailDate: normalizeEmailDate(headers.date),
            });
        }
        logs.push({ at: nowIso(), message: 'run started' });
        logs.push({ at: nowIso(), message: 'Gmail message loaded as a hub newsletter' });
        materialsExtracting.add(material.id);
        let facts;
        try {
          facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override, true, undefined, null, true);
        } finally {
          materialsExtracting.delete(material.id);
        }
        store.updateMaterialStatus(material.id, 'extracted');
        sendJson(res, 200, {
          ok: true,
          duplicate: reusedExisting,
          facts,
          logs,
          material: { id: material.id, hub_id: hub.id, kind: material.kind || 'email', title: material.title, status: 'extracted' },
          facts_added: facts.length,
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (material && extractionCallFailed(err)) {
          logs.push({ at: nowIso(), message: `extraction call failed, material kept: ${message}` });
          sendJson(res, 200, {
            ok: true,
            duplicate: reusedExisting,
            facts: [],
            logs,
            material: { id: material.id, hub_id: material.hub_id, kind: material.kind || 'email', title: material.title, status: 'stored' },
            facts_added: 0,
            facts_pending: true,
            facts_error: FACTS_PENDING_MESSAGE,
          });
          return;
        }
        if (material) store.updateMaterialStatus(material.id, 'failed');
        logs.push({ at: nowIso(), message: `error: ${message}` });
        sendJson(res, 500, { ok: false, error: message, logs });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/email/disconnect') {
      try {
        const active = store.getSessionViewer(session);
        if (active) {
          const tokens = store.getGmailTokens(active.id);
          if (tokens && (tokens.refresh_token || tokens.access_token)) {
            try {
              await fetch('https://oauth2.googleapis.com/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  token: tokens.refresh_token || tokens.access_token,
                }).toString(),
              });
            } catch {
              // Revoke is best-effort; local tokens are still deleted below.
            }
          }
          store.deleteGmailTokens(active.id);
          store.setSourceStatus(active.id, 'gmail', 'disconnected', '');
        }
        sendJson(res, 200, { ok: true, connected: false, email: '' });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }
    // The family's latest saved evening check, instantly, with stale:true
    // when its facts, placements, actions, or day have changed since. The
    // home screen shows it and refreshes in the background; agents read it
    // with their token (falls back to the session viewer, like the run).
    // Evening email preferences: the signed-in family's own, never the demo.
    if (url.pathname === '/api/evening-email' && (req.method === 'GET' || req.method === 'POST')) {
      const own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo) {
        if (req.method === 'GET') { sendJson(res, 200, { ok: true, available: false }); return; }
        sendJson(res, 400, { ok: false, error: 'Start your own family first, then you can get the evening email.' });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const enabled = Boolean(body.enabled);
        const time = String(body.time || '19:00');
        if (!EVENING_EMAIL_TIMES.includes(time)) { sendJson(res, 400, { ok: false, error: 'Pick a time between 4 PM and 9:30 PM.' }); return; }
        const current = store.getEveningEmailPrefs(own.id);
        if (enabled && !(current && current.email)) { sendJson(res, 400, { ok: false, error: 'Add your email above first, then turn on the evening email.' }); return; }
        const prefs = store.setEveningEmailPrefs(own.id, enabled, time);
        sendJson(res, 200, { ok: true, available: true, enabled: prefs.enabled, time: prefs.time, email: prefs.email, times: EVENING_EMAIL_TIMES });
        return;
      }
      const prefs = store.getEveningEmailPrefs(own.id);
      sendJson(res, 200, { ok: true, available: true, enabled: prefs.enabled, time: prefs.time, email: prefs.email, times: EVENING_EMAIL_TIMES });
      return;
    }
    // One-click unsubscribe from the link in every evening email. The token
    // is a signature, not a profile id; a wrong token changes nothing.
    if (req.method === 'GET' && url.pathname === '/evening-email/off') {
      const token = String(url.searchParams.get('t') || '');
      const match = token
        ? store.listEveningEmailProfiles().find((p) => eveningUnsubscribeToken(p.id) === token)
        : null;
      if (match) {
        const prefs = store.getEveningEmailPrefs(match.id);
        store.setEveningEmailPrefs(match.id, false, prefs ? prefs.time : '19:00');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ParentLoop</title>' +
        '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1f2a24">' +
        '<h1 style="font-size:1.4rem">You’re unsubscribed</h1>' +
        '<p>You won’t get the ParentLoop evening email anymore. You can turn it back on any time under My family.</p>' +
        '<p><a href="/">Open ParentLoop</a></p></body>');
      return;
    }
    // Scheduler tick (Cloud Scheduler, every 15 minutes). Refused unless the
    // shared secret matches; replies with counts only, never addresses.
    if (req.method === 'POST' && url.pathname === '/api/cron/evening-emails') {
      const expected = String(process.env.EVENING_EMAIL_CRON_SECRET || '');
      const given = String(req.headers['x-parentloop-cron'] || '');
      const ok = expected.length >= 16 && given.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!ok) { sendJson(res, 403, { ok: false, error: 'Not allowed.' }); return; }
      // Tests (PARENTLOOP_TEST_AUTH=1 only) may pin the clock with { now }.
      let now = new Date();
      if (TEST_AUTH_ENABLED) {
        const body = await readJsonBody(req).catch(() => ({}));
        if (body && body.now && !isNaN(Date.parse(body.now))) now = new Date(body.now);
      }
      const summary = await sendDueEveningEmails(now);
      sendJson(res, 200, { ok: true, ...summary });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/latest') {
      const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
      if (!actor) { sendJson(res, 404, { ok: false, error: 'No family profile found — finish setup first.' }); return; }
      sendJson(res, 200, { ok: true, can_mark_done: Boolean(!bearerAuth && !actor.is_demo), done_mode: doneModeFor(actor, bearerAuth), ...latestEveningCheck(actor) });
      return;
    }
    // A parent marks a nudge done (or undoes it). Stored per fact in the
    // family's actions; the saved check is served without it from then on.
    // The demo stays as it is.
    if (req.method === 'POST' && url.pathname === '/api/parent/done') {
      if (bearerAuth) { sendJson(res, 403, { ok: false, error: 'Mark things done from the ParentLoop page.' }); return; }
      const actor = currentViewer(session);
      if (!actor) { sendJson(res, 404, { ok: false, error: 'No family profile found — finish setup first.' }); return; }
      if (actor.is_demo) { sendJson(res, 403, { ok: false, error: 'The demo stays as it is — switch to your own family to tick things off.' }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const factId = String((body && body.fact_id) || '').trim();
      const fact = factId ? store.listFactsForProfile(actor.id).find((f) => f.id === factId) : null;
      if (!fact) { sendJson(res, 404, { ok: false, error: 'That item is not in your hubs.' }); return; }
      const actions = { ...(actor.actions || {}) };
      if (body.done === false) delete actions[FACT_DONE_PREFIX + factId];
      else actions[FACT_DONE_PREFIX + factId] = 'done';
      const updated = store.updateProfileActions(actor.id, actions) || actor;
      sendJson(res, 200, { ok: true, fact_id: factId, done: body.done !== false, can_mark_done: true, done_mode: 'saved', ...latestEveningCheck(updated) });
      return;
    }
    // Evening check mode 2b: the context bundle a parent's own agent uses to
    // write the check itself. Agent token only — never a browser session,
    // so a cookie-less caller can never be handed the demo family.
    if (req.method === 'GET' && url.pathname === '/api/agent/context') {
      if (!bearerAuth) {
        sendJson(res, 401, { ok: false, error: 'The context bundle needs an agent token: send Authorization: Bearer <token>.' });
        return;
      }
      const sinceRaw = String(url.searchParams.get('since') || '').trim();
      let sinceMs = null;
      if (sinceRaw) {
        sinceMs = Date.parse(sinceRaw);
        if (Number.isNaN(sinceMs)) {
          sendJson(res, 400, { ok: false, error: 'since must be an ISO date or time, e.g. 2026-11-03T18:00:00Z.' });
          return;
        }
      }
      sendJson(res, 200, agentContextBundle(bearerAuth.profile, sinceMs));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/run') {
      const logs = [];
      try {
        // An explicit simulated_now is a what-if run; otherwise the demo
        // family runs at its simulated moment and real families at real
        // local time (eveningMoment).
        let simulatedLabel = '';
        try {
          const body = await readJsonBody(req);
          if (body && (body.simulated_now || body.simulatedNow)) {
            simulatedLabel = String(body.simulated_now || body.simulatedNow);
          }
        } catch {
          // No body is fine.
        }
        // Brief 059: a valid agent token runs the check for ITS family
        // (bearerAuth resolved above; a bad token was already refused with
        // 401). Without a token the session viewer runs it, as before.
        const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
        const result = await runParentAgent(logs, simulatedLabel, actor);
        const moment = eveningMoment(actor, simulatedLabel);
        sendJson(res, 200, {
          ok: true,
          can_mark_done: Boolean(!bearerAuth && actor && !actor.is_demo),
          done_mode: doneModeFor(actor, bearerAuth),
          simulated_now: moment.simulated ? moment.label : '',
          checked_at_label: moment.label,
          ran_at: nowIso(),
          ...result,
          result,
          logs,
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        logs.push({ at: nowIso(), message: `error: ${message}` });
        sendJson(res, 500, { ok: false, error: message, logs });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const logs = [];
      try {
        const actor = store.getSessionViewer(session);
        if (actor && !actor.is_demo) {
          throw new Error('School demo updates appear under the demo family. Switch families to run this demo check.');
        }
        const facts = await runSchoolAgent(logs);
        sendJson(res, 200, { ok: true, facts, logs });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        logs.push({ at: nowIso(), message: `error: ${message}` });
        sendJson(res, 500, { ok: false, error: message, logs });
      }
      return;
    }
    // Hubs, invites, joining, and materials.
    const hubMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)$/);
    const hubWebsiteMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/website$/);
    const hubPlacementsMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/placements$/);
    const hubPlacementMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/placements\/([^/]+)$/);
    const hubMaterialsMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials$/);
    const hubMaterialMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials\/([^/]+)$/);
    const hubMemberMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/members\/([^/]+)$/);
    const hubMaterialTextMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials\/([^/]+)\/text$/);
    const hubMaterialFileMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials\/([^/]+)\/file$/);
    const hubInvitesMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/invites$/);
    const hubInviteRevokeMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/invites\/revoke$/);
    const hubRequestsMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/join-requests$/);
    const hubRequestDecideMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/join-requests\/([^/]+)\/(approve|decline)$/);
    const joinInfoMatch = url.pathname.match(/^\/api\/join\/([^/]+)$/);
    const joinAcceptMatch = url.pathname.match(/^\/api\/join\/([^/]+)\/accept$/);
    const joinAgentMatch = url.pathname.match(/^\/api\/join\/([^/]+)\/agent$/);
    const joinConnectMatch = url.pathname.match(/^\/api\/join\/([^/]+)\/connect$/);
    const hubInviteTurnOffMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/invites\/([^/]+)\/turn-off$/);
    const hubJoinSettingsMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/join-settings$/);
    const agentConnectMatch = url.pathname.match(/^\/api\/agent-connect\/([^/]+)$/);
    const agentConnectActionMatch = url.pathname.match(/^\/api\/agent-connect\/([^/]+)\/(approve|decline|token)$/);

    if (req.method === 'GET' && url.pathname.startsWith('/join/')) {
      const token = decodeURIComponent(url.pathname.slice('/join/'.length));
      // Brief 067: an agent asking for JSON gets the invite card and how to
      // join; a browser gets the page, which also points agents at the card.
      if (wantsJson(req)) {
        const card = inviteAgentCard(token);
        sendJson(res, card.status, card.body);
        return;
      }
      let html = fs.readFileSync(INDEX_PATH, 'utf8');
      if (/^[A-Za-z0-9]+$/.test(token)) {
        html = html.replace('</head>',
          `<link rel="alternate" type="application/json" href="/api/join/${token}/agent">\n</head>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/approve/')) {
      const html = fs.readFileSync(INDEX_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/hubs') {
      const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
      const hubs = actor ? store.listHubsForProfile(actor.id) : [];
      sendJson(res, 200, {
        // Brief 067: admins see how many families are waiting to join.
        hubs: hubs.map((h) => (h.role === 'admin' ? { ...h, pending_requests: store.countPendingJoinRequests(h.id) } : h)),
        pending_hubs: actor && !actor.is_demo ? store.listPendingHubsForProfile(actor.id) : [],
      });
      return;
    }
    if (req.method === 'GET' && joinAgentMatch) {
      const card = inviteAgentCard(decodeURIComponent(joinAgentMatch[1]));
      sendJson(res, card.status, card.body);
      return;
    }
    if (req.method === 'POST' && joinConnectMatch) {
      // Brief 067: an agent with an invite link but no token asks to join.
      // Its parent approves at approval_url; it collects with poll_secret.
      const token = decodeURIComponent(joinConnectMatch[1]);
      const card = inviteAgentCard(token);
      if (card.status !== 200) { sendJson(res, card.status, card.body); return; }
      const info = store.getInvite(token);
      const hubRow = store.getHub(info.hub_id);
      if (hubRow && hubRow.is_demo) { sendJson(res, 403, { error: 'Demo hubs can’t be joined by an agent.' }); return; }
      const ip = clientIp(req);
      if (store.countOpenAgentConnects(token) >= 5) {
        sendJson(res, 429, { error: 'Too many agents are waiting on this invite. Try again in a few minutes.' });
        return;
      }
      if (ip && recentCount(agentConnectByIp, ip, HOUR_MS) >= 20) {
        sendJson(res, 429, { error: 'Too many requests. Please wait a while and try again.' });
        return;
      }
      if (ip) bumpCount(agentConnectByIp, ip);
      const body = await readJsonBody(req).catch(() => ({}));
      const made = store.createAgentConnect(token, info.hub_id, body.agent_name || body.name);
      sendJson(res, 200, {
        ok: true,
        approval_url: `${publicBaseUrl(req)}/approve/${made.connect.id}`,
        user_code: made.connect.user_code,
        request_id: made.connect.id,
        poll_secret: made.pollSecret,
        poll_url: `/api/agent-connect/${made.connect.id}/token`,
        expires_in: 600,
        interval: 5,
        hub: { name: info.hub_name },
        has_question: card.body.has_question,
      });
      return;
    }
    if (req.method === 'GET' && agentConnectMatch) {
      // What the approval page shows. Never the poll secret or a token.
      const row = store.getAgentConnect(decodeURIComponent(agentConnectMatch[1]));
      if (!row) { sendJson(res, 404, { error: 'That approval link isn’t valid.' }); return; }
      const hubRow = store.getHub(row.hub_id);
      const settings = store.getJoinSettings(row.hub_id) || {};
      const own = store.getSessionOwnProfile(session);
      sendJson(res, 200, {
        status: row.status,
        hub: { name: hubRow ? hubRow.name : '' },
        agent_name: row.agent_name,
        user_code: row.user_code,
        expires_at: row.expires_at,
        has_question: Boolean(settings.has_question),
        question: settings.has_question ? settings.question : '',
        questions: settings.has_question ? settings.questions : [],
        challenge_note: settings.has_question ? joinChallengeNote(row.hub_id, questionCount(settings)) : '',
        needs_admin_ok: !linkJoinsOpen(row.hub_id, settings) && !settings.has_question,
        admin_first_name: hubRow ? hubAdminFirstName(row.hub_id) : '',
        membership: row.membership || '',
        viewer: {
          has_family: Boolean(own && !own.is_demo),
          can_approve: Boolean(own && !own.is_demo && agentCanIssue(own.id)),
          family_first_name: own && !own.is_demo ? String(own.parent && own.parent.name || '').trim().split(' ')[0] : '',
        },
      });
      return;
    }
    if (req.method === 'POST' && agentConnectActionMatch) {
      const id = decodeURIComponent(agentConnectActionMatch[1]);
      const action = agentConnectActionMatch[2];
      const body = await readJsonBody(req).catch(() => ({}));
      if (action === 'token') {
        const out = store.collectAgentConnect(id, String(body.poll_secret || ''));
        if (out.status === 'unknown') { sendJson(res, 404, { error: 'not found' }); return; }
        if (out.status === 'pending') { sendJson(res, 202, { status: 'pending' }); return; }
        if (out.status === 'declined') { sendJson(res, 403, { status: 'declined', error: 'The parent said no.' }); return; }
        if (out.status === 'expired') { sendJson(res, 410, { status: 'expired', error: 'This request has expired or was already collected.' }); return; }
        sendJson(res, 200, out);
        return;
      }
      // approve / decline: only the parent, in their own browser session.
      if (bearerAuth) { sendJson(res, 403, { error: AGENT_TOKEN_MANAGE_403 }); return; }
      const row = store.getAgentConnect(id);
      if (!row) { sendJson(res, 404, { error: 'That approval link isn’t valid.' }); return; }
      if (row.status === 'expired') { sendJson(res, 410, { error: 'This approval link has expired. Ask your agent to start again.' }); return; }
      if (row.status !== 'pending') { sendJson(res, 409, { error: 'This request has already been answered.' }); return; }
      const own = store.getSessionOwnProfile(session);
      if (!own || own.is_demo || !agentCanIssue(own.id)) {
        sendJson(res, 403, { error: 'Sign in with Google first, so this agent belongs to a family you can always get back.', needs_sign_in: true });
        return;
      }
      if (action === 'decline') {
        store.decideAgentConnect(id, { approve: false });
        sendJson(res, 200, { ok: true, status: 'declined' });
        return;
      }
      if (store.inviteState(row.invite_token) !== 'ok') {
        sendJson(res, 410, { error: INVITE_EXPIRED });
        return;
      }
      const info = store.getInvite(row.invite_token);
      let outcome;
      try {
        outcome = joinByLink(info, own, joinAnswersFrom(body), 'via agent: ' + row.agent_name, clientIp(req));
      } catch (err) {
        sendJson(res, 403, { error: err && err.message ? err.message : String(err) });
        return;
      }
      if (outcome.status !== 200 && outcome.status !== 202) { sendJson(res, outcome.status, outcome.body); return; }
      const membership = outcome.status === 200 ? 'member' : 'pending_approval';
      store.decideAgentConnect(id, { approve: true, profileId: own.id, membership });
      sendJson(res, 200, {
        ok: true,
        status: 'approved',
        membership,
        hub: { name: info.hub_name },
        agent_name: row.agent_name,
        message: outcome.body.message || '',
      });
      return;
    }
    if (hubJoinSettingsMatch) {
      // Brief 067: the hub's join question and link settings (admins only).
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubJoinSettingsMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (bearerAuth || !actor || store.getMemberRole(hub.id, actor.id) !== 'admin') {
        sendJson(res, 403, { error: 'Only hub admins can change how families join.' });
        return;
      }
      if (hub.is_demo) { sendJson(res, 403, { error: 'The demo stays as it is.' }); return; }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, settings: store.getJoinSettings(hub.id), invites: store.listActiveInvites(hub.id) });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          if (body.clear_question) store.clearJoinQuestion(hub.id);
          else if (Array.isArray(body.questions)) store.setJoinQuestions(hub.id, body.questions);
          else if (body.question !== undefined || body.answers !== undefined) store.setJoinQuestion(hub.id, body.question, body.answers);
          if (body.open !== undefined) store.setJoinOpen(hub.id, Boolean(body.open));
        } catch (err) {
          sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
          return;
        }
        sendJson(res, 200, { ok: true, settings: store.getJoinSettings(hub.id), invites: store.listActiveInvites(hub.id) });
        return;
      }
    }
    if (req.method === 'POST' && hubInviteTurnOffMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubInviteTurnOffMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (bearerAuth || !actor || store.getMemberRole(hub.id, actor.id) !== 'admin') {
        sendJson(res, 403, { error: 'Only hub admins can turn off invite links.' });
        return;
      }
      if (!store.turnOffInvite(hub.id, decodeURIComponent(hubInviteTurnOffMatch[2]))) {
        sendJson(res, 404, { error: 'That link is already off.' });
        return;
      }
      sendJson(res, 200, { ok: true, invites: store.listActiveInvites(hub.id) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/hubs/lookup') {
      const school = String(url.searchParams.get('school') || url.searchParams.get('school_name') || '').trim();
      const city = String(url.searchParams.get('city') || '').trim();
      const province = String(url.searchParams.get('province') || '').trim();
      const country = String(url.searchParams.get('country') || '').trim();
      if (!school) { sendJson(res, 400, { error: 'Add the school name.' }); return; }
      if (!city) { sendJson(res, 400, { error: 'Add the city.' }); return; }
      if (!province) { sendJson(res, 400, { error: 'Add the state or province.' }); return; }
      if (!country) { sendJson(res, 400, { error: 'Add the country.' }); return; }
      const conflict = store.findSchoolHubConflict(school, city, province, country);
      if (!conflict) { sendJson(res, 200, { match: 'none', hub: null }); return; }
      const hub = store.getHub(conflict.id);
      if (!hub) { sendJson(res, 200, { match: 'none', hub: null }); return; }
      sendJson(res, 200, {
        match: conflict.match_type,
        hub: {
          name: hub.name,
          city: hub.city,
          province: hub.province,
          country: hub.country,
          families: hub.member_count,
          founder_first_name: conflict.founder_first_name,
        },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/hubs/parse-link') {
      const body = await readJsonBody(req);
      const urlStr = String(body.url || '').trim();
      const kind = body.kind === 'team' || body.kind === 'activity' ? body.kind : 'school';
      let parsedUrl = null;
      try {
        parsedUrl = new URL(urlStr);
      } catch {
        parsedUrl = null;
      }
      if (!parsedUrl) {
        sendJson(res, 400, { error: 'That link doesn’t look complete — paste the full address starting with http:// or https://.' });
        return;
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        sendJson(res, 400, { error: 'That link needs to start with http:// or https://.' });
        return;
      }
      let pageText = '';
      let pageTitle = '';
      let fetchFailed = false;
      try {
        const parts = await fetchPageParts(parsedUrl.toString());
        pageText = parts.pageText;
        pageTitle = parts.pageTitle;
      } catch (err) {
        fetchFailed = true;
      }
      if (fetchFailed || (!pageText && !pageTitle)) {
        sendJson(res, 500, { error: 'That page didn’t load — check the link and try again, or just type the details in.' });
        return;
      }
      const blankFields = kind === 'team'
        ? { name: '', sport: '', level: '' }
        : kind === 'activity'
          ? { name: '', city: '' }
          : { school_name: '', city: '', province: '', country: '' };
      try {
        const fields = withTitleFallback(
          await extractIdentityFields(pageText, kind, { pageTitle, pageUrl: parsedUrl.toString() }),
          kind,
          pageTitle
        );
        sendJson(res, 200, { ok: true, kind, domain: parsedUrl.hostname, fields });
      } catch (err) {
        // Degrade instead of dead-ending: the page loaded, so return 200
        // with whatever the title yields. The hard error above stays for
        // genuine fetch failures (bad URL, page did not load).
        sendJson(res, 200, {
          ok: true,
          kind,
          domain: parsedUrl.hostname,
          fields: withTitleFallback(blankFields, kind, pageTitle),
        });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/hubs') {
      const actor = bearerAuth ? bearerAuth.profile : store.getSessionViewer(session);
      if (!actor) { sendJson(res, 400, { error: 'Set up your family first.' }); return; }
      const pendingCreate = pendingFamilyRefusal(actor);
      if (pendingCreate) { sendJson(res, pendingCreate.status, pendingCreate.body); return; }
      const body = await readJsonBody(req);
      const kinds = ['school', 'team', 'activity', 'other'];
      const kind = kinds.includes(body.kind) ? body.kind : 'other';
      if (kind === 'school') {
        let schoolName = String(body.school_name || '').trim();
        let city = String(body.city || '').trim();
        let province = String(body.province || '').trim();
        let country = String(body.country || '').trim();
        if (!schoolName && !city && !province && !country) {
          const parts = store.splitComposedName(body.name);
          schoolName = parts.school_name;
          city = parts.city;
        }
        if (!schoolName) { sendJson(res, 400, { error: 'Add the school name.' }); return; }
        if (!city) { sendJson(res, 400, { error: 'Add the city.' }); return; }
        if (!province) { sendJson(res, 400, { error: 'Add the state or province.' }); return; }
        if (!country) { sendJson(res, 400, { error: 'Add the country.' }); return; }
        const displayName = `${schoolName} — ${city}`;
        const conflict = store.findSchoolHubConflict(schoolName, city, province, country);
        if (conflict && conflict.match_type === 'exact') {
          sendJson(res, 409, { error: 'That school already has a hub.', match_type: 'exact', existing_hub: conflict });
          return;
        }
        if (conflict && conflict.match_type === 'similar' && !body.force) {
          sendJson(res, 409, { error: 'That looks like a school that already has a hub.', match_type: 'similar', existing_hub: conflict });
          return;
        }
        let website = '';
        try {
          website = normalizeWebsiteUrl(body.website);
        } catch (err) {
          sendJson(res, 400, { error: err.message });
          return;
        }
        const hub = store.createHub(actor.id, displayName, kind, { school_name: schoolName, city, province, country, website });
        sendJson(res, 200, { ok: true, hub });
        return;
      }
      if (!String(body.name || '').trim()) { sendJson(res, 400, { error: 'Give your hub a name.' }); return; }
      let website = '';
      try {
        website = normalizeWebsiteUrl(body.website);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const extra = kind === 'team'
        ? { sport: String(body.sport || '').trim(), level: String(body.level || '').trim(), website }
        : kind === 'activity' ? { website } : null;
      const hub = store.createHub(actor.id, body.name, kind, extra);
      sendJson(res, 200, { ok: true, hub });
      return;
    }
    if (req.method === 'DELETE' && hubMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || store.getMemberRole(hub.id, actor.id) !== 'admin') { sendJson(res, 403, { error: 'Only hub admins can delete this hub.' }); return; }
      store.deleteHub(hub.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && hubWebsiteMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubWebsiteMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can update this hub.' }); return; }
      if (store.getMemberRole(hub.id, actor.id) !== 'admin') { sendJson(res, 403, { error: 'Only hub admins can set the school website.' }); return; }
      const body = await readJsonBody(req);
      let website = '';
      try {
        website = normalizeWebsiteUrl(body.website);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (!website) { sendJson(res, 400, { error: 'Paste the school website address first.' }); return; }
      const updated = store.setHubWebsite(hub.id, website);
      sendJson(res, 200, { ok: true, hub: updated });
      return;
    }
    if (req.method === 'GET' && hubMatch) {
      const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
      const hub = store.getHub(hubMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can see this hub.' }); return; }
      const placement = store.placementStatus(hub.id, actor.id);
      const listedMembers = store.listHubMembers(hub.id);
      // Brief 055: a founder/admin's view of the roster also carries, per
      // removable member, an opaque member_key for the remove action. Plain
      // members (and agents) get the roster exactly as before.
      // Brief 058: every roster row says whether it is the viewer, so the
      // page can mark "(you)" without seeing any profile id.
      const viewerIsAdmin = !bearerAuth && store.getMemberRole(hub.id, actor.id) === 'admin';
      const members = listedMembers.map((m, i) => {
        const profileId = listedMembers._profileIds[i];
        const row = { ...m, is_you: profileId === actor.id };
        if (!viewerIsAdmin) return row;
        const removable = !hub.is_demo && !m.is_founder && profileId !== actor.id && profileId !== hub.created_by;
        return removable ? { ...row, can_remove: true, member_key: store.hubMemberKey(hub.id, profileId) } : { ...row, can_remove: false };
      });
      const contacts = store.listHubContacts(hub.id);
      const contactNames = contacts.map((c) => c.parent_name);
      const contactLine = contactNames.join(', ');
      const factCounts = store.countFactsByMaterial(hub.id);
      sendJson(res, 200, {
        hub: { ...hub, role: store.getMemberRole(hub.id, actor.id), member_count: members.length },
        facts: store.listFacts(hub.id, actor.id),
        materials: store.listMaterials(hub.id, actor.id).map((m) => {
          const { uploaded_by, ...rest } = m;
          return {
            ...rest,
            fact_count: factCounts[m.id] || 0,
            can_remove: Boolean(
              !hub.is_demo && (uploaded_by === actor.id || store.getMemberRole(hub.id, actor.id) === 'admin')
            ),
            // Rename follows the same rule as remove.
            can_rename: Boolean(
              !hub.is_demo && (uploaded_by === actor.id || store.getMemberRole(hub.id, actor.id) === 'admin')
            ),
          };
        }),
        member_count: members.length,
        members,
        contacts,
        contact_names: contactNames,
        hub_contact: contactLine,
        hub_contacts: contacts,
        point_of_contact: contactLine,
        children: actor.children || [],
        placements: placement.placements,
        needs_placement: placement.needs_placement,
      });
      return;
    }
    if (req.method === 'POST' && hubPlacementsMatch) {
      const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
      const hub = store.getHub(hubPlacementsMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can update placements.' }); return; }
      try {
        const body = await readJsonBody(req);
        const placement = store.setPlacements(hub.id, actor.id, body.placements);
        sendJson(res, 200, { ok: true, placements: placement.placements, needs_placement: placement.needs_placement });
      } catch (err) {
        sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
      }
      return;
    }
    if (req.method === 'DELETE' && hubPlacementMatch) {
      const actor = currentViewer(session);
      const hub = store.getHub(hubPlacementMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || actor.is_demo) {
        sendJson(res, 400, { error: 'Switch to your own family first, then edit it.' });
        return;
      }
      if (!store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can update placements.' }); return; }
      try {
        const placement = store.deletePlacement(hub.id, actor.id, decodeURIComponent(hubPlacementMatch[2]));
        sendJson(res, 200, { ok: true, placements: placement.placements, needs_placement: placement.needs_placement });
      } catch (err) {
        sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
      }
      return;
    }
    if (req.method === 'DELETE' && hubMaterialMatch) {
      const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
      const hub = store.getHub(hubMaterialMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can read this hub.' }); return; }
      const material = store.getMaterial(hubMaterialMatch[2]);
      if (!material || material.hub_id !== hub.id) { sendJson(res, 404, { error: 'That material is not available.' }); return; }
      if (hub.is_demo) { sendJson(res, 403, { error: 'Demo materials can’t be removed — the demo stays as it is.' }); return; }
      const isUploader = material.uploaded_by === actor.id;
      const isAdmin = store.getMemberRole(hub.id, actor.id) === 'admin';
      if (!isUploader && !isAdmin) { sendJson(res, 403, { error: 'Only the parent who added this, or a hub admin, can remove it.' }); return; }
      store.deleteMaterial(material.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    // A material's name: the parent who added it or a hub admin may change
    // it (the same rule as remove). The demo stays as it is.
    if (req.method === 'PATCH' && hubMaterialMatch) {
      const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
      const hub = store.getHub(hubMaterialMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can read this hub.' }); return; }
      const material = store.getMaterial(hubMaterialMatch[2]);
      if (!material || material.hub_id !== hub.id) { sendJson(res, 404, { error: 'That material is not available.' }); return; }
      if (hub.is_demo) { sendJson(res, 403, { error: 'Demo materials can’t be renamed — the demo stays as it is.' }); return; }
      const isUploader = material.uploaded_by === actor.id;
      const isAdmin = store.getMemberRole(hub.id, actor.id) === 'admin';
      if (!isUploader && !isAdmin) { sendJson(res, 403, { error: 'Only the parent who added this, or a hub admin, can rename it.' }); return; }
      const body = await readJsonBody(req);
      const title = String(body.title || '').replace(/\s+/g, ' ').trim();
      if (!title) { sendJson(res, 400, { error: 'Give it a name first.' }); return; }
      if (title.length > 120) { sendJson(res, 400, { error: 'Keep the name under 120 characters.' }); return; }
      const renamed = store.renameMaterial(material.id, title);
      sendJson(res, 200, { ok: true, material: materialPayload(renamed) });
      return;
    }
    // Brief 055: a hub's founder or admin removes a member family. Session
    // auth only (an agent token never removes families). The target is the
    // opaque member_key from the admin roster, never a profile id.
    if (req.method === 'DELETE' && hubMemberMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubMemberMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || store.getMemberRole(hub.id, actor.id) !== 'admin') {
        sendJson(res, 403, { error: 'Only the hub’s founder or an admin can remove a family.' });
        return;
      }
      if (hub.is_demo) { sendJson(res, 403, { error: 'Demo families can’t be removed — the demo stays as it is.' }); return; }
      const target = store.findHubMemberByKey(hub.id, decodeURIComponent(hubMemberMatch[2]));
      if (!target) { sendJson(res, 404, { error: 'That family is not in this hub.' }); return; }
      if (target.profile_id === actor.id) { sendJson(res, 400, { error: 'You can’t remove yourself from a hub.' }); return; }
      if (target.is_founder) { sendJson(res, 403, { error: 'The hub’s founder can’t be removed.' }); return; }
      store.removeHubMember(hub.id, target.profile_id);
      sendJson(res, 200, { ok: true, member_count: store.listHubMembers(hub.id).length });
      return;
    }
    if (req.method === 'GET' && hubMaterialTextMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubMaterialTextMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can read this hub.' }); return; }
      const doc = store.getMaterialText(hubMaterialTextMatch[2], actor.id);
      if (!doc || doc.hub_id !== hub.id) { sendJson(res, 404, { error: 'That material is not available.' }); return; }
      sendJson(res, 200, doc);
      return;
    }
    if (req.method === 'GET' && hubMaterialFileMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubMaterialFileMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can read this hub.' }); return; }
      const doc = store.getMaterialFile(hubMaterialFileMatch[2], actor.id);
      if (!doc || doc.hub_id !== hub.id) { sendJson(res, 404, { error: 'That material is not available.' }); return; }
      const sniffed = sniffImageMime(doc.data);
      const isImage = Boolean(sniffed) || String(doc.file_mime || '').startsWith('image/');
      const contentType = isImage ? (sniffed || doc.file_mime) : 'application/pdf';
      const fallbackName = isImage ? `material.${imageExtForMime(contentType)}` : 'material.pdf';
      const safeName = String(doc.file_name || fallbackName).replace(/["\r\n\\]/g, '').trim() || fallbackName;
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Content-Length': doc.data.length,
        'Cache-Control': 'private, no-store',
      });
      res.end(doc.data);
      return;
    }
    if (req.method === 'POST' && hubMaterialsMatch) {
      const actor = bearerAuth ? bearerAuth.profile : store.getSessionViewer(session);
      const hub = store.getHub(hubMaterialsMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can add material to this hub.' }); return; }
      const body = await readJsonBody(req, MAX_MATERIAL_JSON_BYTES);
      const logs = [];
      let material = null;
      let reusedExisting = false;
      // Brief 062: the same material already in this hub is a successful
      // add of the existing one — no new material, no new extraction.
      const answerDuplicate = (existing) => {
        logs.push({ at: nowIso(), message: 'already in this hub — no duplicate added' });
        if (bearerAuth) logs.push({ at: nowIso(), message: 'duplicate add via agent: ' + bearerAuth.token.name });
        sendJson(res, 200, { ok: true, duplicate: true, material: materialPayload(existing), facts: [], facts_added: 0, count: 0, logs });
      };
      try {
        if (!API_KEY) throw new Error('SCHOOL_AGENT_API_KEY is missing or empty in .env. Add it and restart the server.');
        let text = '';
        const requestedKind = String(body.kind || '').trim().toLowerCase();
        // Brief 044 image payloads: accept the image under any of the
        // field names the client (or a test) may use for it.
        let imageBase64 = String(body.imageBase64 || body.image_base64 || '').trim();
        let imageDataUrl = String(body.imageDataUrl || body.dataUrl || body.image_data_url || '').trim();
        if (!imageBase64 && imageDataUrl) {
          const m = imageDataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
          if (m) imageBase64 = String(m[3] || '').trim();
        }
        if (!imageBase64 && imageDataUrl && !imageDataUrl.startsWith('data:')) imageBase64 = imageDataUrl;
        if (!imageBase64 && (requestedKind === 'image' || requestedKind === 'photo' || requestedKind === 'screenshot')) {
          imageBase64 = String(body.fileBase64 || '').trim();
        }
        if (!imageBase64 && body.fileBase64 && requestedKind !== 'pdf') {
          imageBase64 = String(body.fileBase64 || '').trim();
        }
        const hasImage = Boolean(imageBase64) || requestedKind === 'image' || requestedKind === 'photo' || requestedKind === 'screenshot';
        let kind = requestedKind === 'pdf' && !hasImage ? 'pdf' : hasImage ? 'image' : requestedKind === 'email' ? 'email' : 'paste';
        let pdfFile = null;
        let imageFile = null;
        let emailMeta = null;
        let fingerprint = '';
        let existing = null;
        if (kind === 'image') {
          if (!imageBase64) throw new Error('Paste or choose an image first.');
          const cleaned = imageBase64.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
          const imageBuffer = Buffer.from(cleaned, 'base64');
          if (!imageBuffer.length) throw new Error('Paste or choose an image first.');
          if (imageBuffer.length > MAX_IMAGE_BYTES) {
            throw new Error('That image is too large — the limit is 5 MB. Choose a smaller image.');
          }
          const mime = sniffImageMime(imageBuffer);
          if (!mime) {
            throw new Error('That file isn’t an image we can read — choose a PNG, JPEG, or WebP image.');
          }
          const rawName = String(body.fileName || body.imageName || body.name || '').replace(/["\r\n\\]/g, '').trim().slice(0, 200);
          const fallbackName = `pasted-image.${imageExtForMime(mime)}`;
          imageFile = { data: imageBuffer, name: rawName || fallbackName, mime };
          text = String(body.text || '').trim();
          fingerprint = fileFingerprint('image', imageBuffer, text);
        } else if (kind === 'pdf') {
          if (!body.fileBase64) throw new Error('Choose a PDF file first.');
          const pdfBuffer = Buffer.from(String(body.fileBase64), 'base64');
          body.fileBase64 = null; // release the ~4/3-size source string now
          if (pdfBuffer.length > MAX_PDF_BYTES) {
            throw new Error('That PDF is too large — the limit is 10 MB. Choose a smaller file.');
          }
          // A known duplicate answers before any parsing or OCR is paid for.
          fingerprint = fileFingerprint('pdf', pdfBuffer);
          existing = store.findMaterialByFingerprint(hub.id, fingerprint);
          if (existing && !needsExtractionRetry(existing)) {
            answerDuplicate(existing);
            return;
          }
          // Hand the parser a fresh Uint8Array: small Buffers can be slices
          // of a shared pool, which the bundled pdf.js misreads.
          const pageTexts = [];
          const parsed = await pdfParse(new Uint8Array(pdfBuffer), {
            pagerender: collectingPagerender(pageTexts),
          });
          text = String(parsed.text || '').trim();
          const pictureRisk = assessPdfPictureRisk(pageTexts, text, pdfBuffer.length);
          // Brief 048: picture-risk PDFs get their flagged pages read as
          // images. Recovered text merges with the text layer and feeds
          // the same extraction below. Any failure leaves text untouched.
          let picturesReadWithOcr = false;
          if (pictureRisk) {
            try {
              const ocr = await readFlaggedPagesWithOcr(pdfBuffer, pageTexts, text, logs);
              if (ocr.ocrText) {
                text = text ? text + '\n\n' + ocr.ocrText : ocr.ocrText;
                picturesReadWithOcr = ocr.picturesRead;
              }
            } catch {
              picturesReadWithOcr = false;
            }
          }
          if (!text) throw new Error('That PDF did not include readable text.');
          pdfFile = {
            data: pdfBuffer,
            name: String(body.fileName || '').replace(/["\r\n\\]/g, '').trim().slice(0, 200) || 'material.pdf',
            pictureRisk,
            picturesReadWithOcr,
          };
        } else if (kind === 'email') {
          // Brief 062: an email an agent found in its parent's mailbox. The
          // body is the source text (extraction and quote verification run
          // on it as on a paste); sender and date are kept as provenance.
          text = String(body.text || body.body || '').trim();
          if (!text) throw new Error('Send the email’s body text.');
          emailMeta = {
            subject: cleanEmailLine(body.subject, 200),
            emailFrom: cleanEmailLine(body.from, 200),
            emailDate: normalizeEmailDate(body.date),
          };
        } else {
          text = String(body.text || '').trim();
          if (!text) throw new Error('Paste a newsletter or notice first.');
        }
        if (!fingerprint) fingerprint = materialFingerprint(text);
        if (!existing) existing = store.findMaterialByFingerprint(hub.id, fingerprint);
        if (existing && !needsExtractionRetry(existing)) {
          answerDuplicate(existing);
          return;
        }
        const override = resolveAudience(actor, body.audience, hub.id);
        const suppliedTitle = String(body.title || '').trim();
        const retainedFile = pdfFile || imageFile;
        // Brief 053: a file material (image or PDF) without a supplied title
        // starts with a neutral dated label, never its file name; the
        // extraction read below proposes the real title from the content.
        // An email starts as its subject and is titled from its content too.
        // Brief 072: so does a paste, starting from its short first-line title.
        const titleFromContent = !suppliedTitle && Boolean(retainedFile);
        let titleFrom = titleFromContent ? { fileName: retainedFile.name }
          : !suppliedTitle && (emailMeta || kind === 'paste') ? { fileName: '' } : null;
        const materialTitle = suppliedTitle ||
          (titleFromContent ? neutralFileMaterialTitle(kind, new Date())
            : (emailMeta && emailMeta.subject) || deriveMaterialTitle(text));
        if (existing) {
          // Same text, but its earlier extraction call failed: read it again
          // on the existing material instead of adding a second copy.
          material = existing;
          reusedExisting = true;
          logs.push({ at: nowIso(), message: 'already in this hub with its notes pending — reading it again in place' });
          // Brief 072: a parent's rename always wins over a content title.
          if (titleFrom && !isAutoMaterialTitle(existing, text, emailMeta)) titleFrom = null;
        } else {
          material = store.createMaterial(hub.id, actor.id, kind, materialTitle, text, 'stored', undefined, undefined, retainedFile, {
            fingerprint,
            emailFrom: emailMeta ? emailMeta.emailFrom : '',
            emailDate: emailMeta ? emailMeta.emailDate : '',
          });
        }
        materialsExtracting.add(material.id);
        let facts;
        try {
          if (titleFrom) titleFrom.ifTitle = String(material.title || '');
          facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override, true, imageFile, titleFrom, true);
        } finally {
          materialsExtracting.delete(material.id);
        }
        store.updateMaterialStatus(material.id, 'extracted');
        material = store.getMaterial(material.id) || material;
        if (bearerAuth) logs.push({ at: nowIso(), message: 'material added via agent: ' + bearerAuth.token.name });
        sendJson(res, 200, {
          ok: true,
          duplicate: reusedExisting,
          material: materialPayload(material),
          facts,
          facts_added: facts.length,
          count: facts.length,
          logs,
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (material && extractionCallFailed(err)) {
          logs.push({ at: nowIso(), message: `extraction call failed, material kept: ${message}` });
          // Built from the saved row only: kind/retainedFile/pdfFile are
          // block-scoped to the try above and do not exist here.
          sendJson(res, 200, {
            ok: true,
            duplicate: reusedExisting,
            material: { ...materialPayload(material), status: 'stored' },
            facts: [],
            facts_added: 0,
            count: 0,
            facts_pending: true,
            facts_error: FACTS_PENDING_MESSAGE,
            logs,
          });
          return;
        }
        if (material) store.updateMaterialStatus(material.id, 'failed');
        sendJson(res, 500, { ok: false, error: message, logs });
      }
      return;
    }
    if (req.method === 'POST' && hubInvitesMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubInvitesMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can invite parents.' }); return; }
      const token = store.createInvite(hub.id, actor.id);
      // Brief 068: a hub with no challenge question gets a nudge in the
      // share box, for whoever can add one (the hub's admins).
      const joinSettings = store.getJoinSettings(hub.id) || {};
      sendJson(res, 200, {
        ok: true, token, path: `/join/${token}`, url: `/join/${token}`,
        has_question: Boolean(joinSettings.has_question),
        can_set_question: !hub.is_demo && store.getMemberRole(hub.id, actor.id) === 'admin',
      });
      return;
    }
    if (req.method === 'POST' && hubInviteRevokeMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubInviteRevokeMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can manage invites.' }); return; }
      const body = await readJsonBody(req);
      if (body.token) store.revokeInvite(hub.id, String(body.token));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && joinInfoMatch) {
      const info = store.getInvite(joinInfoMatch[1]);
      if (!info) {
        const expired = store.inviteState(joinInfoMatch[1]) === 'expired';
        sendJson(res, 404, { error: expired ? INVITE_EXPIRED : INVITE_MISSING, expired });
        return;
      }
      const settings = store.getJoinSettings(info.hub_id);
      sendJson(res, 200, {
        hub_name: info.hub_name,
        kind: info.kind,
        inviter_first_name: info.inviter_first_name,
        member_count: info.member_count,
        has_question: settings.has_question,
        question: settings.has_question ? settings.question : '',
        questions: settings.has_question ? settings.questions : [],
        challenge_note: settings.has_question ? joinChallengeNote(info.hub_id, questionCount(settings)) : '',
        // Brief 070: only when the question will really be asked.
        challenge_signpost: settings.has_question && !linkJoinsOpen(info.hub_id, settings)
          ? joinChallengeSignpost(info.hub_id, questionCount(settings)) : '',
        needs_admin_ok: !linkJoinsOpen(info.hub_id, settings) && !settings.has_question,
        admin_first_name: hubAdminFirstName(info.hub_id),
      });
      return;
    }
    if (req.method === 'POST' && joinAcceptMatch) {
      const info = store.getInvite(joinAcceptMatch[1]);
      if (!info) {
        const expired = store.inviteState(joinAcceptMatch[1]) === 'expired';
        sendJson(res, 404, { error: expired ? INVITE_EXPIRED : INVITE_MISSING, expired });
        return;
      }
      // A session that already holds a real (non-demo) family joins
      // immediately. A demo viewer (or a session with no family yet) is
      // NOT joined here — the client shows the account question instead,
      // and the invite completes after sign-in or family setup. The demo
      // profile must never become a member of a non-demo hub.
      const own = bearerAuth ? bearerAuth.profile : store.getSessionOwnProfile(session);
      // Brief 070: read the body first, so an answer sent before there is a
      // family is never silently dropped — the reply says it was not checked
      // and that the question comes right after setup.
      const body = await readJsonBody(req).catch(() => ({}));
      if (!own || own.is_demo) {
        const settings = store.getJoinSettings(info.hub_id);
        const asksLater = Boolean(settings.has_question) && !linkJoinsOpen(info.hub_id, settings);
        const sentAnswer = joinAnswersFrom(body).some((a) => a.trim());
        sendJson(res, 409, {
          error: asksLater && sentAnswer
            ? 'Set up your family or sign in first — your answer wasn’t checked yet. You’ll answer the hub’s question right after, and your invite is saved.'
            : 'To join this hub, sign in or set up your family first — your invite is saved.',
          answer_checked: false,
          question_after_setup: asksLater,
          challenge_signpost: asksLater ? joinChallengeSignpost(info.hub_id, questionCount(settings)) : '',
          needsAccountChoice: true,
          needs_account_choice: true,
          hub_name: info.hub_name,
          hubName: info.hub_name,
          kind: info.kind,
          inviter_first_name: info.inviter_first_name,
          member_count: info.member_count,
        });
        return;
      }
      // Brief 067: the hub's join question, or the admin's OK, decides.
      let outcome;
      try {
        outcome = joinByLink(info, own, joinAnswersFrom(body),
          bearerAuth ? 'via agent: ' + bearerAuth.token.name : 'invite', clientIp(req));
      } catch (err) {
        sendJson(res, 403, { error: err && err.message ? err.message : String(err) });
        return;
      }
      sendJson(res, outcome.status, outcome.body);
      return;
    }
    if (req.method === 'POST' && hubRequestsMatch) {
      const hub = store.getHub(hubRequestsMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      const active = store.getSessionViewer(session);
      if (!active) { sendJson(res, 400, { error: 'Set up your family first.', needsOnboarding: true }); return; }
      const pendingAsk = pendingFamilyRefusal(active);
      if (pendingAsk) { sendJson(res, pendingAsk.status, pendingAsk.body); return; }
      if (store.isMember(hub.id, active.id)) { sendJson(res, 200, { ok: true, alreadyMember: true }); return; }
      const request = store.createJoinRequest(hub.id, active.id);
      sendJson(res, 200, { ok: true, request });
      return;
    }
    if (req.method === 'GET' && hubRequestsMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubRequestsMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || store.getMemberRole(hub.id, actor.id) !== 'admin') { sendJson(res, 403, { error: 'Only hub admins can see requests.' }); return; }
      sendJson(res, 200, { requests: store.listJoinRequests(hub.id) });
      return;
    }
    if (req.method === 'POST' && hubRequestDecideMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubRequestDecideMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || store.getMemberRole(hub.id, actor.id) !== 'admin') { sendJson(res, 403, { error: 'Only hub admins can decide requests.' }); return; }
      let updated = null;
      try {
        updated = store.decideJoinRequest(hub.id, hubRequestDecideMatch[2], actor.id, hubRequestDecideMatch[3] === 'approve');
      } catch (err) {
        sendJson(res, 403, { error: err && err.message ? err.message : String(err) });
        return;
      }
      if (!updated) { sendJson(res, 404, { error: 'That request could not be found.' }); return; }
      sendJson(res, 200, { ok: true, request: updated, requests: store.listJoinRequests(hub.id), hub: store.getHub(hub.id) });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
  }
});

if (require.main === module) {
  // Hosted copy: write the database back to durable storage before the
  // instance is replaced (Cloud Run sends SIGTERM on rollout/scale-down).
  // Best-effort with a bounded wait; the debounced write-back covers the rest.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const done = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    Promise.race([
      store.flushDurableStore(),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]).then(done, done);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Keep the event loop busy until the server is listening. While initDb
  // waits on V8 compiling sql.js's WebAssembly, nothing else holds the loop
  // open, so libuv returns and Node drains V8's task queues. Boot then
  // carries on inside that drain, listens, and can deadlock in
  // NodePlatform::DrainTasks (nodejs/node#54918, unfixed in Node 20): the
  // server accepts TCP connections but never answers and ignores SIGTERM.
  // Under parallel load about 15% of boots hung this way; 0 of 144 with
  // this hold.
  const bootHold = setInterval(() => {}, 1000);
  store
    .initDb()
    .then(() => {
      server.listen(PORT, '0.0.0.0', () => {
        clearInterval(bootHold);
        // Brief 067: drop agent join requests that can no longer be used.
        setInterval(() => {
          try { store.sweepAgentConnects(); } catch (e) { /* next hour */ }
        }, 60 * 60 * 1000).unref();
        console.log(`School Agent Network listening at http://0.0.0.0:${PORT}`);
        console.log(`Model routing: ${MODEL_ROUTING} (${EMBER_FIRST ? `extraction + evening check on ${FAST_MODEL} first, escalating to ${MODEL}` : `all calls on ${MODEL}`}; OCR + identity reads on ${MODEL}) via ${API_URL}`);
        console.log(
          API_KEY
            ? 'SCHOOL_AGENT_API_KEY: present (configured)'
            : 'SCHOOL_AGENT_API_KEY: MISSING — Run will show the error in the event log'
        );
      });
    })
    .catch((err) => {
      console.error('Could not start the local database:', err.message);
      process.exit(1);
    });
}

module.exports = { normalizeParentResult, normalizeFact, buildParentPrompt, placementLinesForRun, deriveMaterialTitle, addDueSoonNudges, withDoneApplied, eveningMoment };
