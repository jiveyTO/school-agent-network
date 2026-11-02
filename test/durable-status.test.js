const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../db');

// The boot log must state unambiguously whether the durable store is
// ENGAGED or DISABLED, so a dropped APP_DB_GCS_* var is never silent again.
test('durable store startup line names its ENGAGED/DISABLED state', async (t) => {
  const savedBucket = process.env.APP_DB_GCS_BUCKET;
  const savedObject = process.env.APP_DB_GCS_OBJECT;
  t.after(() => {
    if (savedBucket === undefined) delete process.env.APP_DB_GCS_BUCKET;
    else process.env.APP_DB_GCS_BUCKET = savedBucket;
    if (savedObject === undefined) delete process.env.APP_DB_GCS_OBJECT;
    else process.env.APP_DB_GCS_OBJECT = savedObject;
  });

  delete process.env.APP_DB_GCS_BUCKET;
  delete process.env.APP_DB_GCS_OBJECT;
  assert.equal(store.isDurableStoreEnabled(), false);
  assert.equal(
    store.durableStatusLine(),
    'durable store: DISABLED (APP_DB_GCS_BUCKET not set)'
  );

  process.env.APP_DB_GCS_BUCKET = 'parentloop-data-school-agent-network';
  process.env.APP_DB_GCS_OBJECT = 'app.db';
  assert.equal(store.isDurableStoreEnabled(), true);
  assert.equal(
    store.durableStatusLine(),
    'durable store: ENGAGED (bucket="parentloop-data-school-agent-network" object="app.db")'
  );
});
