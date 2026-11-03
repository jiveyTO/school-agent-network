// Boot keeps the event loop busy until the server is listening. Without
// the hold, libuv can run dry while initDb waits on V8 compiling sql.js's
// WebAssembly; Node then drains V8's task queues, boot continues inside
// that drain and listens, and the process can deadlock in
// NodePlatform::DrainTasks (nodejs/node#54918): it accepts connections but
// never answers and ignores SIGTERM. That hung about 15% of boots under
// parallel load (and the full suite, intermittently). The hang is a timing
// race, so this pins the guard's shape in the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server boot holds the event loop open until it is listening', () => {
  const holdAt = SRC.indexOf('const bootHold = setInterval(');
  const initAt = SRC.indexOf('.initDb()', holdAt);
  const listenAt = SRC.indexOf('server.listen(PORT', initAt);
  const clearAt = SRC.indexOf('clearInterval(bootHold);', listenAt);
  assert.ok(holdAt !== -1, 'a referenced interval is started for boot');
  assert.ok(initAt !== -1 && holdAt < initAt, 'it starts before initDb');
  assert.ok(listenAt !== -1, 'listen follows initDb');
  assert.ok(clearAt !== -1 && clearAt - listenAt < 200, 'it is cleared in the listen callback, once listening');
  assert.ok(!/bootHold\.unref\(\)/.test(SRC), 'the hold stays referenced, or it would not keep the loop alive');
});
