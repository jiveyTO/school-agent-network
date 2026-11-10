// Evening email rendering (brief 077): one line per to-do with the action
// once, Heads up only for genuine timed clashes and short, the weekday once in
// Coming up — in both the text and the HTML part. Fictional fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { eveningEmailContent } = require('../evening-email');

const LINKS = { app: 'https://parentloop.example.test/', unsubscribe: 'https://parentloop.example.test/evening-email/off?t=abc' };
const PROFILE = { children: [{ name: 'Sky Fictional' }] };
const HUB = 'Elm Park Public — Elm Park';
const TODAY = '2026-11-09'; // a Monday

const fact = (id, title, date, extra) => Object.assign({
  id, type: 'event', title, date, time: '', hub_name: HUB, hub: HUB, action_required: false, action: '',
}, extra || {});
const pair = (a, b) => ({ date: a.date, fact_a: a, fact_b: b, facts: [a, b], cross_hub: a.hub_name !== b.hub_name,
  message: `${a.title} (${a.hub_name}) overlaps ${b.title} (${b.hub_name}) on Monday, Nov 9` });

// Shaped like a real Monday: one nudge whose action equals its title, a
// theme week and several untimed same-day items, no timed clashes.
function mondayCheck() {
  const week = fact('ep-week', 'Kindness Week November 9-13', '2026-11-09', { time: 'November 9-13' });
  const pj = fact('ep-pj', 'Crazy Sock Day Monday', '2026-11-09');
  const read = fact('ep-read', 'Reading buddies start', '2026-11-09');
  const hero = fact('ep-hero', 'Superhero Day Friday', '2026-11-13');
  const forms = fact('ep-forms', 'Return interview forms to homeroom teachers', '2026-11-10', {
    type: 'deadline', action_required: true, action: 'Return interview forms to homeroom teachers',
  });
  return {
    nudges: [{ fact_id: 'ep-forms', title: forms.title, action: forms.action, deadline: '2026-11-10' }],
    relevant_facts: [week, pj, read, hero, forms],
    conflicts: [pair(week, pj), pair(week, read), pair(pj, read)],
  };
}

test('a nudge whose action equals its title renders once, with a plain deadline', () => {
  const mail = eveningEmailContent(PROFILE, mondayCheck(), LINKS, TODAY);
  assert.ok(mail.text.includes('- Return interview forms to homeroom teachers (by Tue, Nov 10)\n'), mail.text);
  assert.equal(mail.text.split('Return interview forms to homeroom teachers').length, 2, 'printed exactly once');
  assert.ok(mail.html.includes('<li>Return interview forms to homeroom teachers (by Tue, Nov 10)</li>'), mail.html);
  assert.equal(mail.html.split('Return interview forms to homeroom teachers').length, 2);
});

test('a nudge with a distinct action keeps the title for context', () => {
  const mail = eveningEmailContent(PROFILE, { nudges: [{ title: 'Field trip forms due', action: 'Return the signed form', deadline: '2026-11-12' }] }, LINKS, TODAY);
  assert.ok(mail.text.includes('- Field trip forms due — Return the signed form (by Thu, Nov 12)'), mail.text);
});

test('date-only overlap pairs produce no Heads up section', () => {
  const mail = eveningEmailContent(PROFILE, mondayCheck(), LINKS, TODAY);
  assert.ok(!/Heads up/.test(mail.text), mail.text);
  assert.ok(!/Heads up/.test(mail.html));
  assert.ok(!/overlaps/.test(mail.text) && !/overlaps/.test(mail.html));
  assert.equal(mail.text.split(HUB).length, 1, 'no hub name repeated in the email');
  assert.equal(mail.subject, 'Tonight: 1 thing to do', 'subject logic unchanged');
});

test('a genuine timed clash renders one short line; hubs named once when they differ', () => {
  const swim = fact('rs-swim', 'Swim practice', '2026-11-11', { time: '4:00-5:00 PM', hub_name: 'Riverside Swim Club', hub: 'Riverside Swim Club' });
  const band = fact('ep-band', 'Band rehearsal', '2026-11-11', { time: '4:30 PM' });
  const lunch = fact('ep-lunch', 'Pizza lunch', '2026-11-11');
  const result = { nudges: [], relevant_facts: [swim, band, lunch], conflicts: [pair(swim, band), pair(swim, lunch)] };
  const mail = eveningEmailContent(PROFILE, result, LINKS, TODAY);
  const section = mail.text.split('Heads up:\n')[1].split('\n\n')[0];
  assert.deepEqual(section.split('\n'), [`- Wed, Nov 11: Swim practice overlaps Band rehearsal (Riverside Swim Club / ${HUB})`]);
  assert.ok(mail.html.includes('<p><b>Heads up</b></p><ul><li>Wed, Nov 11: Swim practice overlaps Band rehearsal (Riverside Swim Club / Elm Park Public — Elm Park)</li></ul>'), mail.html);
  assert.equal(mail.subject, 'Tonight: 1 timing conflict', 'subject counts only the clash Heads up shows');

  const sameHub = Object.assign({}, swim, { hub_name: HUB, hub: HUB });
  const one = eveningEmailContent(PROFILE, { nudges: [], relevant_facts: [sameHub, band], conflicts: [pair(sameHub, band)] }, LINKS, TODAY);
  assert.ok(one.text.includes('Heads up:\n- Wed, Nov 11: Swim practice overlaps Band rehearsal\n'), one.text);
  assert.ok(!one.text.includes(HUB), 'one hub: no hub name at all');
});

test('the subject counts exactly the pairs the Heads up section renders', () => {
  // No nudges and only date-only pairs: no Heads up, so no conflicts in the subject.
  const quiet = mondayCheck();
  quiet.nudges = [];
  const calm = eveningEmailContent(PROFILE, quiet, LINKS, TODAY);
  assert.ok(!/Heads up/.test(calm.text) && !/Heads up/.test(calm.html), calm.text);
  assert.equal(calm.subject, 'Tonight: a calm evening');

  // Two genuine clashes among date-only pairs: the subject says 2, the section lists 2.
  const swim = fact('rs-swim', 'Swim practice', '2026-11-11', { time: '4:00-5:00 PM', hub_name: 'Riverside Swim Club', hub: 'Riverside Swim Club' });
  const band = fact('ep-band', 'Band rehearsal', '2026-11-11', { time: '4:30 PM' });
  const choir = fact('ep-choir', 'Choir', '2026-11-11', { time: '4:15-4:45 PM' });
  const lunch = fact('ep-lunch', 'Pizza lunch', '2026-11-11');
  const conflicts = [pair(swim, band), pair(swim, choir), pair(swim, lunch), pair(band, lunch)];
  const busy = eveningEmailContent(PROFILE, { nudges: [], relevant_facts: [swim, band, choir, lunch], conflicts }, LINKS, TODAY);
  const lines = busy.text.split('Heads up:\n')[1].split('\n\n')[0].split('\n');
  assert.equal(lines.length, 2, busy.text);
  assert.equal(busy.subject, 'Tonight: 2 timing conflicts');
  assert.equal((busy.html.match(/<li>[^<]* overlaps /g) || []).length, 2, busy.html);
});

test('the weekday is never duplicated in Coming up lines', () => {
  const mail = eveningEmailContent(PROFILE, mondayCheck(), LINKS, TODAY);
  const section = mail.text.split('Coming up this week:\n')[1].split('\n\n')[0].split('\n');
  assert.deepEqual(section, [
    '- Mon, Nov 9: Kindness Week November 9-13',
    '- Mon, Nov 9: Crazy Sock Day',
    '- Mon, Nov 9: Reading buddies start',
    '- Fri, Nov 13: Superhero Day',
  ]);
  for (const line of section) {
    const day = line.slice(2, 5);
    const words = { Mon: /monday/i, Fri: /friday/i }[day];
    if (words) assert.ok(!words.test(line), 'weekday once: ' + line);
  }
  assert.ok(mail.html.includes('<li>Mon, Nov 9: Crazy Sock Day</li>') && mail.html.includes('<li>Fri, Nov 13: Superhero Day</li>'), mail.html);
  // A trailing weekday that is not the item's own day is information, not a duplicate.
  const odd = eveningEmailContent(PROFILE, { relevant_facts: [fact('x', 'Forms go home Friday', '2026-11-10')] }, LINKS, TODAY);
  assert.ok(odd.text.includes('- Tue, Nov 10: Forms go home Friday'));
});

test('section order, app link and unsubscribe footer are unchanged', () => {
  const mail = eveningEmailContent(PROFILE, mondayCheck(), LINKS, TODAY);
  assert.ok(mail.text.indexOf('To do:') < mail.text.indexOf('Coming up this week:'));
  assert.ok(mail.text.includes('Open ParentLoop: ' + LINKS.app));
  assert.ok(mail.text.endsWith('Stop these emails: ' + LINKS.unsubscribe));
  assert.ok(mail.html.includes(`<a href="${LINKS.app}">Open ParentLoop</a>`));
  assert.ok(mail.html.includes('Stop these emails</a>'));
});
