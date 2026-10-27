// School Agent — Phase 1 server (Node stdlib only, no build step).
// Start: node server.js
// The browser never calls the Meta Model API; this server does, using
// SCHOOL_AGENT_API_KEY from .env. Only data/mock-newsletter.txt is read.

const http = require('http');
const fs = require('fs');
const path = require('path');

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
  return {
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
    'confidence (number 0-1), supersedes (string, "" unless this fact replaces an earlier one).',
    'Rules:',
    '- source_text must be copied verbatim from the newsletter for every fact.',
    '- confidence reflects how certain the extraction is (1.0 = explicit in the text).',
    '- The newsletter covers the week of November 2-6, 2026 (Mon Nov 2 to Fri Nov 6, 2026).',
    '  Resolve relative dates ("Friday", "November 18") to ISO dates in 2026.',
    '  Friday of that week is 2026-11-06.',
    '- source_document should name the Maple Grove Elementary newsletter.',
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

async function postMetaChat(system, user, maxTokens) {
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
  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      'Meta Model API returned no message content: ' + bodyText.slice(0, 500)
    );
  }
  return content;
}

async function callMetaApi(newsletterText) {
  const { system, user } = buildPrompt(newsletterText);
  return postMetaChat(system, user, 32768);
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

function buildParentPrompt(profile, facts) {
  const soul = profile.soul || {};
  const system = [
    'You are the Parent Agent for ONE fictional demo family at Maple Grove Elementary.',
    'Soul rules (shared core — obey exactly):',
    '- I work for this family alone.',
    "- I never share this family's private information anywhere (not to the school, not to any group, not to anyone).",
    '- I say where my facts came from (source: School Agent facts from the Maple Grove Elementary newsletter).',
    '- I am a secretary, not a decision-maker: I surface, remind, and prepare; the parent decides.',
    'Family soul:',
    `- Priorities: ${(soul.priorities || []).join('; ')}`,
    `- Nudge style: ${soul.nudge_style || 'one short message in the evening'}`,
    `- Wishes: ${(soul.wishes || []).join('; ')}`,
    `Simulated current moment: ${SIMULATED_NOW_LABEL}. Tomorrow is Friday, November 6, 2026.`,
    'Task: filter the School Agent facts for this child only, then build the evening check.',
    'Return ONLY a JSON object. No markdown fences, no commentary. Keys exactly:',
    'relevant_facts, nudges, calendar_hold, filtered_out_count, filtering_summary.',
    'Shapes:',
    '- relevant_facts: array of objects {id, title} copied from the input facts, ONLY facts that apply to this child/family (school-wide, all grades, all students, Grade 3, or Grades 3-8 count as applying; facts explicitly limited to other grades/groups do not).',
    '- nudges: array of objects {fact_id, title, action, deadline, source}. Create a nudge ONLY for a fact with action_required=true whose tracked action state in profile.actions is still open (not done / not ordered). Tracked mapping: pizza_order -> the pizza orders fact; uniform_survey -> the uniform survey fact; picture_retake is already "scheduled" so NO nudge; fall_festival is "planning_to_attend" (not an open action) so NO nudge. Do NOT create nudges for untracked requirement facts in this evening check; keep them in relevant_facts only.',
    '- Each nudge action must say what to do in plain language; deadline must be the fact date; source must name the school newsletter source (use the fact source_document).',
    '- calendar_hold: ONE object {title, date, note} for the pizza order deadline only. date must be "2026-11-06" (Friday, November 6, 2026). note must be one short calm evening note mentioning the pizza order is not yet ordered.',
    '- filtered_out_count: number of input facts NOT in relevant_facts.',
    '- filtering_summary: ONE line explaining why facts were filtered out.',
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

  const filteredOutCount = facts.length - relevant.length;
  const summaryText = String(
    raw.filtering_summary || raw.summary || ''
  ).trim() ||
    `${filteredOutCount} facts filtered out because they do not apply to this child.`;

  return {
    relevant_facts: relevant,
    nudges,
    calendar_hold: calendarHold,
    filtered_out_count: filteredOutCount,
    filtering_summary: summaryText,
    summary: summaryText,
    checked_count: facts.length,
    relevant_count: relevant.length,
    open_action_count: nudges.length,
  };
}

async function callParentMetaApi(profile, facts) {
  const { system, user } = buildParentPrompt(profile, facts);
  return postMetaChat(system, user, 8192);
}

async function runParentAgent(logs) {
  const push = (message) => logs.push({ at: nowIso(), message });
  push('evening check started');
  push(`simulated time: ${SIMULATED_NOW_LABEL}`);
  if (!API_KEY) {
    throw new Error(
      'SCHOOL_AGENT_API_KEY is missing or empty in .env. Add it and restart the server.'
    );
  }
  if (!fs.existsSync(FACTS_PATH)) {
    throw new Error('data/facts.json not found — run the School Agent first.');
  }
  if (!fs.existsSync(FAMILY_PROFILE_PATH)) {
    throw new Error('data/family-profile.json not found.');
  }
  const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
  if (!Array.isArray(facts)) {
    throw new Error('data/facts.json is not a JSON array.');
  }
  const profile = JSON.parse(fs.readFileSync(FAMILY_PROFILE_PATH, 'utf8'));
  const childName = (profile.child && profile.child.name) || 'the child';
  push(`family profile loaded for ${childName} (private to this Parent Agent)`);
  push(`${facts.length} facts checked against the family profile`);
  push(`API called: POST ${API_URL} (model: ${MODEL})`);
  const content = await callParentMetaApi(profile, facts);
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
  push(PRIVACY_CHECK_LINE);
  return result;
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
  push(`API called: POST ${API_URL} (model: ${MODEL})`);
  const content = await callMetaApi(newsletterText);
  push('API responded — parsing facts');
  const rawFacts = extractJsonArray(content);
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
  fs.writeFileSync(FACTS_PATH, JSON.stringify(facts, null, 2) + '\n', 'utf8');
  push(`facts saved to data/facts.json`);
  return facts;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(INDEX_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/newsletter') {
      const text = fs.readFileSync(NEWSLETTER_PATH, 'utf8');
      sendJson(res, 200, { text });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/facts') {
      if (!fs.existsSync(FACTS_PATH)) {
        sendJson(res, 200, { facts: [] });
        return;
      }
      const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
      sendJson(res, 200, { facts: Array.isArray(facts) ? facts : [] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/family-profile') {
      if (!fs.existsSync(FAMILY_PROFILE_PATH)) {
        sendJson(res, 404, { error: 'family profile not found' });
        return;
      }
      const profile = JSON.parse(fs.readFileSync(FAMILY_PROFILE_PATH, 'utf8'));
      sendJson(res, 200, { profile });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/run') {
      const logs = [];
      try {
        const result = await runParentAgent(logs);
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
        const facts = await runSchoolAgent(logs);
        sendJson(res, 200, { ok: true, facts, logs });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        logs.push({ at: nowIso(), message: `error: ${message}` });
        sendJson(res, 500, { ok: false, error: message, logs });
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`School Agent (Phase 1) listening at http://0.0.0.0:${PORT}`);
  console.log(`Model: ${MODEL} via ${API_URL}`);
  console.log(
    API_KEY
      ? 'SCHOOL_AGENT_API_KEY: present (configured)'
      : 'SCHOOL_AGENT_API_KEY: MISSING — Run will show the error in the event log'
  );
});
