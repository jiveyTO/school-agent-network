const test = require('node:test');
const assert = require('node:assert/strict');

// The durable store's upload and restore budget grows with the database:
// a fixed 30 s upload limit timed out on the 18.8 MB database (revision
// 00084). 30 s plus 10 s per MB, capped at 5 min.
test('durable transfer timeout scales with database size', () => {
  const { durableTransferTimeoutMs } = require('../db');
  const MB = 1024 * 1024;
  assert.equal(durableTransferTimeoutMs(0), 30000);
  assert.equal(durableTransferTimeoutMs(1), 40000, 'any part of a MB counts');
  assert.equal(durableTransferTimeoutMs(12.7 * MB), 160000, 'the 12.7 MB database: 2 min 40 s');
  assert.equal(durableTransferTimeoutMs(18.8 * MB), 220000, 'the 18.8 MB database: 3 min 40 s');
  assert.equal(durableTransferTimeoutMs(500 * MB), 300000, 'capped at 5 min');
  assert.equal(durableTransferTimeoutMs(null), 30000, 'unknown size gets the base budget');
});
