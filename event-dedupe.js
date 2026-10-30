'use strict';

// Same-event detection shared by conflict detection (read path) and fact
// storage (write path).
//
// Conservative rule: two facts describe the SAME event only when they share a
// hub, share a date, and their titles match after normalization (case and
// punctuation folded, month names spelled or numeric treated alike,
// date fragments dropped, one title containing the other). Anything else is
// treated as different events.

const MONTH_FULL_TO_ABBR = {
  january: 'jan',
  february: 'feb',
  march: 'mar',
  april: 'apr',
  may: 'may',
  june: 'jun',
  july: 'jul',
  august: 'aug',
  september: 'sep',
  october: 'oct',
  november: 'nov',
  december: 'dec',
};

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const WEEKDAYS =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun';

// Minimum normalized length for the shorter title to count as "contained".
// Without this, a short word like "day" would match half the calendar.
const MIN_CONTAINMENT_LENGTH = 8;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEventTitle(title) {
  let s = String(title || '').toLowerCase();
  for (const [full, abbr] of Object.entries(MONTH_FULL_TO_ABBR)) {
    s = s.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
  }
  s = s
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(
      new RegExp(`\\b(?:${MONTHS})\\b\\.?\\s*\\d{1,2}(?:\\s*[-\u2013\u2014]\\s*\\d{1,2})?`, 'g'),
      ' '
    )
    .replace(/\b\d{1,2}\s*[-\u2013\u2014]\s*\d{1,2}\b/g, ' ')
    .replace(new RegExp(`\\b(?:${WEEKDAYS})\\b`, 'g'), ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function titlesMatchSameEvent(titleA, titleB) {
  const ka = normalizeEventTitle(titleA);
  const kb = normalizeEventTitle(titleB);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (shorter.length < MIN_CONTAINMENT_LENGTH) return false;
  return new RegExp(`\\b${escapeRegExp(shorter)}\\b`).test(longer);
}

function sameHub(a, b) {
  const idA = String((a && a.hub_id) || '');
  const idB = String((b && b.hub_id) || '');
  if (idA && idB) return idA === idB;
  const nameA = String((a && (a.hub_name || a.hub)) || '').trim().toLowerCase();
  const nameB = String((b && (b.hub_name || b.hub)) || '').trim().toLowerCase();
  return Boolean(nameA && nameA === nameB);
}

function isSameEvent(a, b) {
  if (!a || !b) return false;
  const dateA = String(a.date || '');
  const dateB = String(b.date || '');
  if (!dateA || dateA !== dateB) return false;
  if (!sameHub(a, b)) return false;
  return titlesMatchSameEvent(a.title, b.title);
}

function sameScope(a, b) {
  const scopeA = String((a && a.scope) || 'school').toLowerCase();
  const scopeB = String((b && b.scope) || 'school').toLowerCase();
  if (scopeA !== scopeB) return false;
  return String((a && a.scope_value) || '') === String((b && b.scope_value) || '');
}

// The clearer title keeps the shared core: when both titles normalize alike,
// the longer raw title carries more detail (often the date); when one title
// contains the other, the shorter one names the event itself.
function clearerTitle(a, b) {
  const titleA = String((a && a.title) || '');
  const titleB = String((b && b.title) || '');
  const ka = normalizeEventTitle(titleA);
  const kb = normalizeEventTitle(titleB);
  if (ka === kb) return titleB.length >= titleA.length ? titleB : titleA;
  return ka.length <= kb.length ? titleA : titleB;
}

function splitUnion(value, separator) {
  const parts = String(value || '')
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set();
  return parts.filter((part) => {
    const key = part.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function joinUnique(values, separator) {
  const parts = [];
  for (const value of values || []) {
    for (const part of splitUnion(value, separator)) {
      if (!parts.some((done) => done.toLowerCase() === part.toLowerCase())) {
        parts.push(part);
      }
    }
  }
  return parts.join(separator);
}

function longerText(a, b) {
  const textA = String(a || '');
  const textB = String(b || '');
  return textB.length > textA.length ? textB : textA;
}

function mergeFactPair(base, next) {
  const merged = Object.assign({}, base, { id: base.id });
  merged.title = clearerTitle(base, next);
  merged.detail = longerText(base.detail, next.detail);
  merged.applies_to = longerText(base.applies_to, next.applies_to);
  merged.group_label = joinUnique([base.group_label, next.group_label], ' / ');
  merged.group_summary = longerText(base.group_summary, next.group_summary);
  merged.source_text = joinUnique([base.source_text, next.source_text], '\n\n');
  merged.source_document = joinUnique([base.source_document, next.source_document], '; ');
  merged.link = String(base.link || next.link || '');
  merged.time = String(base.time || next.time || '');
  merged.type = base.type || next.type;
  if (next.action_required && !base.action_required) {
    merged.action_required = true;
    merged.action = next.action || base.action;
  } else if (base.action_required && next.action_required) {
    merged.action = longerText(base.action, next.action);
  }
  const confidenceA = Number(base.confidence || 0);
  const confidenceB = Number(next.confidence || 0);
  merged.confidence = Math.max(
    Number.isNaN(confidenceA) ? 0 : confidenceA,
    Number.isNaN(confidenceB) ? 0 : confidenceB
  );
  return merged;
}

// Fold same-event duplicates into one fact each. Facts scoped to different
// audiences are never merged: they stay separate rows (and conflict detection
// still skips them as the same event).
function mergeSameEventFacts(facts) {
  const merged = [];
  for (const fact of facts || []) {
    const hit = merged.findIndex((done) => isSameEvent(done, fact) && sameScope(done, fact));
    if (hit === -1) {
      merged.push(Object.assign({}, fact));
    } else {
      merged[hit] = mergeFactPair(merged[hit], fact);
    }
  }
  return merged;
}

function parseClock(text) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(String(text || ''));
  if (!m) return null;
  let hours = Number(m[1]) % 12;
  if (/pm/i.test(m[3] || '')) hours += 12;
  return hours * 60 + Number(m[2] || 0);
}

function factWindow(fact) {
  if (!fact.date) return null;
  const times = String(fact.time || '').match(/\d{1,2}(?::\d{2})?\s*(?:AM|PM)?/gi) || [];
  if (fact.type === 'deadline') {
    const at = times.length ? parseClock(times[times.length - 1]) : 23 * 60 + 59;
    return { start: at, end: at, deadline: true, allDay: false };
  }
  if (!times.length) return { start: 0, end: 24 * 60, deadline: false, allDay: true };
  const start = parseClock(times[0]);
  const end = times.length > 1 ? parseClock(times[1]) : start + 60;
  return { start, end: Math.max(end, start), deadline: false, allDay: false };
}

function humanDateShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const label = d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return label.replace(/^(\w+),/, '$1,');
}

function detectConflicts(relevant) {
  const conflicts = [];
  const dated = (relevant || []).filter((f) => f.date);
  for (let i = 0; i < dated.length; i += 1) {
    for (let j = i + 1; j < dated.length; j += 1) {
      const a = dated[i];
      const b = dated[j];
      if (a.date !== b.date) continue;
      if (isSameEvent(a, b)) continue;
      const wa = factWindow(a);
      const wb = factWindow(b);
      if (!wa || !wb) continue;
      let overlaps = false;
      if (wa.deadline && wb.deadline) {
        overlaps = false;
      } else if (wa.deadline || wb.deadline) {
        const deadline = wa.deadline ? wa : wb;
        const other = wa.deadline ? wb : wa;
        overlaps = !other.allDay && deadline.start >= other.start && deadline.start <= other.end;
      } else {
        overlaps = wa.start < wb.end && wb.start < wa.end;
      }
      if (!overlaps) continue;
      const hubA = a.hub_name || a.hub || 'a hub';
      const hubB = b.hub_name || b.hub || 'a hub';
      const day = humanDateShort(a.date);
      conflicts.push({
        date: a.date,
        fact_a: a,
        fact_b: b,
        facts: [a, b],
        hub_names: [hubA, hubB],
        cross_hub: hubA !== hubB,
        message: `${a.title} (${hubA}) overlaps ${b.title} (${hubB}) on ${day}`,
      });
    }
  }
  conflicts.sort((x, y) => Number(y.cross_hub) - Number(x.cross_hub));
  return conflicts;
}

module.exports = {
  normalizeEventTitle,
  isSameEvent,
  sameScope,
  clearerTitle,
  mergeFactPair,
  mergeSameEventFacts,
  detectConflicts,
};
