// Evening email rendering: subject + plain text + simple HTML for one
// family's saved evening check. Rendering only — the check itself and the
// in-app Tonight page are untouched. Pure functions, no I/O, so tests can
// pin the output directly.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBREVIATIONS = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

function isoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

function friendlyDay(iso) {
  const d = isoDate(iso);
  if (!d) return String(iso || '');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Comparison form of a line of text: case, spacing and punctuation ignored.
function plain(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// One to-do line: the action once (or the title when there is no action),
// the title in front only when it adds something the action does not say.
function nudgeLine(n) {
  const title = String(n.title || '').trim();
  const action = String(n.action || '').trim();
  let body;
  if (!action) body = title;
  else if (!title) body = action;
  else {
    const t = plain(title);
    const a = plain(action);
    if (a === t || a.includes(t)) body = action;
    else if (t.includes(a)) body = title;
    else body = `${title} — ${action}`;
  }
  const deadline = n.deadline && !/\(by [^)]*\)\s*$/i.test(body) ? ` (by ${friendlyDay(n.deadline)})` : '';
  return body + deadline;
}

// Clock times actually written on a fact ("3:30 PM", "9 am", "10:00"); a bare
// number ("Grade 9", "November 9-13") is not a time.
function clockTimes(text) {
  const out = [];
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\w:])/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (m[2] === undefined && !m[3]) continue;
    const hours = Number(m[1]);
    const minutes = Number(m[2] || 0);
    if (hours > 23 || minutes > 59) continue;
    out.push({ hours, minutes, meridiem: m[3] ? (/p/i.test(m[3]) ? 'pm' : 'am') : '' });
  }
  // "1:00-2:30 PM": an unmarked time borrows the next marked time's meridiem.
  for (let i = out.length - 2; i >= 0; i -= 1) {
    if (!out[i].meridiem && out[i].hours <= 12 && out[i + 1].meridiem) out[i].meridiem = out[i + 1].meridiem;
  }
  return out.map((c) => {
    let h = c.hours;
    if (c.meridiem) h = (h % 12) + (c.meridiem === 'pm' ? 12 : 0);
    return h * 60 + c.minutes;
  });
}

function timedWindow(fact) {
  const times = clockTimes(fact && fact.time);
  if (!times.length) return null;
  if (fact.type === 'deadline') {
    const at = times[times.length - 1];
    return { start: at, end: at, point: true };
  }
  const start = times[0];
  const end = times.length > 1 ? Math.max(times[1], start) : start + 60;
  return { start, end, point: false };
}

// A genuine clash: both items carry actual clock times, on the same day, and
// those times overlap. Pairs that merely share a date (theme weeks, untimed
// announcements, a deadline with no time) are not heads-ups.
function isTimedClash(conflict) {
  const a = conflict && (conflict.fact_a || (conflict.facts || [])[0]);
  const b = conflict && (conflict.fact_b || (conflict.facts || [])[1]);
  if (!a || !b || !a.date || a.date !== b.date) return false;
  const wa = timedWindow(a);
  const wb = timedWindow(b);
  if (!wa || !wb) return false;
  if (wa.point && wb.point) return false;
  if (wa.point || wb.point) {
    const p = wa.point ? wa : wb;
    const w = wa.point ? wb : wa;
    return p.start >= w.start && p.start <= w.end;
  }
  return wa.start < wb.end && wb.start < wa.end;
}

function clashLine(c) {
  const a = c.fact_a || c.facts[0];
  const b = c.fact_b || c.facts[1];
  const hubA = String(a.hub_name || a.hub || '').trim();
  const hubB = String(b.hub_name || b.hub || '').trim();
  const hubs = hubA && hubB && hubA !== hubB ? ` (${hubA} / ${hubB})` : '';
  return `${friendlyDay(a.date)}: ${String(a.title || '').trim()} overlaps ${String(b.title || '').trim()}${hubs}`;
}

// "Mismatched Pajama Day Monday" listed under "Mon, Nov 9:" loses its
// trailing "Monday", so the weekday appears once.
function stripTrailingWeekday(title, iso) {
  const d = isoDate(iso);
  const text = String(title || '').trim();
  if (!d) return text;
  const m = /^(.*?)[\s,–—-]*\(?\b([a-z]+)\.?\)?$/i.exec(text);
  if (!m || !m[1].trim()) return text;
  const word = m[2].toLowerCase();
  const day = WEEKDAYS.indexOf(word) !== -1 ? WEEKDAYS.indexOf(word) : WEEKDAY_ABBREVIATIONS[word];
  return day === d.getUTCDay() ? m[1].trim() : text;
}

function upcomingLine(f) {
  return `${friendlyDay(f.date)}: ${stripTrailingWeekday(f.title, f.date)}`;
}

// Subject + plain text + simple HTML for one family's evening check: what to
// do, genuine timing clashes, and what's coming up in the next week.
function eveningEmailContent(profile, result, links, today) {
  const kids = (profile.children || []).map((c) => c && c.name).filter(Boolean).join(' and ') || 'your family';
  const nudges = (result && result.nudges) || [];
  const conflicts = (result && result.conflicts) || [];
  // The subject counts the same pairs the Heads up section renders, so the
  // two always agree.
  const clashes = conflicts.filter(isTimedClash);
  const horizon = new Date(Date.parse(today + 'T00:00:00Z') + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nudged = new Set(nudges.map((n) => n.fact_id));
  const upcoming = ((result && result.relevant_facts) || [])
    .filter((f) => f.date && f.date >= today && f.date <= horizon && !nudged.has(f.id))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(0, 8);
  const subject = nudges.length
    ? `Tonight: ${nudges.length} ${nudges.length === 1 ? 'thing' : 'things'} to do`
    : clashes.length
      ? `Tonight: ${clashes.length} timing ${clashes.length === 1 ? 'conflict' : 'conflicts'}`
      : 'Tonight: a calm evening';
  const text = [
    `Here's tonight's evening check for ${kids}.`,
    '',
    nudges.length ? 'To do:' : 'Nothing to do tonight.',
    ...nudges.map((n) => '- ' + nudgeLine(n)),
    ...(clashes.length ? ['', 'Heads up:', ...clashes.map((c) => '- ' + clashLine(c))] : []),
    ...(upcoming.length ? ['', 'Coming up this week:', ...upcoming.map((f) => '- ' + upcomingLine(f))] : []),
    '',
    'Open ParentLoop: ' + links.app,
    '',
    'You get this because you turned on the evening email in ParentLoop. Stop these emails: ' + links.unsubscribe,
  ].join('\n');
  const list = (items, fn) => '<ul>' + items.map((x) => '<li>' + escapeHtml(fn(x)) + '</li>').join('') + '</ul>';
  const html = [
    `<p>Here's tonight's evening check for ${escapeHtml(kids)}.</p>`,
    nudges.length ? '<p><b>To do</b></p>' + list(nudges, nudgeLine) : '<p>Nothing to do tonight.</p>',
    clashes.length ? '<p><b>Heads up</b></p>' + list(clashes, clashLine) : '',
    upcoming.length ? '<p><b>Coming up this week</b></p>' + list(upcoming, upcomingLine) : '',
    `<p><a href="${escapeHtml(links.app)}">Open ParentLoop</a></p>`,
    `<p style="color:#68766d;font-size:12px">You get this because you turned on the evening email in ParentLoop. <a href="${escapeHtml(links.unsubscribe)}">Stop these emails</a>.</p>`,
  ].join('');
  return { subject, text, html };
}

module.exports = {
  eveningEmailContent, nudgeLine, isTimedClash, clashLine, stripTrailingWeekday, upcomingLine, friendlyDay, escapeHtml,
};
