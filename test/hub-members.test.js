const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 37500 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let tmpDir = null;

async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const probed = await jf('/api/onboarding/status');
      if (probed.res.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Test server did not start.');
}

let jarCookie = '';
async function jf(urlPath, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({}, (options && options.headers) || {});
  if (jarCookie) opts.headers.Cookie = jarCookie;
  const res = await fetch(`${BASE}${urlPath}`, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/parentloop_session=([^;]+)/);
    if (m) jarCookie = 'parentloop_session=' + m[1];
  }
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { res, data, text };
}

function post(urlPath, body) {
  return jf(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

function roleOf(member) {
  return String((member && (member.role_label || member.role)) || '').toLowerCase();
}

test('hub membership is visible to members and every hub names a contact', async (t) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-members-'));
  const dbPath = path.join(tmpDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), APP_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child) child.kill('SIGTERM');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await waitForServer();

  let hubId = null;

  await t.test('founder sees the families list and the contact line', async () => {
    await post('/api/profile', {
      parent_name: 'Founder Pat',
      parent_email: 'founder.pat@example.com',
      child_name: 'Pat Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const created = await post('/api/hubs', { name: 'Members Test Hub', kind: 'other' });
    assert.equal(created.res.status, 200, created.text.slice(0, 300));
    hubId = created.data.hub.id;

    const detail = await jf(`/api/hubs/${hubId}`);
    assert.equal(detail.res.status, 200);
    assert.ok(Array.isArray(detail.data.members), 'hub detail serves a members list to members');
    assert.equal(detail.data.members.length, 1);
    assert.equal(detail.data.member_count, detail.data.members.length, 'count line and list agree');
    assert.equal(detail.data.members[0].parent_name, 'Founder Pat');
    assert.equal(roleOf(detail.data.members[0]), 'founder');
    const contacts = detail.data.contact_names || (detail.data.contacts || []).map((c) => c.parent_name || c.name || c);
    assert.deepEqual(contacts, ['Founder Pat']);
    assert.ok(String(detail.data.hub_contact || detail.data.point_of_contact || '').includes('Founder Pat'));
    assert.ok(!JSON.stringify(detail.data.members).includes('Pat Kid'), 'no child names in the members list');
    assert.ok(!JSON.stringify(detail.data.members).includes('Grade 3'), 'no grades in the members list');
    assert.ok(!/@/.test(JSON.stringify(detail.data.members)), 'no email addresses in the members list');
  });

  await t.test('a joined member sees both families, founder first, and the contact', async () => {
    const invite = await post(`/api/hubs/${hubId}/invites`, {});
    assert.equal(invite.res.status, 200);
    await post('/api/profile', {
      parent_name: 'Joiner Jo',
      parent_email: 'joiner.jo@example.com',
      child_name: 'Jo Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'tell me right away',
    });
    const accepted = await post(`/api/join/${invite.data.token}/accept`, {});
    assert.equal(accepted.res.status, 200);

    const detail = await jf(`/api/hubs/${hubId}`);
    assert.equal(detail.res.status, 200);
    assert.equal(detail.data.members.length, 2);
    assert.equal(detail.data.member_count, 2, 'count line and list agree');
    assert.equal(detail.data.members[0].parent_name, 'Founder Pat', 'founder/admins sort first');
    assert.equal(roleOf(detail.data.members[0]), 'founder');
    assert.equal(detail.data.members[1].parent_name, 'Joiner Jo');
    assert.equal(roleOf(detail.data.members[1]), 'member');
    const contacts = detail.data.contact_names || (detail.data.contacts || []).map((c) => c.parent_name || c.name || c);
    assert.deepEqual(contacts, ['Founder Pat']);
    assert.ok(!JSON.stringify(detail.data.members).includes('Jo Kid'));
    assert.ok(!JSON.stringify(detail.data.members).includes('Pat Kid'));
  });

  await t.test('a non-member session receives neither the list nor the contact', async () => {
    await post('/api/profile', {
      parent_name: 'Outsider Eve',
      parent_email: 'outsider.eve@example.com',
      child_name: 'Eve Kid',
      grade: 'Grade 3',
      class_name: '3B',
      school_name: 'Maple Grove Elementary',
      priorities: [],
      nudge_style: 'one short message in the evening',
    });
    const detail = await jf(`/api/hubs/${hubId}`);
    assert.equal(detail.res.status, 403);
    assert.equal(detail.data.members, undefined, 'no members list for non-members');
    assert.equal(detail.data.contacts, undefined, 'no contacts for non-members');
    assert.equal(detail.data.contact_names, undefined, 'no contact names for non-members');
    assert.ok(!detail.text.includes('Founder Pat'), 'non-member response names no member');
    assert.ok(!detail.text.includes('Joiner Jo'), 'non-member response names no member');
    assert.ok(!detail.text.includes('Hub contact'), 'non-member response has no contact line');
  });

  await t.test('demo family is listed in the demo hubs and counts agree', async () => {
    await post('/api/profile/demo', {});
    const hubs = await jf('/api/hubs');
    const demoHubs = (hubs.data.hubs || []).filter((h) => h.is_demo);
    assert.ok(demoHubs.length >= 2, 'demo hubs exist');
    for (const hub of demoHubs) {
      const detail = await jf(`/api/hubs/${hub.id}`);
      assert.equal(detail.res.status, 200);
      assert.ok(Array.isArray(detail.data.members), `${hub.name} serves a members list`);
      assert.equal(detail.data.member_count, detail.data.members.length, `${hub.name} count agrees with list`);
      const names = detail.data.members.map((m) => m.parent_name);
      assert.ok(names.includes('Alex Rivera'), `${hub.name} lists the demo family`);
      assert.ok(!JSON.stringify(detail.data.members).includes('Maya Rivera'), 'no child names in the members list');
    }
    const hubA = demoHubs.find((h) => h.name === 'Grade 3 — Maple Grove Elementary');
    assert.ok(hubA);
    const detailA = await jf(`/api/hubs/${hubA.id}`);
    const rivera = detailA.data.members.find((m) => m.parent_name === 'Alex Rivera');
    assert.ok(['founder', 'admin'].includes(roleOf(rivera)), 'demo founder/admin role renders on the school hub');
    const contactsA = detailA.data.contact_names || (detailA.data.contacts || []).map((c) => c.parent_name || c.name || c);
    assert.ok(contactsA.includes('Alex Rivera'), 'demo school hub names its contact');
  });

  await t.test('hub page carries the families section and contact line', async () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(page.includes('Parents here'), 'families section heading present');
    assert.ok(page.includes('id="hubMembers"'), 'members container present');
    assert.ok(page.includes("'Hub contact'"), 'the contact is named on their roster row');
  });
});
