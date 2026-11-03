// School Agent — Phase 1 server (Node stdlib only, no build step).
// Start: node server.js
// The browser never calls the Meta Model API; this server does, using
// SCHOOL_AGENT_API_KEY from .env. Only data/mock-newsletter.txt is read.

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./db');
const { sendRecoveryEmail, isRecoveryMailConfigured } = require('./recovery-mail');
const pdfParse = require('pdf-parse');
const zlib = require('zlib');
const { mergeSameEventFacts, detectConflicts } = require('./event-dedupe');

const ROOT = __dirname;
const NEWSLETTER_PATH = path.join(ROOT, 'data', 'mock-newsletter.txt');
const FACTS_PATH = path.join(ROOT, 'data', 'facts.json');
const FAMILY_PROFILE_PATH = path.join(ROOT, 'data', 'family-profile.json');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');

// Simulated scheduler moment for the Phase 2 evening check (demo only).
const SIMULATED_NOW_LABEL = 'Thursday, November 5, 2026, 7:30 PM';
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
const MODEL = process.env.SCHOOL_AGENT_MODEL || 'muse-spark-1.3';
const API_URL =
  process.env.SCHOOL_AGENT_API_URL || 'https://api.meta.ai/v1/chat/completions';
const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const LOGIN_SCOPES = 'openid email profile';
const TEST_AUTH_ENABLED = process.env.PARENTLOOP_TEST_AUTH === '1';
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

// pdf.js image kinds: 1 = 1bpp grayscale, 2 = RGB 24bpp, 3 = RGBA 32bpp.
// Anything else is inferred from the decoded data length.
function encodeImageAsPng(img) {
  if (!img || !img.width || !img.height || !img.data || !img.data.length) return null;
  const { width, height } = img;
  let kind = img.kind;
  if (kind !== 1 && kind !== 2 && kind !== 3) {
    if (img.data.length >= width * height * 4) kind = 3;
    else if (img.data.length >= width * height * 3) kind = 2;
    else if (img.data.length >= width * height) kind = 4; // 8-bit grayscale
    else return null;
  }
  let colorType;
  let rows;
  if (kind === 2) {
    colorType = 2;
    rows = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) {
      rows[y * (1 + width * 3)] = 0;
      Buffer.from(img.data.buffer, img.data.byteOffset + y * width * 3, width * 3).copy(rows, y * (1 + width * 3) + 1);
    }
  } else if (kind === 3) {
    colorType = 6;
    rows = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      rows[y * (1 + width * 4)] = 0;
      Buffer.from(img.data.buffer, img.data.byteOffset + y * width * 4, width * 4).copy(rows, y * (1 + width * 4) + 1);
    }
  } else if (kind === 1) {
    colorType = 0;
    const rowBytes = Math.ceil(width / 8);
    rows = Buffer.alloc(height * (1 + width));
    for (let y = 0; y < height; y++) {
      rows[y * (1 + width)] = 0;
      for (let x = 0; x < width; x++) {
        const byte = img.data[y * rowBytes + (x >> 3)] || 0;
        rows[y * (1 + width) + 1 + x] = byte & (0x80 >> (x & 7)) ? 0 : 255;
      }
    }
  } else {
    colorType = 0;
    rows = Buffer.alloc(height * (1 + width));
    for (let y = 0; y < height; y++) {
      rows[y * (1 + width)] = 0;
      Buffer.from(img.data.buffer, img.data.byteOffset + y * width, width).copy(rows, y * (1 + width) + 1);
    }
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

let pdfJsLibCache = undefined;
function pdfJsLib() {
  if (pdfJsLibCache !== undefined) return pdfJsLibCache;
  try {
    // Same pdf.js build pdf-parse uses by default. The binding must not
    // be named PDFJS: the bundle references that as a global and a
    // same-named local const puts it in the temporal dead zone.
    pdfJsLibCache = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
    pdfJsLibCache.disableWorker = true;
  } catch {
    pdfJsLibCache = null;
  }
  return pdfJsLibCache;
}

// Largest embedded image on each requested page, as PNG bytes.
// Returns a Map of 1-based page number -> Buffer. Never throws.
async function extractPageImages(pdfBuffer, pageNumbers) {
  const images = new Map();
  const lib = pdfJsLib();
  if (!lib || !pageNumbers.length) return images;
  let doc = null;
  try {
    const task = lib.getDocument(new Uint8Array(pdfBuffer));
    doc = await (task && task.promise ? task.promise : task);
    const imageOps = new Set(
      [lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintJpegXObject]
        .filter((v) => typeof v === 'number')
    );
    for (const pageNumber of pageNumbers) {
      try {
        const page = await doc.getPage(pageNumber);
        const opList = await page.getOperatorList();
        let best = null;
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
          if (img && img.width && img.height && (!best || img.width * img.height > best.width * best.height)) best = img;
        }
        if (best) {
          const png = encodeImageAsPng(best);
          if (png) images.set(pageNumber, png);
        }
      } catch {
        // One unreadable page must not sink the others.
      }
    }
  } catch {
    // Fall through with whatever was collected (possibly nothing).
  } finally {
    if (doc) { try { doc.destroy(); } catch { /* already gone */ } }
  }
  return images;
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

async function postMetaChat(system, user, maxTokens) {
  async function attempt() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
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
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.1,
          max_tokens: maxTokens,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`Meta Model API error ${res.status}: ${bodyText.slice(0, 1000)}`);
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new Error('Meta Model API returned non-JSON: ' + bodyText.slice(0, 500));
    }
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

async function callMetaApi(newsletterText) {
  const { system, user } = buildPrompt(newsletterText);
  return postMetaChat(system, user, 32768);
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

async function callMetaApiImage(accompanyingText, image) {
  const { system, userText } = buildImagePrompt(accompanyingText);
  const dataUrl = `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}`;
  const user = [
    { type: 'text', text: userText },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
  return postMetaChat(system, user, 32768);
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
  return postMetaChat(system, user, 8192);
}

// Read the flagged pages of a picture-risk PDF as images. Returns the
// recovered text and whether it is substantial. Never throws: any
// failure (no extractable image, vision error) yields empty text and
// the caller keeps today's text-layer-only behavior.
async function readFlaggedPagesWithOcr(pdfBuffer, pageTexts, text, logs) {
  const push = logs ? (m) => logs.push({ at: nowIso(), message: m }) : () => {};
  const pages = flaggedPdfPages(pageTexts, text, pdfBuffer ? pdfBuffer.length : 0);
  if (!pages.length) return { ocrText: '', picturesRead: false, pages: [] };
  let images;
  try {
    images = await extractPageImages(pdfBuffer, pages);
  } catch {
    return { ocrText: '', picturesRead: false, pages };
  }
  const recovered = [];
  for (const pageNumber of pages) {
    const png = images.get(pageNumber);
    if (!png) continue;
    try {
      const raw = await callMetaApiOcr({ data: png, mime: 'image/png' });
      const pageText = String(raw || '').trim();
      if (pageText) recovered.push(pageText);
    } catch (err) {
      push(`picture read failed for page ${pageNumber}: ${err && err.message ? err.message : String(err)}`);
    }
  }
  const ocrText = recovered.join('\n\n');
  const substantial = ocrText.replace(/\s/g, '').length >= OCR_SUBSTANTIAL_CHARS;
  if (substantial) push(`pictures read with OCR: ${recovered.length} page(s) recovered text`);
  return { ocrText, picturesRead: substantial, pages };
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
  if (kind === 'team') {
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
  const system = kind === 'team'
    ? 'You read a team or league web page and return the team identity as JSON. Return ONLY a JSON object, no markdown fences. Keys: name (team or organization name), sport (one of: Hockey, Soccer, Baseball, Softball, Basketball, Volleyball, Lacrosse, Swimming, Other), level (House League, Select, Rep, A, AA, AAA, or "" if unclear). The page URL and page title are given along with the page text; the title often names the team. Use "" for anything you cannot find.'
    : 'You read a school web page and return the school identity as JSON. Return ONLY a JSON object, no markdown fences. Keys: school_name, city, province, country. The page URL and page title are given along with the page text; the title often names the school. Look for the school\u2019s postal or street address (often in the page footer, for example "2 Glass Dr., Aurora L4G 2E8") and take the city from that address. Fill in province and country whenever they are reasonably inferable instead of leaving them blank: infer them from the city when you know it (for example Toronto means Toronto, Ontario, Canada) or from a school board or district named on the page (for example a Toronto Catholic District School Board page means Toronto, Ontario, Canada). Use "" only for what you cannot find or reasonably infer.';
  const user =
    'Page URL:\n' + pageUrl + '\n\nPage title:\n' + pageTitle +
    '\n\nWeb page text:\n\n' + pageText;
  const content = await postMetaChat(system, user, 4096);
  const parsed = extractJsonObject(content);
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

function buildParentPrompt(profile, facts, simulatedLabel, placementLines) {
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
    '- I say where my facts came from (source: School Agent facts from the Maple Grove Elementary newsletter).',
    '- I am a secretary, not a decision-maker: I surface, remind, and prepare; the parent decides.',
    'Family soul:',
    `- Priorities: ${(soul.priorities || []).join('; ')}`,
    `- Nudge style: ${soul.nudge_style || 'one short message in the evening'}`,
    `- Wishes: ${(soul.wishes || []).join('; ')}`,
    `Simulated current moment: ${simulatedLabel || SIMULATED_NOW_LABEL}. Tomorrow is Friday, November 6, 2026.`,
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
  const user =
    'Family profile (private to this Parent Agent run):\n' +
    JSON.stringify(profile, null, 2) +
    '\n\nSchool Agent facts:\n' +
    JSON.stringify(facts, null, 2);
  return { system, user };
}

function normalizeParentResult(raw, facts) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const byTitle = new Map(facts.map((f) => [f.title, f]));
  const lookupFact = (item) => {
    if (!item) return null;
    if (typeof item === 'string') return byId.get(item) || byTitle.get(item) || null;
    if (item.fact_id && byId.has(item.fact_id)) return byId.get(item.fact_id);
    if (item.id && byId.has(item.id)) return byId.get(item.id);
    if (item.title && byTitle.has(item.title)) return byTitle.get(item.title);
    return null;
  };

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

async function callParentMetaApi(profile, facts, simulatedLabel, placementLines) {
  const { system, user } = buildParentPrompt(profile, facts, simulatedLabel, placementLines);
  return postMetaChat(system, user, 8192);
}

// Structured placements for the prompt's profile JSON: each child's grade and
// class in each school hub. Team hubs carry no placement.
function placementRecordsForRun(profile) {
  const records = [];
  for (const hub of store.listHubsForProfile(profile.id)) {
    if ((hub.kind || 'other') === 'team') continue;
    for (const p of store.effectivePlacements(hub.id, profile.id)) {
      records.push({ hub: hub.name, child: p.child_name, grade: p.grade || '', class: p.class || '' });
    }
  }
  return records;
}

function placementLinesForRun(profile) {
  const lines = [];
  for (const hub of store.listHubsForProfile(profile.id)) {
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
  const simulated = simulatedLabel || SIMULATED_NOW_LABEL;
  push('evening check started');
  push(`simulated time: ${simulated}`);
  if (!API_KEY) {
    throw new Error(
      'SCHOOL_AGENT_API_KEY is missing or empty in .env. Add it and restart the server.'
    );
  }
  const profile = viewer;
  if (!profile) {
    throw new Error('No family profile found — finish setup or switch to the demo family.');
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
  const facts = store.listFactsForProfile(profile.id);
  const hubs = store.listHubsForProfile(profile.id);
  const childNames = (profile.children || [profile.child])
    .map((c) => c && c.name)
    .filter(Boolean);
  const childName = childNames.join(' and ') || 'the child';
  push(`family profile loaded for ${childName} (private to this Parent Agent)`);
  push(`${hubs.length} ${hubs.length === 1 ? 'hub' : 'hubs'} checked: ${hubs.map((h) => h.name).join(', ') || 'none yet'}`);
  push(`${facts.length} facts checked against the family profile`);
  push(`API called: POST ${API_URL} (model: ${MODEL})`);
  const promptProfile = { ...profile, placements: placementRecordsForRun(profile) };
  const content = await callParentMetaApi(promptProfile, facts, simulated, placementLinesForRun(profile));
  push('API responded — validating filtering result');
  const raw = extractJsonObject(content);
  const result = normalizeParentResult(raw, facts);
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

// When stampSource is true (parent-added paste/PDF/email material), the server
// stamps every extracted fact's source_document from the actual material being
// extracted — the material's title when it has one, otherwise the hub's display
// name — replacing whatever the model returned for that field (it copies the
// extraction prompt's Maple Grove example). The demo school run passes no flag,
// so seeded/demo labels stay exactly as they are.
async function extractAndSaveFacts(newsletterText, logs, hubId, materialId, scopeOverride, stampSource, image) {
  const push = (message) => logs.push({ at: nowIso(), message });
  const hasImage = Boolean(image && image.data && image.mime);
  const callModel = () => (hasImage ? callMetaApiImage(newsletterText, image) : callMetaApi(newsletterText));
  push(`API called: POST ${API_URL} (model: ${MODEL})`);
  let content = await callModel();
  push('API responded — parsing facts');
  let rawFacts = extractJsonArray(content);
  // The model sometimes returns a valid but empty fact list for a
  // non-trivial source. Retry the model call ONCE before giving up, so one
  // flaky reply cannot silently save zero facts as a success. An image
  // counts as a non-trivial source on its own.
  const nonWhitespace = String(newsletterText || '').replace(/\s/g, '').length;
  const nonTrivial = nonWhitespace > 100 || hasImage;
  if (rawFacts.length === 0 && nonTrivial) {
    push('no facts parsed from a non-trivial source — retrying the model call once');
    push(`API called: POST ${API_URL} (model: ${MODEL})`);
    content = await callModel();
    push('API responded — parsing facts');
    rawFacts = extractJsonArray(content);
  }
  if (rawFacts.length === 0 && nonTrivial) {
    // Every material route marks the material 'failed' on a throw and
    // returns this message, so the hub list shows the failure instead of
    // an empty success. Tiny pastes keep today's behavior below.
    throw new Error(EMPTY_EXTRACTION_MESSAGE);
  }
  const extractedAt = nowIso();
  const facts = rawFacts.map((f) => normalizeFact(f, extractedAt));
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
  push(`${facts.length} facts extracted`);
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

// One-box adding has no title field: derive the material title from the
// pasted content's first line (which usually carries the date range), so
// extracted facts keep a readable group label. Falls back to a dated
// newsletter label when the content has no usable first line.
function deriveMaterialTitle(text, now) {
  const first = String(text || '')
    .split('\n')
    .map((line) => line.trim().replace(/^#+\s*/, '').trim())
    .find((line) => line);
  if (first) {
    const clean = first.length > 80 ? first.slice(0, 80).trim() + '…' : first;
    if (clean) return clean;
  }
  const at = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  return `Newsletter — ${at.toISOString().slice(0, 10)}`;
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
    description: 'If a parent gave you an invite link, redeem it with POST /api/join/{token}/accept to join that hub. If lookup returned none, create the hub with POST /api/hubs. If create returns 409, the school already has a hub — ask the parent for an invite instead of forcing a duplicate.',
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
    how_to_get: 'Ask the parent to open My family → Agent access, create a named token, and give it to you. The token is shown only once, so store it like a password.',
    scope: 'Tokens are scoped to one family: the token acts only as that family and can only reach that family\'s hubs.',
    scoped_to: 'one family',
    revocable: true,
    notes: [
      'Tokens are revocable: the parent can revoke a token at any time in My family → Agent access, and a revoked token stops working immediately.',
      'A token can never issue, list, or revoke agent tokens — token management is browser-only.',
      'Send the token on every agent request as Authorization: Bearer <token>. Without a token these endpoints fall back to the browser session (demo) view.',
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
      description: 'Redeem an invite token from a /join/{token} link: joins the token\'s family to that hub. Returns { ok, hub }.',
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
      description: 'Add material to a hub the family belongs to and extract its facts. For pasted text send kind paste with title and text. Returns { ok, material, facts_added }.',
    },
  ],
  recipe: AGENT_RECIPE,
  find_or_create: AGENT_RECIPE,
};

function bearerRaw(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : '';
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

function googleAuthUrl(req, profileId) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${publicBaseUrl(req)}/api/email/callback`,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: profileId,
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
  return { sub: String(data.sub), email: String(data.email || '') };
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
    // to session (demo) data.
    const rawBearer = bearerRaw(req);
    let bearerAuth = null;
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
        profile: active,
        auth: store.getSessionIdentity(session),
      });
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
        store.completeGoogleSignIn(session.id, identity.sub, identity.email);
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
      const result = store.completeGoogleSignIn(session.id, sub, email);
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
      const profile = store.createProfileForSession(session.id, {
        parent_name: parentName,
        parent_email: parentEmail,
        children: kidNames.map((name) => ({ name })),
        priorities: body.priorities,
        nudge_style: body.nudge_style,
        actions: body.actions,
      });
      store.setSessionProfile(session.id, profile.id);
      sendJson(res, 200, { ok: true, profile });
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
        material = store.createMaterial(hub.id, actor ? actor.id : '', 'paste', String(body.title || 'Pasted newsletter'), text, 'stored');
        logs.push({ at: nowIso(), message: 'pasted newsletter received' });
        const facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override, true);
        store.updateMaterialStatus(material.id, 'extracted');
        sendJson(res, 200, {
          ok: true,
          facts,
          logs,
          material: { id: material.id, hub_id: hub.id, kind: 'paste', title: material.title, status: 'extracted' },
          facts_added: facts.length,
        });
      } catch (err) {
        if (material) store.updateMaterialStatus(material.id, 'failed');
        const message = err && err.message ? err.message : String(err);
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
      res.writeHead(302, { Location: googleAuthUrl(req, active.id) });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/email/callback') {
      try {
        const code = url.searchParams.get('code');
        const profileId = url.searchParams.get('state') || (store.getSessionViewer(session) || {}).id;
        if (!code) throw new Error('Google did not return a sign-in code.');
        if (!profileId) throw new Error('Save your family first, then connect Gmail.');
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
        material = store.createMaterial(hub.id, active.id, 'email', headers.subject || 'Email newsletter', text, 'stored');
        logs.push({ at: nowIso(), message: 'run started' });
        logs.push({ at: nowIso(), message: 'Gmail message loaded as a hub newsletter' });
        const facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override, true);
        store.updateMaterialStatus(material.id, 'extracted');
        sendJson(res, 200, {
          ok: true,
          facts,
          logs,
          material: { id: material.id, hub_id: hub.id, kind: 'email', title: material.title, status: 'extracted' },
          facts_added: facts.length,
        });
      } catch (err) {
        if (material) store.updateMaterialStatus(material.id, 'failed');
        const message = err && err.message ? err.message : String(err);
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
    if (req.method === 'POST' && url.pathname === '/api/parent/run') {
      const logs = [];
      try {
        let simulatedLabel = SIMULATED_NOW_LABEL;
        try {
          const body = await readJsonBody(req);
          if (body && (body.simulated_now || body.simulatedNow)) {
            simulatedLabel = String(body.simulated_now || body.simulatedNow);
          }
        } catch {
          // No body is fine; the default simulated moment applies.
        }
        const result = await runParentAgent(logs, simulatedLabel, currentViewer(session));
        sendJson(res, 200, {
          ok: true,
          simulated_now: SIMULATED_NOW_LABEL,
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
    const hubMaterialTextMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials\/([^/]+)\/text$/);
    const hubMaterialFileMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials\/([^/]+)\/file$/);
    const hubInvitesMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/invites$/);
    const hubInviteRevokeMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/invites\/revoke$/);
    const hubRequestsMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/join-requests$/);
    const hubRequestDecideMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/join-requests\/([^/]+)\/(approve|decline)$/);
    const joinInfoMatch = url.pathname.match(/^\/api\/join\/([^/]+)$/);
    const joinAcceptMatch = url.pathname.match(/^\/api\/join\/([^/]+)\/accept$/);

    if (req.method === 'GET' && url.pathname.startsWith('/join/')) {
      const html = fs.readFileSync(INDEX_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/hubs') {
      const actor = bearerAuth ? bearerAuth.profile : currentViewer(session);
      sendJson(res, 200, { hubs: actor ? store.listHubsForProfile(actor.id) : [] });
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
      const kind = body.kind === 'team' ? 'team' : 'school';
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
        : null;
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
      const members = store.listHubMembers(hub.id);
      const contacts = store.listHubContacts(hub.id);
      const contactNames = contacts.map((c) => c.parent_name);
      const contactLine = contactNames.join(', ');
      sendJson(res, 200, {
        hub: { ...hub, role: store.getMemberRole(hub.id, actor.id), member_count: members.length },
        facts: store.listFacts(hub.id, actor.id),
        materials: store.listMaterials(hub.id, actor.id).map((m) => {
          const { uploaded_by, ...rest } = m;
          return {
            ...rest,
            can_remove: Boolean(
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
        let kind = requestedKind === 'pdf' && !hasImage ? 'pdf' : hasImage ? 'image' : 'paste';
        let pdfFile = null;
        let imageFile = null;
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
        } else if (kind === 'pdf') {
          if (!body.fileBase64) throw new Error('Choose a PDF file first.');
          const pdfBuffer = Buffer.from(String(body.fileBase64), 'base64');
          if (pdfBuffer.length > MAX_PDF_BYTES) {
            throw new Error('That PDF is too large — the limit is 10 MB. Choose a smaller file.');
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
        } else {
          text = String(body.text || '').trim();
          if (!text) throw new Error('Paste a newsletter or notice first.');
        }
        const override = resolveAudience(actor, body.audience, hub.id);
        const suppliedTitle = String(body.title || '').trim();
        const retainedFile = pdfFile || imageFile;
        const imageTitle = imageFile
          ? String(imageFile.name || '').replace(/\.[a-z0-9]+$/i, '').trim() || deriveMaterialTitle(text)
          : '';
        const materialTitle = suppliedTitle || (text ? deriveMaterialTitle(text) : imageTitle);
        material = store.createMaterial(hub.id, actor.id, kind, materialTitle, text, 'stored', undefined, undefined, retainedFile);
        const facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override, true, imageFile);
        store.updateMaterialStatus(material.id, 'extracted');
        if (bearerAuth) logs.push({ at: nowIso(), message: 'material added via agent: ' + bearerAuth.token.name });
        sendJson(res, 200, {
          ok: true,
          material: { id: material.id, hub_id: hub.id, kind, title: material.title, status: 'extracted', created_at: material.created_at, has_file: Boolean(retainedFile), file_name: retainedFile ? retainedFile.name : '', file_mime: retainedFile && retainedFile.mime ? retainedFile.mime : '', may_have_unread_pictures: Boolean(pdfFile && pdfFile.pictureRisk), pictures_read_with_ocr: Boolean(pdfFile && pdfFile.picturesReadWithOcr) },
          facts,
          facts_added: facts.length,
          count: facts.length,
          logs,
        });
      } catch (err) {
        if (material) store.updateMaterialStatus(material.id, 'failed');
        const message = err && err.message ? err.message : String(err);
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
      sendJson(res, 200, { ok: true, token, path: `/join/${token}`, url: `/join/${token}` });
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
      if (!info) { sendJson(res, 404, { error: 'That invite link is no longer available.' }); return; }
      sendJson(res, 200, {
        hub_name: info.hub_name,
        kind: info.kind,
        inviter_first_name: info.inviter_first_name,
        member_count: info.member_count,
      });
      return;
    }
    if (req.method === 'POST' && joinAcceptMatch) {
      const info = store.getInvite(joinAcceptMatch[1]);
      if (!info) { sendJson(res, 404, { error: 'That invite link is no longer available.' }); return; }
      // A session that already holds a real (non-demo) family joins
      // immediately. A demo viewer (or a session with no family yet) is
      // NOT joined here — the client shows the account question instead,
      // and the invite completes after sign-in or family setup. The demo
      // profile must never become a member of a non-demo hub.
      const own = bearerAuth ? bearerAuth.profile : store.getSessionOwnProfile(session);
      if (!own || own.is_demo) {
        sendJson(res, 409, {
          error: 'To join this hub, sign in or set up your family first — your invite is saved.',
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
      try {
        store.addMember(info.hub_id, own.id, 'member', bearerAuth ? 'via agent: ' + bearerAuth.token.name : 'invite');
      } catch (err) {
        sendJson(res, 403, { error: err && err.message ? err.message : String(err) });
        return;
      }
      sendJson(res, 200, { ok: true, hub: store.getHub(info.hub_id) });
      return;
    }
    if (req.method === 'POST' && hubRequestsMatch) {
      const hub = store.getHub(hubRequestsMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      const active = store.getSessionViewer(session);
      if (!active) { sendJson(res, 400, { error: 'Set up your family first.', needsOnboarding: true }); return; }
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
  store
    .initDb()
    .then(() => {
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`School Agent Network listening at http://0.0.0.0:${PORT}`);
        console.log(`Model: ${MODEL} via ${API_URL}`);
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

module.exports = { normalizeParentResult, normalizeFact, buildParentPrompt, placementLinesForRun, deriveMaterialTitle };
