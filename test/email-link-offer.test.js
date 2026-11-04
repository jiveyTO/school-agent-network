const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Brief 074: Google sign-in finds a family made with the typed-email form
// when Google says the address is verified — but only offers it ("is this
// your family?"); nothing links until the parent taps Yes. Sign-in goes
// through the test-only /api/auth/test-complete path (PARENTLOOP_TEST_AUTH=1),
// the same completion the real OAuth callback runs.
// Fixtures are fictional (Lakeview / Brook families). No real data.

const ROOT = path.join(__dirname, '..');
const PORT = 43000 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function makeClient() {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (cookie) opts.headers.Cookie = cookie;
    const res = await fetch(`${BASE}${urlPath}`, opts);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/parentloop_session=([^;]+)/);
      if (m) cookie = 'parentloop_session=' + m[1];
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { res, data, text };
  }
  return {
    get: (p, headers) => req(p, { headers }),
    post: (p, body, headers) => req(p, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: JSON.stringify(body || {}),
    }),
  };
}

async function waitForServer() {
  const probe = makeClient();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      if ((await probe.get('/api/onboarding/status')).res.ok) return;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

// A family made with the typed-email form, signed out (no Google link).
async function typedEmailFamily(parentName, email, kids) {
  const c = makeClient();
  const made = await c.post('/api/profile', {
    parent_name: parentName, parent_email: email, children: kids.map((name) => ({ name })),
  });
  assert.equal(made.res.status, 200, made.text.slice(0, 200));
  return { client: c, profile: made.data.profile };
}

const signIn = (client, sub, email, verified) =>
  client.post('/api/auth/test-complete', { sub, email, email_verified: verified });
const status = async (client) => (await client.get('/api/onboarding/status')).data;

test('Google sign-in offers the family made with the same email', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-link-offer-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), PARENTLOOP_TEST_AUTH: '1', APP_DB_GCS_BUCKET: '' },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  await t.test('the page has the offer and no switch-back to the demo while on it', () => {
    for (const token of ['id="linkOfferView"', 'Is this your family?', 'Yes, this is my family', 'No — start fresh',
      '/api/auth/link-offer/accept', '/api/auth/link-offer/decline']) {
      assert.ok(PAGE.includes(token), `page has ${token}`);
    }
    assert.ok(PAGE.includes("document.getElementById('demoBtn').hidden = Boolean(profile && profile.is_demo);"));
  });

  await t.test('a match is offered; Yes links it and lands on the family, hubs and placements intact', async () => {
    const { client: maker, profile } = await typedEmailFamily('Mira Lakeview', 'Mira.Lakeview@Example.com', ['Tess', 'Owen']);
    const hub = await maker.post('/api/hubs', { name: 'Lakeview Public School', kind: 'other' });
    const hubId = hub.data.hub.id;
    const placements = profile.children.map((c, i) => ({ child_id: c.id, grade: String(3 + i), class: '' }));
    assert.equal((await maker.post(`/api/hubs/${hubId}/placements`, { placements })).res.status, 200);
    assert.equal((await maker.get(`/api/hubs/${hubId}`)).data.needs_placement, false);

    const parent = makeClient(); // another browser
    await signIn(parent, 'sub-lakeview', 'mira.lakeview@example.com', true);
    const before = await status(parent);
    assert.equal(before.isDemo, true, 'until the parent answers, the session holds no family of its own');
    assert.equal(before.link_offer.families.length, 1);
    const offered = before.link_offer.families[0];
    assert.deepEqual({ parent_name: offered.parent_name, children: offered.children }, { parent_name: 'Mira Lakeview', children: ['Tess', 'Owen'] });
    assert.ok(!JSON.stringify(before.link_offer).includes(profile.id), 'never the family id');

    const yes = await parent.post('/api/auth/link-offer/accept', { key: offered.key });
    assert.equal(yes.res.status, 200, yes.text.slice(0, 200));
    const after = await status(parent);
    assert.equal(after.isDemo, false);
    assert.equal(after.profile.id, profile.id, 'lands on that family');
    assert.equal(after.link_offer, null, 'asked once');
    const hubs = (await parent.get('/api/hubs')).data.hubs;
    assert.ok(hubs.some((h) => h.id === hubId), 'its hubs are there');
    const detail = (await parent.get(`/api/hubs/${hubId}`)).data;
    assert.equal(detail.needs_placement, false, 'placements intact');

    // The link is real: a fresh sign-in with that account goes straight there.
    const later = makeClient();
    await signIn(later, 'sub-lakeview', 'mira.lakeview@example.com', true);
    const again = await status(later);
    assert.equal(again.profile.id, profile.id);
    assert.equal(again.link_offer, null);
  });

  await t.test('No stamps nothing, behaves as today, and is not asked again', async () => {
    const { profile } = await typedEmailFamily('Nora Brook', 'nora.brook@example.com', ['Ivy']);
    const parent = makeClient();
    await signIn(parent, 'sub-brook', 'nora.brook@example.com', true);
    assert.equal((await status(parent)).link_offer.families.length, 1);
    assert.equal((await parent.post('/api/auth/link-offer/decline', {})).res.status, 200);
    const after = await status(parent);
    assert.equal(after.link_offer, null, 'no nag');
    assert.equal(after.isDemo, true, 'today’s signed-in-without-a-family state');
    // Nothing was linked: a new sign-in elsewhere still sees the family unlinked (and offered).
    const other = makeClient();
    await signIn(other, 'sub-brook', 'nora.brook@example.com', true);
    const fresh = await status(other);
    assert.equal(fresh.isDemo, true);
    assert.equal(fresh.link_offer.families.length, 1);
    // A refused key is never linked.
    assert.equal((await parent.post('/api/auth/link-offer/accept', { key: fresh.link_offer.families[0].key })).res.status, 409);
    void profile;
  });

  await t.test('an unverified Google email gets no offer', async () => {
    await typedEmailFamily('Uma Fenwick', 'uma.fenwick@example.com', ['Rae']);
    const parent = makeClient();
    await signIn(parent, 'sub-fenwick', 'uma.fenwick@example.com', false);
    const s = await status(parent);
    assert.equal(s.link_offer, null);
    assert.equal(s.isDemo, true);
  });

  await t.test('several matches are listed for the parent to pick; never auto-linked', async () => {
    const a = await typedEmailFamily('Pat Orchard', 'orchard@example.com', ['Lily']);
    const b = await typedEmailFamily('Sam Orchard', 'orchard@example.com', ['Max', 'Zoe']);
    const parent = makeClient();
    await signIn(parent, 'sub-orchard', 'orchard@example.com', true);
    const s = await status(parent);
    assert.equal(s.isDemo, true, 'nothing picked for them');
    assert.deepEqual(s.link_offer.families.map((f) => f.parent_name), ['Pat Orchard', 'Sam Orchard']);
    const pick = s.link_offer.families.find((f) => f.parent_name === 'Sam Orchard');
    assert.equal((await parent.post('/api/auth/link-offer/accept', { key: pick.key })).res.status, 200);
    assert.equal((await status(parent)).profile.id, b.profile.id);
    // The other family stays unlinked.
    const other = makeClient();
    await signIn(other, 'sub-orchard-2', 'orchard@example.com', true);
    assert.deepEqual((await status(other)).link_offer.families.map((f) => f.parent_name), ['Pat Orchard']);
    void a;
  });

  await t.test('no match is unchanged', async () => {
    const parent = makeClient();
    const done = await signIn(parent, 'sub-nobody', 'nobody.here@example.com', true);
    assert.equal(done.res.status, 200);
    const s = await status(parent);
    assert.equal(s.link_offer, null);
    assert.equal(s.isDemo, true);
    assert.equal(s.auth.signed_in, true);
  });

  await t.test('an already-linked sign-in is unchanged; a family owned by another account is never offered', async () => {
    const owner = makeClient();
    await owner.post('/api/profile', { parent_name: 'Gil Harbour', parent_email: 'harbour@example.com', children: [{ name: 'June' }] });
    await signIn(owner, 'sub-harbour', 'harbour@example.com', true); // Brief 024: attaches the session's family
    const linked = await status(owner);
    assert.equal(linked.isDemo, false);
    assert.equal(linked.link_offer, null);
    const back = makeClient();
    await signIn(back, 'sub-harbour', 'harbour@example.com', true);
    assert.equal((await status(back)).profile.id, linked.profile.id, 'linked account goes straight to its family');
    // A different Google account with the same address never sees it.
    const stranger = makeClient();
    await signIn(stranger, 'sub-harbour-other', 'harbour@example.com', true);
    assert.equal((await status(stranger)).link_offer, null);
  });

  await t.test('same browser: a family made signed out is attached on sign-in, not duplicated; after sign-out it is offered', async () => {
    const { client, profile } = await typedEmailFamily('Rita Cove', 'rita.cove@example.com', ['Ada']);
    await signIn(client, 'sub-cove', 'rita.cove@example.com', true);
    const s = await status(client);
    assert.equal(s.profile.id, profile.id, 'Brief 024 attach, unchanged');
    assert.equal(s.link_offer, null);
    // The sibling seam: a family made signed out, the session later lost
    // (signed out), then a Google sign-in in the same browser.
    const { client: same, profile: kept } = await typedEmailFamily('Lena Pier', 'lena.pier@example.com', ['Bo']);
    await same.post('/api/auth/logout', {});
    await signIn(same, 'sub-pier', 'lena.pier@example.com', true);
    const offer = (await status(same)).link_offer;
    assert.equal(offer.families.length, 1, 'offered, not a duplicate family');
    await same.post('/api/auth/link-offer/accept', { key: offer.families[0].key });
    assert.equal((await status(same)).profile.id, kept.id);
  });

  await t.test('an agent token cannot answer the offer', async () => {
    const res = await makeClient().post('/api/auth/link-offer/accept', { key: 'x' }, { Authorization: 'Bearer pl_agent_not_a_real_token' });
    assert.equal(res.res.status, 401);
  });
});
