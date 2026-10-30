// School Agent — Phase 1 server (Node stdlib only, no build step).
// Start: node server.js
// The browser never calls the Meta Model API; this server does, using
// SCHOOL_AGENT_API_KEY from .env. Only data/mock-newsletter.txt is read.

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./db');
const pdfParse = require('pdf-parse');
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

function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script\s*>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style\s*>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  return t.replace(/\s+/g, ' ').trim().slice(0, 6000);
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

function cleanField(value) {
  return value ? String(value).trim() : '';
}

async function extractIdentityFields(pageText, kind) {
  if (!API_KEY) throw new Error('SCHOOL_AGENT_API_KEY is missing or empty in .env.');
  const system = kind === 'team'
    ? 'You read a team or league web page and return the team identity as JSON. Return ONLY a JSON object, no markdown fences. Keys: name (team or organization name), sport (one of: Hockey, Soccer, Baseball, Softball, Basketball, Volleyball, Lacrosse, Swimming, Other), level (House League, Select, Rep, A, AA, AAA, or "" if unclear). Use "" for anything you cannot find.'
    : 'You read a school web page and return the school identity as JSON. Return ONLY a JSON object, no markdown fences. Keys: school_name, city, province, country. Use "" for anything you cannot find.';
  const content = await postMetaChat(system, 'Web page text:\n\n' + pageText, 1024);
  const parsed = extractJsonObject(content);
  if (kind === 'team') {
    return { name: cleanField(parsed.name), sport: cleanField(parsed.sport), level: cleanField(parsed.level) };
  }
  return {
    school_name: cleanField(parsed.school_name),
    city: cleanField(parsed.city),
    province: cleanField(parsed.province),
    country: cleanField(parsed.country),
  };
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

async function extractAndSaveFacts(newsletterText, logs, hubId, materialId, scopeOverride) {
  const push = (message) => logs.push({ at: nowIso(), message });
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
  let materialTitle = '';
  if (materialId) {
    try {
      const material = store.getMaterial(materialId);
      materialTitle = material && material.title ? String(material.title) : '';
    } catch {
      materialTitle = '';
    }
  }
  const withHub = facts.map((f) =>
    scopeOverride
      ? { ...f, hub_id: hubId || '', material_id: materialId || '', scope: scopeOverride.scope, scope_value: scopeOverride.value, group_label: f.group_label || materialTitle }
      : { ...f, hub_id: hubId || '', material_id: materialId || '', group_label: f.group_label || materialTitle }
  );
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

function resolveAudience(actor, audience, hubId) {
  const mode = String(audience || 'auto').toLowerCase();
  if (mode === '' || mode === 'auto') return null;
  if (mode === 'school') return { scope: 'school', value: '' };
  const placed = actor ? store.effectivePlacements(hubId, actor.id) : [];
  if (mode === 'grade') {
    const grade = placed.map((p) => p.grade).find((g) => String(g || '').trim());
    if (!grade) throw new Error('Add your child’s grade for this hub first, then choose that scope.');
    return { scope: 'grade', value: String(grade) };
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) {
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
      const profile = store.getSessionViewer(session);
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
        profile: active,
      });
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
      const profile = store.createProfile({
        parent_name: parentName,
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
        const profile = store.updateProfileNames(active.id, {
          parent_name: body.parent_name,
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
        const facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override);
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
        const facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override);
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
        const result = await runParentAgent(logs, simulatedLabel, store.getSessionViewer(session));
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
    const hubPlacementsMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/placements$/);
    const hubMaterialsMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials$/);
    const hubMaterialTextMatch = url.pathname.match(/^\/api\/hubs\/([^/]+)\/materials\/([^/]+)\/text$/);
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
      const actor = store.getSessionViewer(session);
      sendJson(res, 200, { hubs: actor ? store.listHubsForProfile(actor.id) : [] });
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
      try {
        pageText = await fetchPageText(parsedUrl.toString());
      } catch (err) {
        pageText = '';
      }
      if (!pageText) {
        sendJson(res, 500, { error: 'That page didn’t load — check the link and try again, or just type the details in.' });
        return;
      }
      try {
        const fields = await extractIdentityFields(pageText, kind);
        sendJson(res, 200, { ok: true, kind, domain: parsedUrl.hostname, fields });
      } catch (err) {
        sendJson(res, 500, { error: 'The page loaded but the details couldn’t be read — just type them in.' });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/hubs') {
      const actor = store.getSessionViewer(session);
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
        const hub = store.createHub(actor.id, displayName, kind, { school_name: schoolName, city, province, country });
        sendJson(res, 200, { ok: true, hub });
        return;
      }
      if (!String(body.name || '').trim()) { sendJson(res, 400, { error: 'Give your hub a name.' }); return; }
      const extra = kind === 'team'
        ? { sport: String(body.sport || '').trim(), level: String(body.level || '').trim() }
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
    if (req.method === 'GET' && hubMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can see this hub.' }); return; }
      const placement = store.placementStatus(hub.id, actor.id);
      sendJson(res, 200, {
        hub: { ...hub, role: store.getMemberRole(hub.id, actor.id) },
        facts: store.listFacts(hub.id, actor.id),
        materials: store.listMaterials(hub.id, actor.id),
        member_count: hub.member_count,
        children: actor.children || [],
        placements: placement.placements,
        needs_placement: placement.needs_placement,
      });
      return;
    }
    if (req.method === 'POST' && hubPlacementsMatch) {
      const actor = store.getSessionViewer(session);
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
    if (req.method === 'POST' && hubMaterialsMatch) {
      const actor = store.getSessionViewer(session);
      const hub = store.getHub(hubMaterialsMatch[1]);
      if (!hub) { sendJson(res, 404, { error: 'That hub could not be found.' }); return; }
      if (!actor || !store.isMember(hub.id, actor.id)) { sendJson(res, 403, { error: 'Only members can add material to this hub.' }); return; }
      const body = await readJsonBody(req);
      const logs = [];
      let material = null;
      try {
        if (!API_KEY) throw new Error('SCHOOL_AGENT_API_KEY is missing or empty in .env. Add it and restart the server.');
        let text = '';
        let kind = body.kind === 'pdf' ? 'pdf' : 'paste';
        if (kind === 'pdf') {
          if (!body.fileBase64) throw new Error('Choose a PDF file first.');
          const parsed = await pdfParse(Buffer.from(String(body.fileBase64), 'base64'));
          text = String(parsed.text || '').trim();
          if (!text) throw new Error('That PDF did not include readable text.');
        } else {
          text = String(body.text || '').trim();
          if (!text) throw new Error('Paste a newsletter or notice first.');
        }
        const override = resolveAudience(actor, body.audience, hub.id);
        material = store.createMaterial(hub.id, actor.id, kind, String(body.title || (kind === 'pdf' ? 'PDF notice' : 'Pasted notice')), text, 'stored');
        const facts = await extractAndSaveFacts(text, logs, hub.id, material.id, override);
        store.updateMaterialStatus(material.id, 'extracted');
        sendJson(res, 200, {
          ok: true,
          material: { id: material.id, hub_id: hub.id, kind, title: material.title, status: 'extracted', created_at: material.created_at },
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
      const active = store.getSessionViewer(session);
      if (!active) {
        sendJson(res, 400, { error: 'Set up your family first, then accept the invite.', needsOnboarding: true, needs_onboarding: true });
        return;
      }
      store.addMember(info.hub_id, active.id, 'member', 'invite');
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
      const updated = store.decideJoinRequest(hub.id, hubRequestDecideMatch[2], actor.id, hubRequestDecideMatch[3] === 'approve');
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

module.exports = { normalizeParentResult, normalizeFact, buildParentPrompt, placementLinesForRun };
