// Brief 017: the evening check quietly absorbs a network drop.
// The run is a read-only computation, so when fetch itself rejects (no HTTP
// response — e.g. Safari "Load failed") the client retries the identical
// request exactly once after ~2s, keeping the wait state up. An HTTP error
// response never retries. Add material and other POSTs stay single-attempt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const HELPER_START = 'async function fetchWithEveningRetry';
const HANDLER_MARKER = "parentRunBtn.addEventListener('click'";
const helperSrc = PAGE.slice(PAGE.indexOf(HELPER_START), PAGE.indexOf(HANDLER_MARKER));

// Load the page's real retry helper with a stubbed fetch/setTimeout pair.
function loadHelper(stubFetch, delays) {
  const sandbox = {
    fetch: stubFetch,
    setTimeout: (cb, ms) => {
      delays.push(ms);
      return setTimeout(cb, 0);
    },
  };
  return vm.runInNewContext(`${helperSrc}\nfetchWithEveningRetry;`, sandbox);
}

function networkError() {
  // What Safari's "Load failed" surfaces as: the fetch promise rejects and
  // no HTTP response exists.
  return new TypeError('Load failed');
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('evening retry helper exists and the evening check uses it exactly once', () => {
  assert.ok(PAGE.includes(HELPER_START), 'retry helper must be defined on the page');
  assert.equal(
    PAGE.split('fetchWithEveningRetry').length - 1,
    2,
    'exactly one definition plus one call site — evening check only'
  );
  const handler = PAGE.slice(PAGE.indexOf(HANDLER_MARKER), PAGE.indexOf(HANDLER_MARKER) + 2600);
  assert.ok(
    handler.includes("fetchWithEveningRetry('/api/parent/run', { method: 'POST' })"),
    'evening check retries the identical POST'
  );
  assert.ok(!helperSrc.includes('parentError'), 'retry itself shows no error card');
  assert.ok(!helperSrc.includes('parentStatus'), 'retry itself writes no new copy');
  assert.ok(!helperSrc.includes('parentDots'), 'retry itself never flickers the wait state');
});

test('retry pause defaults to about two seconds', () => {
  assert.ok(helperSrc.includes('2000'), 'default pause is ~2s');
  const delays = [];
  let attempts = 0;
  const helper = loadHelper(() => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(networkError());
    return Promise.resolve(okResponse({ ok: true }));
  }, delays);
  return helper('/api/parent/run', { method: 'POST' }).then(() => {
    assert.deepEqual(delays, [2000], 'omitted delay waits 2000ms before retrying');
  });
});

test('(a) first fetch rejects, second succeeds → result returned, error card never involved', async () => {
  const calls = [];
  const delays = [];
  const expected = { ok: true, nudges: [{ title: 'Pizza orders due Friday' }] };
  let attempts = 0;
  const helper = loadHelper((url, options) => {
    calls.push([url, JSON.parse(JSON.stringify(options))]);
    attempts += 1;
    if (attempts === 1) return Promise.reject(networkError());
    return Promise.resolve(okResponse(expected));
  }, delays);
  const res = await helper('/api/parent/run', { method: 'POST' }, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), expected);
  assert.equal(calls.length, 2, 'exactly one silent retry');
  assert.deepEqual(calls[0], calls[1], 'retry repeats the identical request');
  assert.equal(delays.length, 1, 'one short pause before the retry');
});

test('(b) both attempts reject → helper rejects after exactly two attempts', async () => {
  const calls = [];
  const delays = [];
  const helper = loadHelper(() => {
    calls.push(1);
    return Promise.reject(networkError());
  }, delays);
  await assert.rejects(helper('/api/parent/run', { method: 'POST' }, 1), /Load failed/);
  assert.equal(calls.length, 2, 'no third attempt');
  assert.equal(delays.length, 1, 'one pause between the two attempts');
});

test('(c) HTTP error response → no auto-retry, returned for the existing error path', async () => {
  const calls = [];
  const delays = [];
  const helper = loadHelper(() => {
    calls.push(1);
    return Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) });
  }, delays);
  const res = await helper('/api/parent/run', { method: 'POST' }, 1);
  assert.equal(res.status, 500);
  assert.equal(calls.length, 1, 'an HTTP response is not a network failure: no retry');
  assert.equal(delays.length, 0, 'no pause when there is nothing to retry');
});

test('first-try success → single attempt, no pause', async () => {
  const calls = [];
  const delays = [];
  const helper = loadHelper(() => {
    calls.push(1);
    return Promise.resolve(okResponse({ ok: true }));
  }, delays);
  const res = await helper('/api/parent/run', { method: 'POST' }, 1);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(delays.length, 0);
});

test('no auto-retry leaks into Add material or other POSTs', () => {
  const addStart = PAGE.indexOf("getElementById('addMaterialBtn')");
  const addHandler = PAGE.slice(addStart, PAGE.indexOf('var pendingInviteLink'));
  assert.ok(!addHandler.includes('fetchWithEveningRetry'), 'Add material never uses the retry helper');
  assert.ok(!addHandler.includes('EveningRetry'), 'Add material has no retry of its own');
  const postJson = PAGE.slice(PAGE.indexOf('async function postJson'), PAGE.indexOf('var skippedPlacementHubs'));
  assert.ok(!postJson.includes('fetchWithEveningRetry'), 'shared postJson stays single-attempt');
  assert.ok(!postJson.includes('setTimeout'), 'shared postJson has no retry pause');
});
