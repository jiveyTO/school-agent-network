const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('page has no Gmail card or standalone newsletter paste box', () => {
  for (const token of [
    'Connect Gmail',
    'gmailConnectBtn',
    'gmailScanBtn',
    'gmailHubSelect',
    'gmailFindings',
    'pasteNewsletter',
    'pasteBtn',
    'Sort this newsletter',
  ]) {
    assert.ok(!PAGE.includes(token), `${token} must not appear on the page`);
  }
});

test('real non-demo profiles get an empty school demo strip', () => {
  for (const token of ['id="newsSummary"', 'applySchoolAudience', 'viewer.is_demo']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('No school newsletter for your family yet — your hub feeds will appear here.'));
  assert.ok(PAGE.includes('School updates appear under the demo family.'));
});

test('onboarding is one step: family fields only, preferences sent silently', () => {
  assert.ok(PAGE.includes('<p><b>About your family</b></p>'));
  for (const token of [
    'What matters to you',
    'ob-priority',
    'name="obNudge"',
    '1. About your family',
  ]) {
    assert.ok(!PAGE.includes(token), `${token} must not appear on the page`);
  }
  assert.ok(PAGE.includes("'never miss a food-order deadline', 'keep evenings calm — one combined nudge'"));
  assert.ok(PAGE.includes("nudge_style: 'one short message in the evening'"));
});

test('page keeps the ParentLoop footer and hub flow entry points', () => {
  assert.ok(PAGE.includes('ParentLoop — you’re always in the loop.'));
  assert.ok(PAGE.includes('id="hubs-h"'));
  assert.ok(PAGE.includes('id="joinView"'));
  assert.ok(PAGE.includes('id="createProfileBtn"'));
});

test('long model waits show a thinking-dots indicator, never a progress bar', () => {
  for (const token of ['class="progress"', 'progress-slide', 'id="materialProgress"', 'id="parentProgress"', 'progressEl']) {
    assert.ok(!PAGE.includes(token), `${token} must be gone — no bar element remains`);
  }
  for (const token of ['thinking-dots', 'id="materialDots"', 'id="parentDots"', 'thinking-pulse']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  for (const id of ['materialDots', 'parentDots']) {
    const at = PAGE.indexOf('id="' + id + '"');
    const dots = PAGE.slice(at, at + 200);
    assert.equal((dots.match(/<span><\/span>/g) || []).length, 3, `${id} holds exactly three dots`);
  }
  assert.ok(PAGE.includes('.thinking-dots > span:nth-child(2)') && PAGE.includes('.thinking-dots > span:nth-child(3)'),
    'dots cycle one at a time via CSS-only staggered delays');
  assert.ok(PAGE.includes('prefers-reduced-motion'), 'dot motion respects reduced-motion');
  assert.ok(PAGE.includes('startStagedStatus') && PAGE.includes('stopStagedStatus'));
  for (const stage of ['Reading your material…', 'Sorting out what matters…', 'Saving to your hub…',
    'Pulling together tonight’s summary…', 'Checking every hub for what’s still open…', 'Writing one calm summary…']) {
    assert.ok(PAGE.includes(stage), `staged text present: ${stage}`);
  }
  assert.ok(!PAGE.includes('% complete') && !PAGE.includes('percent'));
  assert.ok(PAGE.includes("inputs.forEach(function (el) { if (el) el.disabled = true; })"), 'material inputs disable during processing');
  assert.ok(PAGE.includes("inputs.forEach(function (el) { if (el) el.disabled = false; })"), 'material inputs re-enable after');
  assert.ok(PAGE.includes('Done — one calm summary for tonight.'), 'evening completion state unchanged');
  assert.ok(PAGE.includes('Added — '), 'add-material completion state unchanged');
});

test('add-material wait carries a reassurance line and survives navigation', () => {
  assert.ok(PAGE.includes('id="materialWaitNote"'), 'reassurance line present on the add-material flow');
  assert.ok(PAGE.includes('This can take up to a minute — you do not need to stay here. It will be in this hub when you come back.'));
  assert.ok(PAGE.includes("waitNoteEl.hidden = false") && PAGE.includes("waitNoteEl.hidden = true"),
    'reassurance line shows during extraction and hides after');
  assert.ok(!PAGE.includes('AbortController') && !PAGE.includes('signal'), 'in-flight request is never cancelled by view changes');
  assert.ok(PAGE.includes('if (currentHubId === hubId) await loadHubDetail(hubId)'),
    'background finish re-renders detail only when still on that hub; returning re-fetches anyway');
  assert.ok(PAGE.includes('dotsEl.hidden = false') && PAGE.includes('dotsEl.hidden = true'),
    'dots show during extraction and hide after');
});

test('hub detail renders one source card per material with flat facts inside', () => {
  for (const token of ['renderHubSources', 'renderHubSourcesSection', 'factBullet', 'groupBulletList', 'paintGroupsToggle', 'factMatters',
    'source-card', 'group-subhead', "'Expand all'", "'Collapse all'"]) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes('hubFactCard'), 'no per-fact cards inside groups');
  for (const token of ['card group-card', 'card group-summary', 'div.group-card', 'details.group-card', 'data-groupname']) {
    assert.ok(!PAGE.includes(token), `${token} must be gone — no nested card inside the material card`);
  }
  assert.ok(PAGE.includes('Added ') && PAGE.includes('notes'), 'card header shows when it was added and its note count');
  assert.ok(PAGE.includes('Nothing shared from this one yet.'));
});

test('single-group material renders facts flat: no nested card, no repeated title', () => {
  const html = renderMaterialsHtml(
    [{ id: 'm1', title: 'November Newsletter', created_at: '2026-11-01' }],
    [
      { material_id: 'm1', group_label: 'Halloween Costumes', title: 'Costume parade', detail: 'Parade at 9am', date: '2026-10-31', applies_to: 'all', action_required: false, action: '', source_text: '' },
      { material_id: 'm1', group_label: 'Halloween Costumes', title: 'No masks', detail: 'Leave masks at home', date: '', applies_to: 'all', action_required: false, action: '', source_text: '' },
    ]
  );
  assert.ok(html.includes('November Newsletter'), 'material title stays on the card');
  assert.ok(html.includes('Parade at 9am') && html.includes('Leave masks at home'), 'same facts render');
  assert.ok(!html.includes('Halloween Costumes'), 'single group title is not repeated');
  for (const token of ['group-subhead', 'group-card', 'group-summary', 'data-groupname']) {
    assert.ok(!html.includes(token), `${token} must not appear for a single group`);
  }
  assert.equal(html.split('<details').length - 1, 1, 'exactly one material card');
  assert.ok(html.includes('note-list'), 'facts render as the plain bullet list');
});

test('multi-group material separates groups with plain subheadings, never nested cards', () => {
  const html = renderMaterialsHtml(
    [{ id: 'm2', title: 'November Newsletter', created_at: '2026-11-01' }],
    [
      { material_id: 'm2', group_label: 'Pizza Lunch', title: 'Pizza orders', detail: 'Order by Friday', date: '2026-11-06', applies_to: 'all', action_required: true, action: 'Order pizza', source_text: '' },
      { material_id: 'm2', group_label: 'Lost and Found', title: 'Bin reminder', detail: 'Bins sit by the office', group_summary: 'Bins sit by the office.', date: '', applies_to: 'all', action_required: false, action: '', source_text: '' },
    ]
  );
  assert.ok(html.includes('Order by Friday') && html.includes('Bins sit by the office.'), 'same facts render');
  assert.equal(html.split('group-subhead').length - 1, 2, 'one plain subheading per group');
  assert.equal(html.split('Pizza Lunch').length - 1, 1, 'actionable group label appears once');
  assert.equal(html.split('Lost and Found').length - 1, 1, 'summary group label appears once');
  for (const token of ['card group-card', 'card group-summary', 'div.group-card', 'details.group-card', 'data-groupname']) {
    assert.ok(!html.includes(token), `${token} must be gone — subheadings carry no border or box`);
  }
  assert.ok(html.includes('group-summary'), 'informational group keeps its summary block');
  assert.ok(html.includes('View full text'), 'summary keeps the full-text path');
});

function renderMaterialsHtml(materials, facts) {
  const vm = require('node:vm');
  const els = {};
  function fakeEl() {
    return {
      innerHTML: '', hidden: true, textContent: '',
      children: [],
      querySelectorAll() { return []; },
      querySelector() { return null; },
    };
  }
  const sandbox = {
    document: { getElementById(id) { return els[id] || (els[id] = fakeEl()); } },
    __facts: facts,
    __materials: materials,
  };
  const src = PAGE.slice(PAGE.indexOf('function esc(s)'), PAGE.indexOf('function friendlyTime('));
  vm.runInNewContext(src + ';renderHubSources(__facts, __materials);', sandbox);
  return els.hubFacts.innerHTML;
}

test('informational-only groups collapse to a one-line summary with a read-all toggle', () => {
  for (const token of ['groupSummaryText', 'group-summary', 'data-read-group', 'group-full', 'Read all ', 'Show less']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes("group_summary"), 'summary comes from the extracted fact field');
});

test('groups render as one bullet card, five max, sources one click away', () => {
  for (const token of ['note-list', 'data-note-more', 'data-note-rest', 'Show all ', 'Show sources', 'Hide sources',
    'data-quote-toggle', 'groupQuotesBlock']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('MAX_NOTES = 5'), 'no more than five bullets before the overflow toggle');
  const quotesFn = PAGE.slice(PAGE.indexOf('function groupQuotesBlock'), PAGE.indexOf('function groupQuotesBlock') + 900);
  assert.ok(!quotesFn.includes('From the newsletter: <span'), 'no repeated per-quote prefix');
  assert.ok(quotesFn.includes('From the newsletter:</p><ul'), 'single header over the quote list');
});

test('summary rows link the full source without becoming actions', () => {
  for (const token of ['View full text', 'data-full-text', 'data-material', 'fullTextCache', 'material-fulltext',
    'Source link', '/materials/', '/text']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('group-actions'));
});

test('hub page has one materials list with one empty state', () => {
  assert.ok(PAGE.includes('What is in this hub'), 'single list heading present');
  for (const token of ['Shared notes', 'Newsletters and notices added', 'id="hubMaterials"', 'id="familyStrip"',
    'For your family', 'Nothing shared yet.', 'data-expand-group', 'renderFamilyStrip', 'stripChips']) {
    assert.ok(!PAGE.includes(token), `${token} must be gone after the merge`);
  }
  const hubMarkup = PAGE.slice(PAGE.indexOf('id="viewHub"'), PAGE.indexOf('id="viewEvening"'));
  assert.equal(hubMarkup.split('Nothing added yet.').length - 1, 1, 'exactly one materials empty state in the hub view');
});

test('hub page leads with a Sources section and a calendar placeholder', () => {
  for (const token of ['Sources for this hub', 'id="hubSourcesCard"', 'id="hubSources"', 'id="hubWebsiteAdd"',
    'id="hubWebsiteAddLabel"', 'Add the school website', 'id="hubWebsiteAddInput"', 'id="hubWebsiteSaveBtn"',
    'Save website', '/website', 'Calendar link — coming soon']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('School website'), 'website row labels the school site');
  const hubMarkup = PAGE.slice(PAGE.indexOf('id="viewHub"'), PAGE.indexOf('id="viewEvening"'));
  assert.ok(hubMarkup.indexOf('Sources for this hub') !== -1, 'Sources lives in the hub view');
  assert.ok(hubMarkup.indexOf('Sources for this hub') < hubMarkup.indexOf('What is in this hub'),
    'Sources sits above the single list');
});

test('action ranks still qualify only deadlines and real actions', () => {
  for (const token of ['factActionKind', "Due ' + esc(humanDate(f.date))"]) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes('Sign-up needed'), 'no generic strip labels');
  assert.ok(PAGE.includes('order') && PAGE.includes('rsvp') && PAGE.includes('payment') && PAGE.includes('signup'));
  assert.ok(!PAGE.includes('\\$'), 'a bare dollar amount alone is not a payment action');
});

test('website autofill prefills the create form without touching manual entries', () => {
  for (const token of ['id="websiteFieldWrap"', 'id="websiteLabel"', 'id="hubWebsite"', 'id="websiteFillBtn"',
    'id="parseLinkStatus"', 'Fill it in for me', 'Filled from ', 'give it a quick check']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('School website') && PAGE.includes('Team or league website'));
  assert.ok(PAGE.includes('/api/hubs/parse-link'));
});

test('evening check leads with actionable notes and folds the rest into hub links', () => {
  for (const token of ['eveningHubCard', 'eveningActionRank', 'data-goto-hub', 'catch up in My hubs', 'background note']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('From your hubs'));
  assert.ok(!PAGE.includes(".join(' · ')"), 'no dot-joined title blob');
});

test('invite link exposes gmail alongside email, whatsapp, and copy', () => {
  for (const token of ['id="inviteShare"', 'id="inviteEmail"', 'id="inviteGmail"', 'id="inviteWhatsApp"', 'id="inviteCopyBtn"',
    'id="inviteCopyStatus"', 'shareInviteMessage', 'share-row', 'mailto:', 'https://mail.google.com/mail/?view=cm', 'https://wa.me/?text=', 'Copy link']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('Join our ParentLoop hub'));
  assert.ok(PAGE.includes('Join here:'));
});

test('hub admins get a two-click delete with confirm copy', () => {
  for (const token of ['id="hubDanger"', 'id="deleteHubBtn"', 'id="deleteHubConfirm"', 'id="deleteHubYesBtn"',
    'id="deleteHubNoBtn"', 'id="deleteHubStatus"', 'id="deleteHubName"', 'Delete this hub', 'Yes, delete it', 'Keep it']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes("method: 'DELETE'"));
  assert.ok(PAGE.includes('can’t be undone'));
});

test('create form leads with kind and remembers school location', () => {
  const kindAt = PAGE.indexOf('What kind of hub is it?');
  const nameAt = PAGE.indexOf('id="singleNameWrap"');
  const schoolAt = PAGE.indexOf('id="schoolNameWrap"');
  assert.ok(kindAt !== -1 && nameAt !== -1 && schoolAt !== -1);
  assert.ok(kindAt < nameAt && kindAt < schoolAt, 'kind select drives the fields below it');
  assert.ok(kindAt < PAGE.indexOf('id="websiteFieldWrap"'), 'kind select sits above the website field');
  for (const token of ['parentloop.schoolLocation', 'prefillSchoolLocation', 'rememberSchoolLocation', 'readSavedSchoolLocation', 'localStorage']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
});

test('team hubs have sport and level fields with suggestions', () => {
  for (const token of ['id="teamFieldsWrap"', 'id="hubSport"', 'id="hubLevel"', 'id="hubLevelOptions"', 'teamLine']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  for (const sport of ['Hockey', 'Soccer', 'Baseball', 'Softball', 'Basketball', 'Volleyball', 'Lacrosse', 'Swimming', 'Other']) {
    assert.ok(PAGE.includes('<option>' + sport + '</option>'), `sport option present: ${sport}`);
  }
  for (const level of ['House League', 'Select', 'Rep', 'A', 'AA', 'AAA']) {
    assert.ok(PAGE.includes('value="' + level + '"'), `level suggestion present: ${level}`);
  }
});

test('member hubs use card picker plus toggle; no dropdown', () => {
  assert.ok(!PAGE.includes('id="hubSelect"'), 'hub switcher dropdown must be gone');
  assert.ok(!PAGE.includes('Look inside a hub'), 'switcher label must be gone');
  assert.ok(PAGE.includes('id="startHubToggle"'));
  assert.ok(PAGE.includes('+ Start a hub'));
  assert.ok(PAGE.includes('hubs-head'));
  assert.ok(PAGE.includes('hub-card'));
  assert.ok(PAGE.includes('data-hub-id'));
  assert.ok(PAGE.includes('aria-current'));
  assert.ok(PAGE.includes('markSelectedHub'));
  assert.ok(PAGE.includes('startHubOpen'));
  assert.ok(PAGE.includes('card.hidden = !startHubOpen'));
  assert.ok(PAGE.includes('startHubOpen = false;'), 'successful create collapses the form');
});

test('add material is one box: paste plus optional PDF, no title or audience fields', () => {
  for (const token of ['id="materialTitle"', 'id="materialAudience"', 'Who is this for?',
    'Let ParentLoop decide', 'My child’s grade', 'My child’s class', 'friendlyScope']) {
    assert.ok(!PAGE.includes(token), `${token} must be gone from the add form`);
  }
  assert.ok(!PAGE.includes('audience:'), 'the hub page no longer sends an audience scope');
  for (const token of ['id="materialText"', 'id="materialPdf"', 'id="addMaterialBtn"', 'Add it']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  const pdfAt = PAGE.indexOf("kind: 'pdf'");
  const pasteAt = PAGE.indexOf("kind: 'paste'");
  assert.ok(pdfAt !== -1 && pasteAt !== -1, 'both paste and PDF upload paths remain');
});

test('announced facts default to 3 with an expand/collapse toggle, under the hub detail', () => {
  const hubDetailAt = PAGE.indexOf('id="hub-view-h"');
  const factsAt = PAGE.indexOf('id="facts-h"');
  const logAt = PAGE.indexOf('id="log-h"');
  assert.ok(hubDetailAt !== -1 && factsAt !== -1 && logAt !== -1);
  assert.ok(hubDetailAt < factsAt && factsAt < logAt, 'facts section must sit after hub detail and before Activity');
  assert.ok(PAGE.includes('id="factsToggle"'));
  assert.ok(PAGE.includes('FACTS_PREVIEW_COUNT = 3'));
  assert.ok(PAGE.includes('allFacts.slice(0, FACTS_PREVIEW_COUNT)'));
  assert.ok(PAGE.includes("'Show less'") && PAGE.includes("'Show all '"));
  assert.ok(PAGE.includes('id="factCount"'));
});

test('start-a-hub guides school naming and handles duplicate school hubs', () => {
  assert.ok(PAGE.includes('id="hubKindHelp"'));
  assert.ok(PAGE.includes("Name it for the whole school — parents from every grade join this one hub, and each family's agent shows only what matches their child."));
  assert.ok(PAGE.includes('id="singleNameWrap"') && PAGE.includes('id="schoolNameWrap"'));
  assert.ok(PAGE.includes('id="hubSchoolName"') && PAGE.includes('id="hubSchoolCity"'));
  assert.ok(PAGE.includes('id="hubSchoolProvince"') && PAGE.includes('id="hubSchoolCountry"'));
  assert.ok(PAGE.includes('e.g. St. Nicholas') && PAGE.includes('e.g. Willow Creek'));
  assert.ok(PAGE.includes('e.g. Ontario') && PAGE.includes('e.g. Canada'));
  assert.ok(PAGE.includes('fullHubLocation'));
  assert.ok(PAGE.includes('updateHubKindHelp'));
  for (const token of ['id="startHubFields"', 'id="hubConflictCard"', 'id="hubConflictText"',
    'id="hubJoinRequestBtn"', 'id="hubForceCreateBtn"', 'id="hubJoinRequestStatus"']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes('already has a hub — founded by'));
  assert.ok(PAGE.includes('This looks like '));
  assert.ok(PAGE.includes('Different school — create mine anyway'));
  assert.ok(PAGE.includes('Request sent — the hub’s admin will approve it.'));
  assert.ok(PAGE.includes("match_type === 'similar'") && PAGE.includes('existing_hub'));
});

test('my hubs branches on membership: zero-hub welcome vs member list; detail lives on the hub page', () => {
  for (const token of ['id="welcomeHubs"', 'id="welcomeHubFormSlot"', 'id="startHubForm"',
    'id="startHubCard"', 'id="startHubCardSlot"',
    'id="viewHub"', 'id="hubBackBtn"', 'applyHubBranch']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes("getElementById('hubViewSection').hidden"), 'list branching must not toggle hub detail');
  const listMarkup = PAGE.slice(PAGE.indexOf('id="viewHubs"'), PAGE.indexOf('id="viewHub"'));
  for (const token of ['id="hubs-h"', 'id="hubsList"', 'id="startHubCard"', '+ Start a hub']) {
    assert.ok(listMarkup.includes(token), `My hubs list must contain ${token}`);
  }
  for (const token of ['id="hub-view-h"', 'id="hubTitle"', 'What is in this hub', 'Sources for this hub', 'id="hubFacts"',
    'id="placementCard"', 'id="addMaterialBtn"', 'id="inviteBtn"',
    'id="hubRequests"', 'id="hubDanger"']) {
    assert.ok(!listMarkup.includes(token), `My hubs list must not contain hub detail ${token}`);
  }
  assert.ok(PAGE.includes('Start your first hub'));
  assert.ok(PAGE.includes('A hub is your class’s or team’s shared space for newsletters and notices. One parent starts it, everyone else joins by invite.'));
  assert.ok(PAGE.includes('Got an invite link from another parent? Just open it — it brings you straight into their hub.'));
  assert.ok(PAGE.includes('Just you for now? That works too — start the hub, add your newsletters, and invite other parents whenever you’re ready.'));
  assert.ok(
    PAGE.indexOf('everyone else joins by invite.') <
    PAGE.indexOf('Just you for now?') <
    PAGE.indexOf('id="welcomeHubFormSlot"')
  );
  assert.ok(PAGE.includes("slot.appendChild(form)") || PAGE.includes('welcomeHubFormSlot'));
  assert.ok(PAGE.includes("cardSlot.appendChild(form)"));
  assert.ok(PAGE.includes("list.after(card)"));
  assert.ok(PAGE.includes("await loadHubs(data.hub.id)"), 'creating the first hub must re-render without reload');
});

test('zero-hub start-a-hub is one card: title, explainers, form, invite line, no nested card', () => {
  const welcome = PAGE.slice(PAGE.indexOf('<div class="card" id="welcomeHubs"'), PAGE.indexOf('id="hubsList"'));
  assert.equal((welcome.match(/class="card"/g) || []).length, 1,
    'the zero-hub composition must render exactly one card container');
  assert.ok(!welcome.includes('<b>Start a hub</b>'),
    'the merged card carries one heading — the form’s own "Start a hub" heading is gone here');
  assert.ok(PAGE.includes('<div id="welcomeHubFormSlot"><div id="startHubForm">'),
    'the form is a plain block inside the welcome card, not a card of its own');
  for (const token of ['Start your first hub', 'id="hubKind"', 'id="hubWebsite"',
    'id="websiteFillBtn"', 'id="hubName"', 'id="hubSchoolName"', 'id="hubSchoolCity"',
    'id="hubSchoolProvince"', 'id="hubSchoolCountry"', 'id="hubSport"', 'id="hubLevel"',
    'id="hubKindHelp"', 'id="createHubBtn"', 'Start this hub', 'id="hubConflictCard"',
    'id="hubCreateStatus"']) {
    assert.ok(welcome.includes(token), `merged card must contain ${token}`);
  }
  assert.ok(
    welcome.indexOf('Start your first hub') <
    welcome.indexOf('everyone else joins by invite.') <
    welcome.indexOf('Just you for now?') <
    welcome.indexOf('welcomeHubFormSlot') <
    welcome.indexOf('Got an invite link'),
    'merged card keeps today’s order: title, explainers, form, invite line'
  );
});

test('has-hubs start-a-hub keeps its own card and expander; form is never nested', () => {
  const shell = PAGE.slice(PAGE.indexOf('id="startHubCard"'), PAGE.indexOf('id="viewHub"'));
  assert.ok(shell.includes('<b>Start a hub</b>'), 'the has-hubs card keeps its heading');
  assert.ok(shell.includes('id="startHubCardSlot"'), 'the has-hubs card hosts the form slot');
  for (const token of ['id="hubKind"', 'id="createHubBtn"']) {
    assert.ok(!shell.includes(token), `the form must not be duplicated in the shell — ${token} lives in the single movable form`);
  }
  const fn = PAGE.slice(PAGE.indexOf('function applyHubBranch'), PAGE.indexOf('async function loadHubDetail'));
  const elseAt = fn.indexOf('} else {');
  assert.ok(elseAt !== -1 && fn.includes('cardSlot.appendChild(form)') && fn.includes('list.after(card)'),
    'has-hubs branch moves the plain form into its own card after the list');
  assert.ok(fn.indexOf('cardSlot.appendChild(form)') < elseAt, 'form-to-shell move happens in the has-hubs branch');
  assert.ok(fn.indexOf('slot.appendChild(form)') > elseAt, 'form-to-welcome move happens in the zero-hub branch');
  assert.ok(fn.includes('card.hidden = true'), 'zero-hub branch keeps the spare shell hidden');
  assert.ok(PAGE.includes("getElementById('startHubCard').hidden = !startHubOpen"),
    'the + Start a hub toggle still expands the shell card');
});

test('hub cards open a dedicated hub view; the back control returns to the list', () => {
  for (const token of ['id="viewHub"', 'id="hubBackBtn"', 'Back to My hubs', 'openHub', "showView('hub')"]) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  const hubMarkup = PAGE.slice(PAGE.indexOf('id="viewHub"'), PAGE.indexOf('id="viewEvening"'));
  for (const token of ['id="hub-view-h"', 'id="hubTitle"', 'Sources for this hub', 'id="hubSources"',
    'What is in this hub', 'id="hubFacts"', 'Add it', 'id="placementCard"', 'Place your children in this hub',
    'id="inviteBtn"', 'id="hubRequests"', 'id="hubDanger"', 'id="facts-h"', 'id="log-h"']) {
    assert.ok(hubMarkup.includes(token), `hub view must render ${token}`);
  }
  assert.ok(hubMarkup.indexOf('id="hubBackBtn"') < hubMarkup.indexOf('id="hub-view-h"'),
    'back control sits above the hub detail');
  assert.ok(hubMarkup.indexOf('id="hub-view-h"') < hubMarkup.indexOf('id="facts-h"') &&
    hubMarkup.indexOf('id="facts-h"') < hubMarkup.indexOf('id="log-h"'),
    'hub view keeps detail, facts, and activity in order');
  const openFn = PAGE.slice(PAGE.indexOf('async function openHub'), PAGE.indexOf('async function openHub') + 400);
  assert.ok(openFn.includes("showView('hub')") && openFn.includes('loadHubDetail'), 'opening a hub shows the hub view and loads its detail');
  const backFn = PAGE.slice(PAGE.indexOf("getElementById('hubBackBtn')"), PAGE.indexOf("getElementById('hubBackBtn')") + 300);
  assert.ok(backFn.includes("showView('hubs')"), 'back control returns to the My hubs list');
  assert.ok(PAGE.includes('openHub(b.getAttribute('), 'tapping a hub card opens the hub view');
  assert.ok(PAGE.includes('openHub(data.hub.id)'), 'creating a hub lands on the new hub page');
  assert.ok(PAGE.includes('await openHub(accepted.hub && accepted.hub.id)'), 'accepting an invite lands on the hub page');
  assert.ok(PAGE.includes('renderPlacementCard'), 'placement prompt still fires from the hub detail load');
});

test('view sections share one vertical-rhythm mechanism', () => {
  assert.ok(PAGE.includes('main section + section { margin-top: 28px; }'));
  assert.ok(PAGE.includes('margin: 0 0 10px;'), 'heading-to-content gap stays ~10px');
  assert.ok(PAGE.includes('.hint { font-size: 14.5px; color: var(--muted); margin: 6px 2px 0; }'));
});

test('page uses three tabbed views and a name-only family card', () => {
  for (const token of ['id="tabBar"', 'id="tabHubs"', 'id="tabEvening"', 'id="tabFamily"',
    'id="viewHubs"', 'id="viewEvening"', 'id="viewFamily"']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.match(/>My hubs<\/button>/) && PAGE.match(/>Evening check<\/button>/) && PAGE.match(/>My family<\/button>/));
  for (const token of ['What matters most', 'data-source-save']) {
    assert.ok(!PAGE.includes(token), `${token} must not appear on the page`);
  }
  assert.ok(PAGE.includes('grid-template-columns: 3fr 2fr'), 'desktop hub grid must be ~60/40');
  assert.ok(PAGE.includes('@media (min-width: 900px)') && PAGE.includes('max-width: 960px'));
});

test('onboarding is names-only: one or more children, no grade/class/school, blank for new families', () => {
  for (const token of ['id="obChildrenList"', 'id="obAddChildBtn"', 'ob-child-row', 'obRemoveChild',
    'clearObForm', 'fillObForm', 'openOnboarding', '+ Add another child', 'names only. Grades come later']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  for (const token of ['id="obChildName"', 'id="obGrade"', 'id="obClassName"', 'id="obSchoolName"',
    'fillProfileForm', 'profile.child.grade']) {
    assert.ok(!PAGE.includes(token), `${token} must not appear on the page`);
  }
  assert.ok(PAGE.includes("openOnboarding('new')"), 'new-family paths open blank');
  assert.ok(PAGE.includes("openOnboarding('edit')"), 'editing the existing family may pre-fill');
  assert.ok(PAGE.includes("document.getElementById('obParentName').value = ''"), 'blank means blank');
});

test('placement grade is a select with the closed vocabulary, not a typed field', () => {
  assert.ok(PAGE.includes('<select class="placeGrade">'), 'hub placement card uses a grade select');
  assert.ok(PAGE.includes("var GRADE_OPTIONS = ['Kindergarten', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4',"),
    'grade options start at Kindergarten');
  assert.ok(PAGE.includes("'Grade 10', 'Grade 11', 'Grade 12'"), 'grade options run through Grade 12');
  assert.ok(PAGE.includes('\'<option value="\' + g + \'"\''), 'rows build one option per closed-vocabulary grade');
  assert.ok(PAGE.includes('canonicalGradeLabel'), 'legacy spellings render as their canonical option');
  assert.ok(PAGE.includes('Select grade…'), 'empty placement shows the placeholder, not a guess');
  assert.ok(!PAGE.includes('<input type="text" class="placeGrade"'), 'no typed grade field may remain');
  assert.ok(!PAGE.includes('placeholder="e.g. Grade 3"'), 'no free-text grade placeholder may remain');
  assert.ok(PAGE.includes('<input type="text" class="placeClass"'), 'class stays a free-text optional field');
  const cardFn = PAGE.slice(PAGE.indexOf('function renderPlacementCard'), PAGE.indexOf('function renderPlacementCard') + 600);
  assert.ok(cardFn.includes('placementRowHtml'), 'hub placement card renders through the shared row');
  const familyFn = PAGE.slice(PAGE.indexOf('async function loadFamilyPlacements'), PAGE.indexOf('async function loadFamilyPlacements') + 2600);
  assert.ok(familyFn.includes('placementRowHtml'), 'School placements section renders through the same shared row');
});

test('grade and class live in hub placements, editable from the hub view or My family', () => {
  for (const token of ['id="placementCard"', 'id="placementFields"', 'id="placementSaveBtn"',
    'id="placementSkipBtn"', 'id="placementStatus"', 'Place your children in this hub', 'Skip for now',
    'needs_placement', 'id="placementsList"', 'id="place-h"', 'School placements',
    'id="editFamilyBtn"', 'Edit family names', '/placements', 'team hub, no placement needed']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
});

test('demo viewers get a text-only demo bar; the Start path lives in the header', () => {
  for (const token of ['id="demoBar"', 'demoViewing', 'paintDemoBar',
    'You’re exploring as the demo family.']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes('id="demoBarBtn"'), 'banner button is gone — no duplicate Start path in the banner');
  const barOpen = PAGE.indexOf('id="demoBar"');
  const barClose = PAGE.indexOf('</div>', barOpen);
  const barMarkup = PAGE.slice(barOpen, barClose);
  assert.ok(!barMarkup.includes('<button'), 'demo bar contains no button, only the notice sentence');
  const barAt = PAGE.indexOf('id="demoBar"');
  const tabAt = PAGE.indexOf('id="tabBar"');
  assert.ok(barAt !== -1 && barAt < tabAt, 'demo bar sits under the header, above the tab row');
  assert.ok(PAGE.includes('demoBar.hidden = !(demoViewing && !tabBar.hidden)'), 'bar shows for demo viewers in main views only');
  assert.ok(!PAGE.includes('>Start over</button>'), 'quiet control renamed to match');
});

test('signed-out header pairs Start with Sign in on one row, Start first', () => {
  for (const token of ['id="authArea"', 'id="startFamilyBtn"', 'id="signInBtn"',
    'Start with your own family', 'Sign in with Google']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  const areaOpen = PAGE.indexOf('id="authArea"');
  const areaClose = PAGE.indexOf('</div>', areaOpen);
  const areaMarkup = PAGE.slice(areaOpen, areaClose);
  const startAt = areaMarkup.indexOf('id="startFamilyBtn"');
  const signInAt = areaMarkup.indexOf('id="signInBtn"');
  assert.ok(startAt !== -1 && signInAt !== -1, 'both actions live in the one header row container');
  assert.ok(startAt < signInAt, 'Start with your own family comes first, Sign in with Google second');
  assert.ok(areaMarkup.includes('>Start with your own family</button>'), 'Start label unchanged, character for character');
  assert.ok(areaMarkup.includes('>Sign in with Google</a>'), 'Sign in label unchanged, character for character');
  assert.ok(PAGE.includes("document.getElementById('startFamilyBtn').addEventListener('click'"),
    'header Start button keeps the existing onboarding action');
  assert.ok(PAGE.includes("document.getElementById('startOverBtn').click()"), 'header Start reuses the reset flow');
  assert.ok(PAGE.includes('startFamilyBtn.hidden = false'), 'signed-out state shows the Start button');
  assert.ok(PAGE.includes('startFamilyBtn.hidden = true'), 'signed-in state hides the Start button');
  const style = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
  assert.ok(/#startFamilyBtn\[hidden\]\s*\{[^}]*display:\s*none/.test(style),
    'Start button honors the hidden attribute like every other hideable header element');
  assert.ok(style.includes('#authArea') && style.includes('flex-wrap: wrap'),
    'header action row wraps to a second row instead of overflowing at phone width');
  assert.ok(!PAGE.includes('overflow-x: hidden'),
    'no page-level overflow clipping masks unwrapped content');
});

test('signed-in header is unchanged: identity plus sign out, no Start button', () => {
  for (const token of ['Signed in as', 'id="signedInAs"', 'id="signedInEmail"', 'id="signOutBtn"']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  const authFn = PAGE.slice(PAGE.indexOf('async function loadAuth'), PAGE.indexOf('async function loadAuth') + 1200);
  const signedInBranch = authFn.slice(authFn.indexOf('signed_in'), authFn.indexOf('} else {'));
  assert.ok(signedInBranch.includes('signInBtn.hidden = true'), 'signed in hides Sign in');
  assert.ok(signedInBranch.includes('startFamilyBtn.hidden = true'), 'signed in hides Start too');
  assert.ok(signedInBranch.includes('signedInAs.hidden = false'), 'signed in shows the identity');
  assert.ok(signedInBranch.includes('signOutBtn.hidden = false'), 'signed in shows Sign out');
});

test('newsletter section renders only with content: hidden for real families, shown for demo', () => {
  assert.ok(PAGE.includes('id="newsletterSection"'), 'newsletter section carries a gate id');
  const hubMarkup = PAGE.slice(PAGE.indexOf('id="viewHub"'), PAGE.indexOf('id="viewEvening"'));
  assert.ok(hubMarkup.includes('id="newsletterSection"'), 'gated section lives in the hub view');
  assert.ok(hubMarkup.indexOf('id="newsletterSection"') < hubMarkup.indexOf('id="newsletter-h"'),
    'gate wraps the heading so both hide together');
  for (const token of ['setHubDemoPanels(false)', 'setHubDemoPanels(true)',
    "getElementById('newsletterSection').hidden"]) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  const audienceFn = PAGE.slice(PAGE.indexOf('async function applySchoolAudience'),
    PAGE.indexOf('async function applySchoolAudience') + 1400);
  assert.ok(audienceFn.includes('setHubDemoPanels(false)'), 'real family hides the newsletter section');
  assert.ok(audienceFn.includes('setHubDemoPanels(true)'), 'demo family shows the newsletter section');
  assert.ok(PAGE.includes('hasNewsletter'), 'demo load checks for actual newsletter content');
  assert.ok(PAGE.includes("document.getElementById('newsletterSection').hidden = !hasNewsletter"),
    'empty demo newsletter hides the section; content shows it');
});

test('School updates panel is demo-only: hidden for real families, unchanged for demo', () => {
  assert.ok(PAGE.includes('id="runSection"'), 'run panel carries a gate id');
  const hubMarkup = PAGE.slice(PAGE.indexOf('id="viewHub"'), PAGE.indexOf('id="viewEvening"'));
  assert.ok(hubMarkup.includes('id="runSection"'), 'gated panel lives in the hub view');
  assert.ok(hubMarkup.indexOf('id="runSection"') < hubMarkup.indexOf('id="runBtn"'),
    'gate wraps the run button so both hide together');
  assert.ok(PAGE.includes("getElementById('runSection').hidden"),
    'panel visibility is toggled with the viewer');
  const audienceFn = PAGE.slice(PAGE.indexOf('async function applySchoolAudience'),
    PAGE.indexOf('async function applySchoolAudience') + 1400);
  assert.ok(audienceFn.includes('setHubDemoPanels(false)'), 'real family omits the panel');
  assert.ok(audienceFn.includes('setHubDemoPanels(true)'), 'demo family keeps the panel');
  assert.ok(PAGE.includes('Check for school updates'), 'demo run button copy unchanged');
  assert.ok(PAGE.includes('Reads the newest newsletter and pulls out what matters.'),
    'demo hint copy unchanged');
  assert.ok(PAGE.includes('School updates appear under the demo family.'),
    'non-demo fallback message still set while hidden');
});

test('demo pill shows only to the demo viewer, never to a signed-in family', () => {
  assert.ok(PAGE.includes('id="demoPill"'), 'pill carries a gate id');
  assert.ok(PAGE.includes('Demo — fictional school &amp; family'), 'pill copy unchanged');
  const pillMarkup = PAGE.slice(PAGE.indexOf('id="demoPill"') - 60, PAGE.indexOf('id="demoPill"') + 60);
  assert.ok(pillMarkup.includes('hidden'), 'pill starts hidden so real families never see a flash of it');
  assert.ok(PAGE.includes('demoViewing = Boolean(status.profile && status.profile.is_demo)'),
    'viewer identity comes from the profile, same source as the School updates gate');
  assert.ok(PAGE.includes("getElementById('demoPill').hidden = !demoViewing"),
    'pill is present when the viewer is the demo family and absent otherwise');
  assert.ok(PAGE.includes('demoViewing = false;'), 'leaving the demo (new family or reset) clears the viewer flag');
});

test('demo pill tracks the live viewer through the real boot sequence', () => {
  // Brief 023: Toggling the `hidden` property was a visual no-op because the
  // author rule `.demo-badge { display: inline-block }` beats the UA
  // `[hidden] { display: none }`. Every other hideable element on the page
  // carries an explicit `[hidden]` override; the pill must too, or no JS
  // gating can ever hide it.
  const style = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
  assert.ok(/\.demo-badge\[hidden\]\s*\{\s*display:\s*none/.test(style),
    'pill CSS honors the hidden attribute, or the pill renders while hidden');

  // Run the page's REAL paintDemoBar (extracted verbatim, not re-typed)
  // against stub elements, in the page's real call order.
  function pageFunctionBody(name) {
    const start = PAGE.indexOf('function ' + name + '(');
    assert.ok(start !== -1, name + ' is defined on the page');
    const open = PAGE.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < PAGE.length; i++) {
      if (PAGE[i] === '{') depth++;
      else if (PAGE[i] === '}') {
        depth--;
        if (depth === 0) return PAGE.slice(open + 1, i);
      }
    }
    assert.fail(name + ' body never closes');
  }
  const paintBody = pageFunctionBody('paintDemoBar');
  assert.ok(paintBody.includes("getElementById('demoPill').hidden = !demoViewing"),
    'paintDemoBar drives the pill from the current viewer flag');
  function repaint(els, demoViewing) {
    const fn = new Function('document', 'demoBar', 'tabBar', 'demoViewing', paintBody);
    fn({ getElementById: (id) => els[id] }, els.demoBar, els.tabBar, demoViewing);
  }
  // Fresh markup state: pill, demo bar, and tabs all start hidden.
  function freshEls() {
    return { demoPill: { hidden: true }, demoBar: { hidden: true }, tabBar: { hidden: true } };
  }
  // showMain(): tabs unhide, then repaint — the same order as the page.
  function showMain(els, demoViewing) {
    els.tabBar.hidden = false;
    repaint(els, demoViewing);
  }

  // Boot as a signed-in non-demo family: module init (demoViewing = false),
  // then the profile resolves non-demo, then the main view paints.
  let els = freshEls();
  let demoViewing = false;
  demoViewing = Boolean({ is_demo: false } && { is_demo: false }.is_demo);
  showMain(els, demoViewing);
  assert.equal(els.demoPill.hidden, true, 'signed-in family boot ends with the pill hidden');
  assert.equal(els.demoBar.hidden, true, 'signed-in family boot ends with the demo bar hidden');

  // Boot as the demo viewer: the same sequence must leave the pill visible.
  els = freshEls();
  demoViewing = Boolean({ is_demo: true } && { is_demo: true }.is_demo);
  showMain(els, demoViewing);
  assert.equal(els.demoPill.hidden, false, 'demo boot ends with the pill visible');
  assert.equal(els.demoBar.hidden, false, 'demo boot ends with the demo bar visible');

  // Switching both ways mid-session repaints too, so the pill never sticks.
  showMain(els, false); // create-profile / reset path clears the flag, then shows main
  assert.equal(els.demoPill.hidden, true, 'leaving the demo hides the pill again');
  showMain(els, true); // switchToDemo path sets the flag, then shows main
  assert.equal(els.demoPill.hidden, false, 'returning to the demo shows the pill again');

  // Boot order lock: the profile-derived flag must resolve BEFORE the first
  // paint in loadInitial, or the first paint would use the initial value.
  const bootBody = pageFunctionBody('loadInitial');
  const resolveAt = bootBody.indexOf('demoViewing = Boolean(status.profile && status.profile.is_demo)');
  assert.ok(resolveAt !== -1, 'boot derives the viewer flag from the resolved profile');
  const firstPaint = Math.min(...['showMain()', 'openOnboarding(', 'showJoin()']
    .map((s) => bootBody.indexOf(s)).filter((i) => i !== -1));
  assert.ok(resolveAt < firstPaint, 'profile resolves before the first paint on every boot path');

  // Every view entry repaints, so hub/hub-page/evening/family views agree.
  for (const view of ['showMain', 'openOnboarding', 'showJoin']) {
    assert.ok(pageFunctionBody(view).includes('paintDemoBar()'),
      view + ' repaints the pill on entry');
  }
});

test('hub title shows the open hub name; picker text only with no hub open', () => {
  assert.ok(PAGE.includes('id="hubChooserText"'), 'chooser explainer carries an id');
  assert.ok(PAGE.includes('Hubs hold shared context — newsletters and notices. Your family’s private details never enter a hub.'),
    'chooser explainer copy unchanged');
  const detailFn = PAGE.slice(PAGE.indexOf('async function loadHubDetail'),
    PAGE.indexOf('async function loadHubDetail') + 3600);
  assert.ok(detailFn.includes("getElementById('hubTitle').textContent = data.hub.name"),
    'open hub titles the card with the hub name');
  assert.ok(detailFn.includes("getElementById('hubChooserText').hidden = true"),
    'open hub hides the generic chooser framing');
  const openFn = PAGE.slice(PAGE.indexOf('async function openHub'),
    PAGE.indexOf('async function openHub') + 500);
  assert.ok(openFn.includes("'Choose a hub'"), 'picker title remains for the no-hub state');
  assert.ok(openFn.includes("getElementById('hubChooserText').hidden = false"),
    'picker state restores the chooser framing');
  assert.ok(detailFn.includes("'Choose a hub'"), 'failed hub load falls back to the picker title');
});

test('add-material cluster is one tidy unit: styled picker, primary Add it, grouped status', () => {
  for (const token of ['id="materialText"', 'id="materialPdf"', 'id="addMaterialBtn"', 'Add it',
    'id="materialDots"', 'id="materialStatus"', 'id="materialWaitNote"',
    'id="materialPdfName"', 'material-status-group', 'pdf-picker', 'pdf-pick-btn']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes('small-btn" id="addMaterialBtn"'),
    'Add it is no longer a small pill button');
  assert.ok(PAGE.includes('#addMaterialBtn {'), 'Add it has its own primary style');
  const btnCss = PAGE.slice(PAGE.indexOf('#addMaterialBtn {'), PAGE.indexOf('#addMaterialBtn {') + 300);
  assert.ok(btnCss.includes('background: var(--pine)'), 'Add it uses the deep-green primary style');
  assert.ok(btnCss.includes('width: 100%'), 'Add it is sized like a primary action');
  assert.ok(PAGE.includes('#addMaterialBtn:disabled'), 'busy/disabled state still reads clearly');
  assert.ok(PAGE.includes('.pdf-file-name.has-file'), 'chosen file name shows clearly');
  assert.ok(PAGE.includes("getElementById('materialPdf').addEventListener('change'"),
    'picker updates the shown file name');
  const hubMarkup = PAGE.slice(PAGE.indexOf('id="viewHub"'), PAGE.indexOf('id="viewEvening"'));
  const groupAt = hubMarkup.indexOf('material-status-group');
  assert.ok(groupAt !== -1, 'status group lives in the hub view');
  assert.ok(groupAt < hubMarkup.indexOf('id="materialDots"') &&
    hubMarkup.indexOf('id="materialDots"') < hubMarkup.indexOf('id="materialStatus"') &&
    hubMarkup.indexOf('id="materialStatus"') < hubMarkup.indexOf('id="materialWaitNote"'),
    'dots, status label, and reassurance line sit in one aligned group');
  for (const stage of ['Reading your material…', 'Sorting out what matters…', 'Saving to your hub…']) {
    assert.ok(PAGE.includes(stage), `status label unchanged: ${stage}`);
  }
  assert.ok(PAGE.includes('This can take up to a minute — you do not need to stay here. It will be in this hub when you come back.'),
    'reassurance wording unchanged');
  assert.ok(PAGE.includes('.pdf-picker input[type="file"]'),
    'native input is visually restyled inside the picker, not rendered as the raw OS control');
});

test('family placements can be removed per child with a two-click confirm', () => {
  for (const token of ['Remove placement', 'placeRemoveBtn', 'placeRemoveConfirm',
    'placeRemoveYesBtn', 'placeRemoveNoBtn', 'Yes, remove it', 'data-child-id']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(PAGE.includes("Keep it"), 'remove confirm keeps the existing Keep-it wording');
  assert.ok(PAGE.includes('/placements/') && PAGE.includes("method: 'DELETE'"),
    'removal calls a DELETE placement URL');
  assert.ok(PAGE.includes('loadFamilyPlacements()'),
    'the family list re-renders after a removal');
});

test('hub page fits phone width: long strings wrap, grid children shrink', () => {
  assert.ok(PAGE.includes('li, summary, a, .chip, .quote { overflow-wrap: break-word; }'),
    'bullets, summaries, links, chips, and quotes wrap long unbroken strings');
  assert.ok(PAGE.includes('.hub-grid > * { min-width: 0; }'),
    'hub grid columns may shrink below content width');
  assert.ok(PAGE.includes('main > * { min-width: 0; }'),
    'top-level sections may shrink below content width');
  assert.ok(PAGE.includes('.hold-card > div:last-child { min-width: 0; }'),
    'evening hold-card text may shrink beside the calendar block');
  assert.ok(!PAGE.includes('overflow-x: hidden'),
    'no page-level overflow clipping masks unwrapped content');
});

test('start-a-hub autofill confirmation reads as a notice, not a wedged hint line', () => {
  assert.ok(PAGE.includes('id="parseLinkStatus"'), 'confirmation keeps its id (no behavior change)');
  assert.ok(PAGE.includes('Filled from ') && PAGE.includes('give it a quick check'),
    'confirmation copy unchanged, character for character');
  const at = PAGE.indexOf('id="parseLinkStatus"');
  const tag = PAGE.slice(PAGE.lastIndexOf('<p', at), at);
  assert.ok(tag.includes('autofill-note'), 'confirmation carries the notice class');
  assert.ok(!tag.includes('hint'), 'confirmation is no longer a hint line wedged under the button');
  for (const token of ['.autofill-note', 'background: var(--pine-soft)', 'border-radius: 12px',
    'font-size: 15px', '.autofill-note:empty { display: none; }']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
});

test('start-a-hub card holds one vertical rhythm before and after filling', () => {
  for (const token of ['#startHubForm { display: grid;', '#startHubForm[hidden] { display: none; }',
    '#startHubForm > * { min-width: 0; }', '#startHubForm .field { margin-bottom: 0; }',
    '#schoolNameWrap', '#teamFieldsWrap', 'gap: 12px']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  for (const token of ['#websiteFieldWrap[hidden]', '#schoolNameWrap[hidden]', '#teamFieldsWrap[hidden]',
    '#startHubFields[hidden]', '#singleNameWrap[hidden]']) {
    assert.ok(PAGE.includes(token), `${token} must stay hidden under the grid rhythm`);
  }
  assert.ok(!PAGE.includes('overflow-x: hidden'),
    'no page-level overflow clipping masks unwrapped content');
});
