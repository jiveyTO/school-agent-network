const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Activity hubs get the same website field as school and team hubs:
// "Fill it in for me" reads an activity provider's page (a club, studio or
// academy) and fills the hub name, and the website is kept on the hub.
// Fixtures are fictional (Cedar Valley Dance Studio, Willow Creek); a stub
// model and a stub page stand in for the real ones.

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PORT = 41200 + (process.pid % 90);
const AUX_PORT = PORT + 500;
const BASE = `http://127.0.0.1:${PORT}`;
const AUX = `http://127.0.0.1:${AUX_PORT}`;

const STUDIO_HTML =
  '<html><head><title>Cedar Valley Dance Studio | Classes for every age</title></head><body>' +
  '<h1>Cedar Valley Dance Studio</h1><p>Ballet, jazz and hip hop for kids and adults.</p>' +
  '<footer>40 Studio Lane, Willow Creek K1A 0B1 · 555-0100</footer></body></html>';

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
    get: (p) => req(p),
    post: (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
  };
}

test('activity hubs: website autofill and saved website', async (t) => {
  let modelReply = '{}';
  let lastSystem = '';
  const aux = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/chat') {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
        lastSystem = String(((body.messages || [])[0] || {}).content || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: modelReply }, finish_reason: 'stop' }] }));
        return;
      }
      if (req.url === '/studio') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(STUDIO_HTML);
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
  });
  await new Promise((resolve) => aux.listen(AUX_PORT, '127.0.0.1', resolve));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentloop-activity-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PARENTLOOP_TEST_SIGNUP_VERIFIED: '1', PORT: String(PORT), APP_DB_PATH: path.join(tmpDir, 'app.db'),
      APP_DB_GCS_BUCKET: '', APP_DB_GCS_OBJECT: '',
      SCHOOL_AGENT_API_KEY: 'test-key', SCHOOL_AGENT_API_URL: `${AUX}/chat`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    aux.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const client = makeClient();
  const deadline = Date.now() + 25000;
  for (;;) {
    try { if ((await client.get('/api/onboarding/status')).res.ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 250));
  }

  await t.test('parse-link reads an activity page as an activity provider', async () => {
    modelReply = JSON.stringify({ name: 'Cedar Valley Dance Studio', city: 'Willow Creek' });
    const out = await client.post('/api/hubs/parse-link', { url: `${AUX}/studio`, kind: 'activity' });
    assert.equal(out.res.status, 200, out.text.slice(0, 300));
    assert.equal(out.data.kind, 'activity');
    assert.deepEqual(out.data.fields, { name: 'Cedar Valley Dance Studio', city: 'Willow Creek' });
    assert.match(lastSystem, /activity provider/, 'the activity prompt, not the school one');
    assert.ok(!/school_name/.test(lastSystem), 'no school fields asked for');
  });

  await t.test('blank model answer: name from the page title, city from the postal address', async () => {
    modelReply = JSON.stringify({ name: '', city: '' });
    const out = await client.post('/api/hubs/parse-link', { url: `${AUX}/studio`, kind: 'activity' });
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.data.fields, { name: 'Cedar Valley Dance Studio', city: 'Willow Creek' });
  });

  await t.test('an activity hub keeps its website', async () => {
    await client.post('/api/profile', {
      parent_name: 'Studio Parent', parent_email: 'studio.parent@example.com', children: [{ name: 'Studio Kid' }],
    });
    const bad = await client.post('/api/hubs', { kind: 'activity', name: 'Cedar Valley Dance Studio — Willow Creek', website: 'not a link' });
    assert.equal(bad.res.status, 400, 'a malformed website is refused, as for schools and teams');
    const made = await client.post('/api/hubs', {
      kind: 'activity', name: 'Cedar Valley Dance Studio — Willow Creek', website: `${AUX}/studio`,
    });
    assert.equal(made.res.status, 200, made.text.slice(0, 300));
    assert.equal(made.data.hub.kind, 'activity');
    const hub = (await client.get(`/api/hubs/${made.data.hub.id}`)).data.hub;
    assert.equal(hub.website, `${AUX}/studio`);
  });
});

function pageFnSource(name) {
  const start = PAGE.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' is defined on the page');
  const open = PAGE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}') {
      depth--;
      if (depth === 0) return PAGE.slice(start, i + 1);
    }
  }
  assert.fail(name + ' body never closes');
}

test('the start-a-hub form shows the website field for an activity', () => {
  const vm = require('node:vm');
  const els = {};
  const el = () => ({ hidden: false, value: '', textContent: '' });
  const sandbox = {
    document: { getElementById(id) { return els[id] || (els[id] = el()); } },
    prefillSchoolLocation() {},
  };
  vm.runInNewContext(pageFnSource('updateHubKindHelp') + ';globalThis.run = updateHubKindHelp;', sandbox);
  const show = (kind) => { els.hubKind = Object.assign(el(), { value: kind }); sandbox.run(); return els; };
  let s = show('activity');
  assert.equal(s.websiteFieldWrap.hidden, false, 'website field shows for an activity');
  assert.equal(s.websiteLabel.textContent, 'Club, studio or program website');
  assert.equal(s.singleNameWrap.hidden, false, 'activity keeps its single name field');
  s = show('other');
  assert.equal(s.websiteFieldWrap.hidden, true, '"Something else" is unchanged');
  s = show('team');
  assert.equal(s.websiteLabel.textContent, 'Team or league website', 'team unchanged');
  assert.ok(PAGE.includes("document.getElementById('hubName').value = f.city ? f.name + ' — ' + f.city : f.name;"),
    'Fill it in names the hub like a school hub: name — city');
  assert.ok(PAGE.includes("hub.kind === 'activity' ? 'Add the activity website'"), 'hub page labels the activity website');
});
