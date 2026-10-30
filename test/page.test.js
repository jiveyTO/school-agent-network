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

test('long model waits show indeterminate progress with staged status', () => {
  assert.ok(PAGE.includes('id="materialProgress"') && PAGE.includes('id="parentProgress"'));
  assert.ok(PAGE.includes('startStagedStatus') && PAGE.includes('stopStagedStatus'));
  assert.ok(PAGE.includes('progress-slide'), 'indeterminate animation, no percentages');
  for (const stage of ['Reading your material…', 'Sorting out what matters…', 'Saving to your hub…',
    'Checking every hub for what’s still open…', 'Writing one calm summary…']) {
    assert.ok(PAGE.includes(stage), `staged text present: ${stage}`);
  }
  assert.ok(!PAGE.includes('% complete') && !PAGE.includes('percent'));
  assert.ok(PAGE.includes("inputs.forEach(function (el) { if (el) el.disabled = true; })"), 'material inputs disable during processing');
  assert.ok(PAGE.includes("inputs.forEach(function (el) { if (el) el.disabled = false; })"), 'material inputs re-enable after');
});

test('hub detail renders one source card per material with collapsible groups', () => {
  for (const token of ['renderHubSources', 'renderFamilyStrip', 'factBullet', 'groupBulletList', 'paintGroupsToggle', 'factMatters',
    'source-card', 'group-card', 'data-groupname', "'Expand all'", "'Collapse all'"]) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes('hubFactCard'), 'no per-fact cards inside groups');
  assert.ok(PAGE.includes('Added ') && PAGE.includes('notes'), 'card header shows when it was added and its note count');
  assert.ok(PAGE.includes('Nothing shared from this one yet.'));
  assert.ok(PAGE.includes('data-expand-group'), 'shared strip entries expand their group in place');
});

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

test('family strip is group-aware and qualifies only deadlines and real actions', () => {
  for (const token of ['factActionKind', 'stripChips', 'id="familyStrip"', 'For your family']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes('Sign-up needed'), 'no generic strip labels');
  assert.ok(PAGE.includes("Due ' + esc(humanDate(f.date))"));
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
  assert.ok(PAGE.includes('form.hidden = !startHubOpen'));
  assert.ok(PAGE.includes('startHubOpen = false;'), 'successful create collapses the form');
});

test('add material has a "Who is this for?" audience selector sent with uploads', () => {
  assert.ok(PAGE.includes('id="materialAudience"'));
  assert.ok(PAGE.includes('Who is this for?'));
  assert.ok(PAGE.includes('Let ParentLoop decide'));
  assert.ok(PAGE.includes('My child’s grade') && PAGE.includes('My child’s class'));
  const pdfAt = PAGE.indexOf("kind: 'pdf'");
  const pasteAt = PAGE.indexOf("kind: 'paste'");
  assert.ok(pdfAt !== -1 && pasteAt !== -1);
  assert.ok(PAGE.indexOf('audience:', pdfAt) !== -1 && PAGE.indexOf('audience:', pdfAt) < pdfAt + 400);
  assert.ok(PAGE.indexOf('audience:', pasteAt) !== -1 && PAGE.indexOf('audience:', pasteAt) < pasteAt + 400);
  assert.ok(PAGE.includes('friendlyScope'));
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
  for (const token of ['id="welcomeHubs"', 'id="welcomeHubFormSlot"', 'id="startHubCard"',
    'id="viewHub"', 'id="hubBackBtn"', 'applyHubBranch']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  assert.ok(!PAGE.includes("getElementById('hubViewSection').hidden"), 'list branching must not toggle hub detail');
  const listMarkup = PAGE.slice(PAGE.indexOf('id="viewHubs"'), PAGE.indexOf('id="viewHub"'));
  for (const token of ['id="hubs-h"', 'id="hubsList"', 'id="startHubCard"', '+ Start a hub']) {
    assert.ok(listMarkup.includes(token), `My hubs list must contain ${token}`);
  }
  for (const token of ['id="hub-view-h"', 'id="hubTitle"', 'Shared notes', 'id="hubFacts"',
    'id="placementCard"', 'id="hubMaterials"', 'id="addMaterialBtn"', 'id="inviteBtn"',
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
  assert.ok(PAGE.includes("list.after(form)"));
  assert.ok(PAGE.includes("await loadHubs(data.hub.id)"), 'creating the first hub must re-render without reload');
});

test('hub cards open a dedicated hub view; the back control returns to the list', () => {
  for (const token of ['id="viewHub"', 'id="hubBackBtn"', 'Back to My hubs', 'openHub', "showView('hub')"]) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  const hubMarkup = PAGE.slice(PAGE.indexOf('id="viewHub"'), PAGE.indexOf('id="viewEvening"'));
  for (const token of ['id="hub-view-h"', 'id="hubTitle"', 'Shared notes', 'id="hubFacts"',
    'id="hubMaterials"', 'Add this material', 'id="placementCard"', 'Place your children in this hub',
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

test('grade and class live in hub placements, editable from the hub view or My family', () => {
  for (const token of ['id="placementCard"', 'id="placementFields"', 'id="placementSaveBtn"',
    'id="placementSkipBtn"', 'id="placementStatus"', 'Place your children in this hub', 'Skip for now',
    'needs_placement', 'id="placementsList"', 'id="place-h"', 'School placements',
    'id="editFamilyBtn"', 'Edit family names', '/placements', 'team hub, no placement needed']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
});

test('demo viewers get a demo bar with a path to their own family', () => {
  for (const token of ['id="demoBar"', 'id="demoBarBtn"', 'demoViewing', 'paintDemoBar',
    'You’re exploring as the demo family.', 'Start with your own family']) {
    assert.ok(PAGE.includes(token), `${token} must be present`);
  }
  const barAt = PAGE.indexOf('id="demoBar"');
  const tabAt = PAGE.indexOf('id="tabBar"');
  assert.ok(barAt !== -1 && barAt < tabAt, 'demo bar sits under the header, above the tab row');
  assert.ok(PAGE.includes('demoBar.hidden = !(demoViewing && !tabBar.hidden)'), 'bar shows for demo viewers in main views only');
  assert.ok(PAGE.includes("document.getElementById('startOverBtn').click()"), 'bar button reuses the reset flow');
  assert.ok(!PAGE.includes('>Start over</button>'), 'quiet control renamed to match');
});
