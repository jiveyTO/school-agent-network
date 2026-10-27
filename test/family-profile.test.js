const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('demo family profile is the fictional Rivera family with soul and open actions', () => {
  const profile = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'family-profile.json'), 'utf8')
  );
  assert.equal(profile.parent.name, 'Alex Rivera');
  assert.equal(profile.child.name, 'Maya Rivera');
  assert.equal(profile.child.grade, 'Grade 3');
  assert.equal(profile.child.class, '3B');
  assert.ok(profile.soul.priorities.includes('never miss a food-order deadline'));
  assert.ok(
    profile.soul.priorities.some((p) => p.includes('one combined nudge'))
  );
  assert.equal(profile.soul.nudge_style, 'one short message in the evening');
  assert.deepEqual(profile.actions, {
    pizza_order: 'not_ordered',
    uniform_survey: 'not_done',
    picture_retake: 'scheduled',
    fall_festival: 'planning_to_attend',
  });
});

test('school facts contain the two open-action deadlines for 2026-11-06', () => {
  const facts = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'facts.json'), 'utf8')
  );
  const pizza = facts.find((f) => /pizza/i.test(f.title));
  const survey = facts.find((f) => /uniform survey/i.test(f.title));
  assert.ok(pizza, 'pizza fact exists');
  assert.ok(survey, 'uniform survey fact exists');
  assert.equal(pizza.action_required, true);
  assert.equal(survey.action_required, true);
  assert.equal(pizza.date, '2026-11-06');
  assert.equal(survey.date, '2026-11-06');
});
