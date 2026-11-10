// Brief 023: deterministic class-scoped agent intake + material provenance.
// An agent names the one teacher's class a post belongs to (audience class +
// audience_value), teacher-name spellings match ("Mme Karam" = "Karam"), and
// a material records where it came from (source). Fictional fixtures only;
// a stub model answers every extraction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 43200 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

function makeClient(bearer) {
  let cookie = '';
  async function req(urlPath, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (bearer) opts.headers.Authorization = 'Bearer ' + bearer;
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
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    get: (p) => req(p),
  };
}

test('normalizeClass tolerates teacher honorifics and a trailing "class"', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-class-norm-'));
  process.env.APP_DB_PATH = path.join(tmpDir, 'app.db');
  process.env.APP_DB_GCS_BUCKET = '';
  process.env.APP_DB_GCS_OBJECT = '';
  const { normalizeClass } = require('../db.js');
  const karam = normalizeClass('Karam');
  assert.equal(karam, 'karam');
  for (const v of ['Mme Karam', 'Mme. Karam', 'mme karam', "Karam's class", 'Karam’s class', 'Karam class',
    'Mme Karam’s class', 'Mlle Karam', 'M. Karam', 'M Karam', 'Mr Karam', 'Mrs. Karam', 'Ms Karam', 'Miss Karam', 'Dr. Karam', 'Class Karam', '  Karam  ']) {
    assert.equal(normalizeClass(v), karam, v);
  }
  // Existing labels keep working exactly as before.
  assert.equal(normalizeClass('3B'), '3b');
  assert.equal(normalizeClass('Class 3B'), '3b');
  assert.equal(normalizeClass('5C'), '5c');
  assert.equal(normalizeClass(''), '');
  // A bare honorific is not stripped to nothing; other teachers stay distinct.
  assert.equal(normalizeClass('Ms'), 'ms');
  assert.notEqual(normalizeClass('Mme Other'), karam);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('class-scoped intake reaches only that class; provenance and manifest', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-class-intake-'));
  // Each extraction answers one fact whose quote is the first sentence sent.
  const fakeModel = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const m = raw.match(/(ZZ[A-Za-z]+) notice: [^.]*\./);
      const quote = m ? m[0] : 'nothing';
      const tag = m ? m[1] : 'none';
      const content = JSON.stringify({
        material_title: tag + ' notice',
        facts: [{
          id: 'fact-' + tag.toLowerCase(), type: 'event', title: tag + ' event', detail: quote, date: '2026-11-20', time: '',
          applies_to: 'all students', action_required: false, action: '', link: '',
          source_document: 'notice', source_text: quote, published_at: '', extracted_at: '', confidence: 1,
          supersedes: '', group_label: '', group_summary: '',
        }],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'), PARENTLOOP_TEST_AUTH: '1',
      SCHOOL_AGENT_API_KEY: 'test-key',
      SCHOOL_AGENT_API_URL: `http://127.0.0.1:${fakeModel.address().port}/chat`,
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fakeModel.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const karam = makeClient();
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await karam.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  async function family(client, name, sub) {
    const email = sub + '@example.com';
    const prof = await client.post('/api/profile', { parent_name: name, parent_email: email, children: [{ name: name + ' Kid' }] });
    assert.equal(prof.res.status, 200, prof.text.slice(0, 300));
    assert.equal((await client.post('/api/auth/test-complete', { sub, email })).res.status, 200);
    return prof.data.profile.children[0].id;
  }

  const karamKid = await family(karam, 'Karam Parent', 'karam-parent');
  const made = await karam.post('/api/hubs', {
    school_name: 'Birchwood Public School', city: 'Fictionville', province: 'Ontario', country: 'Canada', kind: 'school',
  });
  assert.equal(made.res.status, 200, made.text.slice(0, 300));
  const hubId = made.data.hub.id;
  assert.equal((await karam.post(`/api/hubs/${hubId}/placements`, {
    placements: [{ child_id: karamKid, grade: 'Grade 2', class: 'Karam' }],
  })).res.status, 200);
  assert.equal((await karam.post(`/api/hubs/${hubId}/join-settings`, { open: true })).res.status, 200);

  async function joiner(name, sub, grade, className) {
    const client = makeClient();
    const kid = await family(client, name, sub);
    const invite = await karam.post(`/api/hubs/${hubId}/invites`, {});
    assert.equal(invite.res.status, 200, invite.text.slice(0, 300));
    const accepted = await client.post(`/api/join/${invite.data.token}/accept`, {});
    assert.equal(accepted.res.status, 200, accepted.text.slice(0, 300));
    assert.equal((await client.post(`/api/hubs/${hubId}/placements`, {
      placements: [{ child_id: kid, grade, class: className }],
    })).res.status, 200);
    return client;
  }
  const other = await joiner('Other Parent', 'other-parent', 'Grade 2', 'Other');
  const older = await joiner('Older Parent', 'older-parent', 'Grade 4', '4A');

  const minted = await karam.post('/api/agent-tokens', { name: 'Muse' });
  assert.equal(minted.res.status, 200, minted.text.slice(0, 300));
  const agent = makeClient(minted.data.token);
  const otherToken = await other.post('/api/agent-tokens', { name: 'Other helper' });
  assert.equal(otherToken.res.status, 200, otherToken.text.slice(0, 300));
  const otherAgent = makeClient(otherToken.data.token);

  const titlesFor = async (client) => (await client.get(`/api/hubs/${hubId}`)).data.facts.map((f) => f.title);
  const bundleTitles = async (client) => {
    const ctx = await client.get('/api/agent/context');
    assert.equal(ctx.res.status, 200, ctx.text.slice(0, 300));
    const hub = ctx.data.hubs.find((h) => h.id === hubId);
    return { facts: hub.facts.map((f) => f.title), materials: hub.materials };
  };

  const SOURCE = 'Google Classroom — Mme Karam’s class, via Muse’s daily check';
  let classMaterial = null;

  await t.test('audience class + audience_value stamps that class, with source stored', async () => {
    const up = await agent.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', title: 'Reading log', text: 'ZZClass notice: reading logs come home Friday for our class.',
      audience: 'class', audience_value: '  Karam  ', source: '  ' + SOURCE + '  ',
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts_added, 1);
    assert.equal(up.data.facts[0].scope, 'class');
    assert.equal(up.data.facts[0].scope_value, 'Karam');
    assert.equal(up.data.material.source, SOURCE);
    classMaterial = up.data.material;
  });

  await t.test('class item: Karam family sees it, Other and Grade 4 families do not', async () => {
    assert.ok((await titlesFor(karam)).includes('ZZClass event'));
    assert.ok(!(await titlesFor(other)).includes('ZZClass event'));
    assert.ok(!(await titlesFor(older)).includes('ZZClass event'));
    const karamBundle = await bundleTitles(agent);
    assert.ok(karamBundle.facts.includes('ZZClass event'));
    const m = karamBundle.materials.find((x) => x.id === classMaterial.id);
    assert.ok(m, 'class material in the Karam bundle');
    assert.equal(m.source, SOURCE);
    assert.equal(m.scope, 'class');
    const otherBundle = await bundleTitles(otherAgent);
    assert.ok(!otherBundle.facts.includes('ZZClass event'));
    assert.ok(!otherBundle.materials.some((x) => x.id === classMaterial.id));
    const hubRead = await karam.get(`/api/hubs/${hubId}`);
    const row = hubRead.data.materials.find((x) => x.id === classMaterial.id);
    assert.equal(row.source, SOURCE);
  });

  await t.test('a teacher-name variant reaches the same class', async () => {
    const up = await agent.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', text: 'ZZVariant notice: library books are due back on Monday.',
      audience: 'class', audience_value: 'Mme. Karam',
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts[0].scope_value, 'Mme. Karam');
    assert.ok((await titlesFor(karam)).includes('ZZVariant event'));
    assert.ok(!(await titlesFor(other)).includes('ZZVariant event'));
  });

  await t.test('grade item reaches both Grade 2 families only; school item reaches everyone', async () => {
    const grade = await agent.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', text: 'ZZGrade notice: the Grade 2 trip to the farm is on November 20.',
      audience: 'grade', audience_value: 'grade two',
    });
    assert.equal(grade.res.status, 200, grade.text.slice(0, 400));
    assert.equal(grade.data.facts[0].scope, 'grade');
    assert.equal(grade.data.facts[0].scope_value, 'Grade 2');
    const school = await agent.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', text: 'ZZSchool notice: picture day is for every student in the school.',
      audience: 'school', audience_value: 'Karam',
    });
    assert.equal(school.res.status, 200, school.text.slice(0, 400));
    assert.equal(school.data.facts[0].scope, 'school', 'audience_value is ignored for school');
    assert.equal(school.data.material.source, '', 'absent source stays empty');
    for (const c of [karam, other]) {
      const titles = await titlesFor(c);
      assert.ok(titles.includes('ZZGrade event'));
      assert.ok(titles.includes('ZZSchool event'));
    }
    const olderTitles = await titlesFor(older);
    assert.ok(!olderTitles.includes('ZZGrade event'));
    assert.ok(olderTitles.includes('ZZSchool event'));
  });

  await t.test('without audience_value, class still comes from the submitter placement (and its errors stand)', async () => {
    const up = await otherAgent.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', text: 'ZZOwn notice: our class has a spelling test on Thursday.', audience: 'class', audience_value: '   ',
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts[0].scope_value, 'Other');
    assert.ok((await titlesFor(other)).includes('ZZOwn event'));
    assert.ok(!(await titlesFor(karam)).includes('ZZOwn event'));
    // A family with no class placement keeps the old error.
    const noClass = makeClient();
    const kid = await family(noClass, 'No Class Parent', 'noclass-parent');
    const invite = await karam.post(`/api/hubs/${hubId}/invites`, {});
    assert.equal((await noClass.post(`/api/join/${invite.data.token}/accept`, {})).res.status, 200);
    assert.equal((await noClass.post(`/api/hubs/${hubId}/placements`, {
      placements: [{ child_id: kid, grade: 'Grade 2', class: '' }],
    })).res.status, 200);
    const refused = await noClass.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', text: 'ZZRefused notice: this should not be added anywhere.', audience: 'class',
    });
    assert.equal(refused.res.status, 500);
    assert.match(refused.data.error, /class for this hub first/);
  });

  await t.test('audience_value and source are capped', async () => {
    const up = await agent.post(`/api/hubs/${hubId}/materials`, {
      kind: 'paste', text: 'ZZCap notice: long labels are trimmed to fit.',
      audience: 'class', audience_value: 'K'.repeat(120), source: 'S'.repeat(300),
    });
    assert.equal(up.res.status, 200, up.text.slice(0, 400));
    assert.equal(up.data.facts[0].scope_value.length, 80);
    assert.equal(up.data.material.source.length, 200);
  });

  await t.test('newsletter/run accepts audience_value', async () => {
    const run = await karam.post('/api/newsletter/run', {
      hub_id: hubId, text: 'ZZRun notice: the class bake sale is next Wednesday.', audience: 'class', audience_value: 'Mme Karam',
    });
    assert.equal(run.res.status, 200, run.text.slice(0, 400));
    assert.equal(run.data.facts[0].scope, 'class');
    assert.equal(run.data.facts[0].scope_value, 'Mme Karam');
    assert.ok((await titlesFor(karam)).includes('ZZRun event'));
    assert.ok(!(await titlesFor(other)).includes('ZZRun event'));
  });

  await t.test('manifest documents audience_value, source, and class-feed intake', async () => {
    const man = await makeClient().get('/api/agent');
    assert.equal(man.res.status, 200);
    const add = man.data.endpoints.find((e) => e.name === 'add material');
    const addText = JSON.stringify(add);
    assert.match(addText, /audience_value/);
    assert.match(addText, /"source"/);
    const fed = man.data.keep_hub_fed.join('\n');
    assert.match(fed, /Google Classroom/);
    assert.match(fed, /audience class/);
    assert.match(fed, /audience_value/);
    assert.match(fed, /source/);
  });
});
