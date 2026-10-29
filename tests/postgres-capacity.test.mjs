// Capacity fault injection uses trusted-operator-only API. Normal setup always
// consumes actual filesystem observation; no fabricated healthy measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { openPostgresCatalog } from '../app/postgres-catalog.mjs';
import { organizationSeed } from '../app/organizations.mjs';
import { readCapacityObservation } from './pg-capacity.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t, { attest = true } = {}) {
  assert.equal(process.env.ROLEMORROW_PG_SYNTHETIC, '1');
  const admin = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await admin.connect();
  assert.equal(
    (await admin.query('SELECT current_database() name')).rows[0].name,
    'rolemorrow_synthetic',
  );
  const namespace = 'pgcap_' + randomBytes(8).toString('hex'),
    db = await openPostgresCatalog({
      connectionString: process.env.RM_TEST_PG,
      namespace,
      role: 'operator',
    });
  t.after(async () => {
    await db.close();
    await admin.query('DROP SCHEMA ' + namespace + ' CASCADE');
    await admin.end();
  });
  const measured = await readCapacityObservation();
  if (attest) await db.attestCapacity(measured);
  const org = {
    ...organizationSeed({
      name: 'Capacity Synthetic',
      homepage: 'https://capacity.example',
      careers: 'https://capacity.example/careers',
    }),
    createdAt: 1,
    lastAttemptAt: null,
    checkedAt: null,
    observation: null,
  };
  const input = {
    sourceHash: sha(JSON.stringify(org)),
    mappingVersion: 'RM-MAP-001-r1',
    organizations: [org],
    vacancies: [],
    coverage: {},
  };
  const state = async () => {
    const result = {};
    for (const table of [
      'organizations',
      'vacancies',
      'coverage',
      'jobs',
      'members',
      'runs',
      'control',
      'import_batches',
      'import_stage',
    ])
      result[table] = (
        await admin.query(
          'SELECT to_jsonb(t) data FROM ' +
            namespace +
            '.' +
            table +
            ' t ORDER BY to_jsonb(t)::text',
        )
      ).rows;
    return result;
  };
  return { admin, namespace, db, org, input, measured, state };
}
test('PG-CAP01 absent observation refuses import, seeds and worker turn without partial writes', async (t) => {
  const f = await fixture(t, { attest: false }),
    before = await f.state();
  assert.equal((await f.db.collection()).capacity.status, 'unavailable');
  await assert.rejects(f.db.importSnapshot(f.input), /capacity/i);
  await assert.rejects(f.db.organizations.importSeeds([f.org]), /capacity/i);
  await assert.rejects(f.db.worker.startRound(), /capacity/i);
  assert.deepEqual(await f.state(), before);
});
test('PG-CAP02 actual observed filesystem values authorize normal seeded publication', async (t) => {
  const f = await fixture(t);
  const status = (await f.db.collection()).capacity.status;
  assert.ok(['ok', 'warning'].includes(status));
  await f.db.importSnapshot(f.input);
  assert.equal(await f.db.organizations.count(), 1);
  await f.db.worker.startRound();
  assert.ok(await f.db.worker.claim());
});
test('PG-CAP03 stale attestation fences every mutating runtime procedure atomically', async (t) => {
  const f = await fixture(t);
  await f.db.importSnapshot(f.input);
  await f.db.worker.startRound();
  const claim = await f.db.worker.claim();
  // Explicit negative fault injection, excluded from periodic observer allowlist.
  await f.db.attestCapacity({ ...f.measured, observedAt: Date.now() - 61000 });
  const before = await f.state(),
    p = JSON.stringify(claim),
    report = {
      checkedAt: Date.now(),
      nextRefreshAt: Date.now() + 86400000,
      complete: false,
      knownListings: 0,
      stored: 0,
      truncated: false,
      status: 'checked',
      storageLimited: false,
    },
    outcome = { status: 'unknown', openingCount: 0, sources: [f.org.careers], ats: [] };
  const queries = [
    ['start_round()', []],
    ['claim_turn()', []],
    ['heartbeat_turn($1::jsonb)', [p]],
    [
      'publish_turn($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb)',
      [p, '[]', JSON.stringify(report), JSON.stringify(outcome)],
    ],
    ['fail_turn($1::jsonb,$2)', [p, 'source-unavailable']],
  ];
  const raw = new pg.Client({ connectionString: process.env.RM_TEST_PG_COLLECTOR });
  await raw.connect();
  t.after(() => raw.end());
  for (const [call, args] of queries) {
    await assert.rejects(raw.query('SELECT ' + f.namespace + '.' + call, args), /capacity/i);
    assert.deepEqual(await f.state(), before);
  }
  await assert.rejects(f.db.organizations.record(f.org.id, { error: 'unavailable' }), /capacity/i);
  assert.deepEqual(await f.state(), before);
});
test('PG-CAP04 exact ninety-percent and emergency reserve thresholds stop writes; warning remains explicit', async (t) => {
  const f = await fixture(t, { attest: false });
  const GiB = 1024 ** 3,
    MiB = 1024 ** 2;
  // Controlled threshold fault injection, not a claim about actual filesystem size.
  for (const metrics of [
    { totalBytes: 10 * GiB, freeBytes: GiB },
    { totalBytes: 2 * GiB, freeBytes: 512 * MiB - 1 },
  ]) {
    await f.db.attestCapacity({ ...f.measured, ...metrics, observedAt: Date.now() });
    const before = await f.state();
    assert.equal((await f.db.collection()).capacity.status, 'unavailable');
    await assert.rejects(f.db.organizations.importSeeds([f.org]), /capacity/i);
    assert.deepEqual(await f.state(), before);
  }
  await f.db.attestCapacity({
    ...f.measured,
    totalBytes: 10 * GiB,
    freeBytes: 2 * GiB,
    observedAt: Date.now(),
  });
  assert.equal((await f.db.collection()).capacity.status, 'warning');
  // Restore truthful observation before exercising the positive mutation path.
  await f.db.attestCapacity(await readCapacityObservation());
  await f.db.organizations.importSeeds([f.org]);
  assert.equal(await f.db.organizations.count(), 1);
});
test('PG-CAP05 collector/web cannot forge attestations; binding/future inputs refuse', async (t) => {
  const f = await fixture(t),
    before = await f.state();
  for (const variable of ['RM_TEST_PG_WEB', 'RM_TEST_PG_COLLECTOR']) {
    const raw = new pg.Client({ connectionString: process.env[variable] });
    await raw.connect();
    t.after(() => raw.end());
    await assert.rejects(
      raw.query('SELECT ' + f.namespace + '.attest_capacity($1::jsonb)', [
        JSON.stringify(f.measured),
      ]),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      raw.query('UPDATE ' + f.namespace + '.control SET capacity_free_bytes=capacity_total_bytes'),
      (error) => error.code === '42501',
    );
  }
  for (const fault of [
    { database: 'wrong_database' },
    { storeId: 'changed-storage' },
    { observedAt: Date.now() + 60000 },
    { freeBytes: f.measured.totalBytes + 1 },
    { privatePath: '/must/not/persist' },
  ])
    await assert.rejects(f.db.attestCapacity({ ...f.measured, ...fault }));
  assert.deepEqual(await f.state(), before);
});
test('PG-CAP06 emergency fencing may pause and rotate, but resume requires fresh capacity', async (t) => {
  const f = await fixture(t, { attest: false });
  await f.db.worker.rotateEpoch();
  const metadata = await f.db.collection();
  assert.equal(metadata.paused, true);
  assert.equal(metadata.capacity.status, 'unavailable');
  const before = await f.state();
  await assert.rejects(f.db.worker.resume(), /capacity/i);
  assert.deepEqual(await f.state(), before);
});
