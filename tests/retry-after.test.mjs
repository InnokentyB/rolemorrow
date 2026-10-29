import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { openPostgresCatalog } from './pg-capacity.mjs';
import { organizationSeed } from '../app/organizations.mjs';
import { createCatalogWorker } from '../app/catalog-worker.mjs';
const sha = (v) => createHash('sha256').update(v).digest('hex');
async function setup(t, count = 1) {
  assert.equal(process.env.ROLEMORROW_PG_SYNTHETIC, '1');
  const raw = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await raw.connect();
  assert.equal(
    (await raw.query('SELECT current_database() name')).rows[0].name,
    'rolemorrow_synthetic',
  );
  const namespace = 'retry_' + randomBytes(8).toString('hex');
  const operator = await openPostgresCatalog({
    connectionString: process.env.RM_TEST_PG,
    namespace,
    role: 'operator',
  });
  const orgs = Array.from({ length: count }, (_, i) => ({
    ...organizationSeed({
      name: 'Retry Synthetic ' + i,
      homepage: 'https://retry' + i + '.example',
      careers: 'https://retry' + i + '.example/careers',
    }),
    createdAt: 1,
    lastAttemptAt: null,
    checkedAt: null,
    observation: null,
  }));
  await operator.importSnapshot({
    sourceHash: sha(JSON.stringify(orgs)),
    mappingVersion: 'RM-MAP-001-r1',
    organizations: orgs,
    vacancies: [],
    coverage: {},
  });
  const collector = await openPostgresCatalog({
    connectionString: process.env.RM_TEST_PG_COLLECTOR,
    namespace,
    role: 'collector',
  });
  t.after(async () => {
    await collector.close();
    await operator.close();
    await raw.query('DROP SCHEMA ' + namespace + ' CASCADE');
    await raw.end();
  });
  const claim = async () => {
    await collector.worker.startRound();
    const c = await collector.worker.claim();
    assert.ok(c);
    return c;
  };
  const state = async () => {
    const s = {};
    for (const table of [
      'control',
      'organizations',
      'vacancies',
      'coverage',
      'jobs',
      'members',
      'runs',
    ])
      s[table] = (
        await raw.query(
          'SELECT to_jsonb(t) data FROM ' +
            namespace +
            '.' +
            table +
            ' t ORDER BY to_jsonb(t)::text',
        )
      ).rows;
    return s;
  };
  return { raw, namespace, operator, collector, orgs, claim, state };
}
test('RA01 actual collector respects delta minimum, bounded fallback, and reconnect persistence', async (t) => {
  const f = await setup(t);
  const c = await f.claim();
  const before = Date.now();
  await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: '3600' });
  const eligible = await f.operator.vacancies.nextCheckAt(c.organizationId);
  assert.ok(eligible >= before + 3600000, 'Retry-After minimum is not shortened to 15min');
  const reopened = await openPostgresCatalog({
    connectionString: process.env.RM_TEST_PG,
    namespace: f.namespace,
    role: 'operator',
  });
  t.after(() => reopened.close());
  assert.equal(await reopened.vacancies.nextCheckAt(c.organizationId), eligible);
  assert.equal(await reopened.worker.claim(), null);
  assert.equal(await f.operator.vacancies.count(), 0);
});
test('RA02 strict dates, 24h boundary, malformed/past/malicious hints use database-time backoff', async (t) => {
  const hints = [
    '0',
    '86400',
    '+3600',
    '1.5',
    '-1',
    '3600, 7200',
    'bad',
    '3600\r\nInjected: x',
    '9'.repeat(129),
    "'; DROP TABLE jobs;--",
    new Date(0).toUTCString(),
    'Sun, 31 Feb 2030 12:00:00 GMT',
  ];
  const f = await setup(t, hints.length + 1);
  for (const hint of hints) {
    const c = await f.claim(),
      before = Date.now();
    await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: hint });
    const at = await f.operator.vacancies.nextCheckAt(c.organizationId);
    const seconds = hint === '86400' ? 86400 : 900;
    assert.ok(at >= before + seconds * 1000);
    assert.ok(at < before + seconds * 1000 + 5000);
  }
  const c = await f.claim(),
    deadline = new Date(Date.now() + 7200000).toUTCString();
  await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: deadline });
  const at = await f.operator.vacancies.nextCheckAt(c.organizationId);
  assert.ok(at >= Date.parse(deadline));
  assert.ok(at < Date.parse(deadline) + 1000);
});
test('RA03 excessive hint pauses one source durably, skips its next round, never becomes no-jobs', async (t) => {
  const f = await setup(t, 2),
    c = await f.claim();
  await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: '90000' });
  const status = await f.operator.collection();
  const pause = status.sourcePauses.find((p) => p.organizationId === c.organizationId);
  assert.ok(pause);
  assert.ok(pause.retryAt >= Date.now() + 89990000);
  const other = await f.collector.worker.claim();
  assert.ok(other);
  assert.notEqual(other.organizationId, c.organizationId);
  await f.collector.worker.fail(other, { category: 'source-unavailable' });
  await f.raw.query(
    'UPDATE ' + f.namespace + ".jobs SET eligible_at=clock_timestamp()-interval '1 second'",
  );
  await f.collector.worker.startRound();
  assert.equal(
    (await f.operator.organizations.due()).some((o) => o.id === c.organizationId),
    false,
  );
  assert.equal(await f.operator.vacancies.needsRefresh(c.organizationId), false);
  const next = await f.collector.worker.claim();
  assert.equal(next.organizationId, other.organizationId);
  const reopened = await openPostgresCatalog({
    connectionString: process.env.RM_TEST_PG,
    namespace: f.namespace,
    role: 'operator',
  });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.collection()).sourcePauses, status.sourcePauses);
  assert.equal(
    (await f.operator.snapshot()).coverage[c.organizationId]?.status === 'checked',
    false,
  );
});
test('RA04 terminal error replay is read-only even expired/global pause; forged and rotated claims refuse', async (t) => {
  const f = await setup(t),
    c = await f.claim();
  const answer = await f.collector.worker.fail(c, {
    category: 'source-unavailable',
    retryAfter: '90000',
  });
  await f.raw.query(
    'UPDATE ' + f.namespace + ".members SET lease_until=clock_timestamp()-interval '1 second'",
  );
  await f.raw.query('UPDATE ' + f.namespace + '.control SET paused=true');
  let before = await f.state();
  assert.deepEqual(
    await f.collector.worker.fail(c, { category: 'source-timeout', retryAfter: '0' }),
    answer,
  );
  assert.deepEqual(await f.state(), before);
  for (const forged of [
    {
      ...c,
      leaseToken: randomBytes(16)
        .toString('hex')
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
    },
    { ...c, organizationId: 'foreign-org' },
    { ...c, roundId: '00000000-0000-4000-8000-000000000000' },
  ]) {
    await assert.rejects(
      f.collector.worker.fail(forged, { category: 'source-unavailable', retryAfter: '0' }),
    );
    assert.deepEqual(await f.state(), before);
  }
  await f.raw.query('UPDATE ' + f.namespace + '.control SET epoch=epoch+1');
  before = await f.state();
  await assert.rejects(f.collector.worker.fail(c, { category: 'source-unavailable' }));
  assert.deepEqual(await f.state(), before);
});
test('RA05 resume denied before source deadline and to runtime roles; explicit operator resume clears atomically', async (t) => {
  const f = await setup(t),
    c = await f.claim();
  await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: '90000' });
  const before = await f.state();
  await assert.rejects(f.operator.worker.resumeSource(c.organizationId));
  assert.deepEqual(await f.state(), before);
  await assert.rejects(f.collector.worker.resumeSource(c.organizationId));
  assert.deepEqual(await f.state(), before);
  const rawCollector = new pg.Client({ connectionString: process.env.RM_TEST_PG_COLLECTOR });
  await rawCollector.connect();
  t.after(() => rawCollector.end());
  await assert.rejects(
    rawCollector.query('UPDATE ' + f.namespace + '.jobs SET eligible_at=clock_timestamp()'),
    (e) => e.code === '42501',
  );
  assert.deepEqual(await f.state(), before);
  // Simulated elapsed DB time through operator fixture-only state change; actual resume guard remains SQL.
  await f.raw.query(
    'UPDATE ' +
      f.namespace +
      ".jobs SET source_retry_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1",
    [c.organizationId],
  );
  const at = Date.now();
  await f.operator.worker.resumeSource(c.organizationId);
  assert.equal((await f.operator.collection()).sourcePauses.length, 0);
  assert.ok((await f.operator.vacancies.nextCheckAt(c.organizationId)) >= at);
});
test('RA06 huge representable header pauses without overflow or raw metadata; oversized uses fallback', async (t) => {
  const f = await setup(t, 2),
    c = await f.claim();
  await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: '9'.repeat(128) });
  const pause = (await f.operator.collection()).sourcePauses.find(
    (p) => p.organizationId === c.organizationId,
  );
  assert.ok(pause);
  assert.equal(pause.retryAt, null);
  assert.equal(JSON.stringify(await f.state()).includes('9'.repeat(128)), false);
  const before = await f.state();
  await assert.rejects(f.operator.worker.resumeSource(c.organizationId));
  assert.deepEqual(await f.state(), before);
  const other = await f.claim();
  await f.collector.worker.fail(other, {
    category: 'source-unavailable',
    retryAfter: '9'.repeat(129),
  });
  assert.equal((await f.operator.collection()).sourcePauses.length, 1);
});
test('RA07 failure clock starts after lock wait; transaction interruption rolls back all durable effects', async (t) => {
  const f = await setup(t, 2),
    c = await f.claim();
  const locker = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await locker.connect();
  t.after(() => locker.end());
  await locker.query('BEGIN');
  await locker.query('SELECT * FROM ' + f.namespace + '.control FOR UPDATE');
  const pending = f.collector.worker.fail(c, {
    category: 'source-unavailable',
    retryAfter: '3600',
  });
  await delay(200);
  const released = Date.now();
  await locker.query('COMMIT');
  await pending;
  assert.ok((await f.operator.vacancies.nextCheckAt(c.organizationId)) >= released + 3600000);
  const other = await f.claim();
  await f.raw.query(
    'CREATE FUNCTION ' +
      f.namespace +
      ".interrupt_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic interruption';END$$",
  );
  await f.raw.query(
    'CREATE TRIGGER interrupt_failure BEFORE UPDATE ON ' +
      f.namespace +
      '.jobs FOR EACH ROW EXECUTE FUNCTION ' +
      f.namespace +
      '.interrupt_failure()',
  );
  const before = await f.state();
  await assert.rejects(
    f.collector.worker.fail(other, { category: 'source-unavailable', retryAfter: '90000' }),
    /synthetic interruption/,
  );
  assert.deepEqual(await f.state(), before);
});
test('RA08 inspector Retry-After reaches persistent failure contract without raw error payload', async () => {
  let failure;
  const catalog = {
    organizations: { entries: async () => [{ id: 'org', careers: 'https://retry.example' }] },
    worker: {
      startRound: async () => {},
      claim: async () => ({ organizationId: 'org' }),
      heartbeat: async () => true,
      publish: async () => {
        throw Error('unexpected publish');
      },
      fail: async (c, result) => {
        failure = result;
      },
    },
  };
  const worker = createCatalogWorker({
    catalog,
    inspect: async () => {
      throw Object.assign(new Error('secret untrusted body'), { retryAfter: '3600' });
    },
  });
  const result = await worker.run();
  worker.stop();
  assert.equal(result.failed, 1);
  assert.equal(failure.retryAfter, '3600');
  assert.equal(JSON.stringify(failure).includes('secret'), false);
});

test('RA09 web and collector cannot resume through direct procedure or application API', async (t) => {
  const f = await setup(t),
    c = await f.claim();
  await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: '90000' });
  const before = await f.state();
  for (const [role, key] of [
    ['web', 'RM_TEST_PG_WEB'],
    ['collector', 'RM_TEST_PG_COLLECTOR'],
  ]) {
    const client = await openPostgresCatalog({
      connectionString: process.env[key],
      namespace: f.namespace,
      role,
    });
    t.after(() => client.close());
    await assert.rejects(client.worker.resumeSource(c.organizationId), (e) => e.code === '42501');
    assert.deepEqual(await f.state(), before);
    const raw = new pg.Client({ connectionString: process.env[key] });
    await raw.connect();
    t.after(() => raw.end());
    await assert.rejects(
      raw.query('SELECT ' + f.namespace + '.resume_source($1)', [c.organizationId]),
      (e) => e.code === '42501',
    );
    assert.deepEqual(await f.state(), before);
    assert.equal(
      (await client.collection()).sourcePauses,
      undefined,
      'per-source operator status is not leaked through runtime role',
    );
  }
});
test('RA10 nonterminal expired lease, successful run and global pause refuse failure with unchanged state', async (t) => {
  const f = await setup(t, 3),
    first = await f.claim();
  await f.raw.query(
    'UPDATE ' +
      f.namespace +
      ".members SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1",
    [first.runId],
  );
  let before = await f.state();
  await assert.rejects(
    f.collector.worker.fail(first, { category: 'source-unavailable', retryAfter: '90000' }),
  );
  assert.deepEqual(await f.state(), before);
  // Explicit operator fixture terminates expired member so independent cases continue.
  await f.raw.query('UPDATE ' + f.namespace + ".members SET state='interrupted' WHERE run_id=$1", [
    first.runId,
  ]);
  const second = await f.claim();
  const org = f.orgs.find((o) => o.id === second.organizationId);
  await f.collector.worker.publish(second, {
    postings: [],
    inventory: { urls: [], sources: [org.careers], complete: false },
    organizationOutcome: { status: 'unknown', openingCount: 0, sources: [org.careers], ats: [] },
  });
  before = await f.state();
  await assert.rejects(f.collector.worker.fail(second, { category: 'source-unavailable' }));
  assert.deepEqual(await f.state(), before);
  const third = await f.claim();
  await f.raw.query('UPDATE ' + f.namespace + '.control SET paused=true');
  before = await f.state();
  await assert.rejects(f.collector.worker.fail(third, { category: 'source-unavailable' }));
  assert.deepEqual(await f.state(), before);
});
test('RA11 strict date grammar and outer ASCII OWS preserve source minimum; non-ASCII digits refuse', async (t) => {
  const valid = new Date(Date.now() + 7200000).toUTCString();
  const wrongDay = valid.replace(/^[A-Za-z]{3}/, valid.startsWith('Mon') ? 'Tue' : 'Mon');
  const hints = [
    [' \t3600\t ', 3600],
    ['１２３４', 900],
    [wrongDay, 900],
    ['Sunday, 06-Nov-94 08:49:37 GMT', 900],
    ['Sun Nov  6 08:49:37 2094', 900],
    [valid.replace('GMT', 'UTC'), 900],
    [valid.replace(/:[0-9]{2} GMT$/, ':60 GMT'), 900],
  ];
  const f = await setup(t, hints.length);
  for (const [hint, seconds] of hints) {
    const c = await f.claim(),
      before = Date.now();
    await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: hint });
    const at = await f.operator.vacancies.nextCheckAt(c.organizationId);
    if (seconds !== null) {
      assert.ok(at >= before + seconds * 1000);
      assert.ok(at < before + seconds * 1000 + 5000);
    }
  }
});
test('RA12 clock capture also follows job-row wait, not only control-row wait', async (t) => {
  const f = await setup(t),
    c = await f.claim(),
    locker = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await locker.connect();
  t.after(() => locker.end());
  await locker.query('BEGIN');
  await locker.query('SELECT * FROM ' + f.namespace + '.jobs WHERE organization_id=$1 FOR UPDATE', [
    c.organizationId,
  ]);
  const pending = f.collector.worker.fail(c, {
    category: 'source-unavailable',
    retryAfter: '3600',
  });
  await delay(200);
  const at = Date.now();
  await locker.query('COMMIT');
  await pending;
  assert.ok((await f.operator.vacancies.nextCheckAt(c.organizationId)) >= at + 3600000);
});

test('RA13 terminal replay rejects mismatched durable member identity without changing protected state', async (t) => {
  const f = await setup(t),
    c = await f.claim();
  await f.collector.worker.fail(c, { category: 'source-unavailable', retryAfter: '90000' });
  await f.raw.query(
    'UPDATE ' +
      f.namespace +
      ".members SET lease_token='00000000-0000-4000-8000-000000000001' WHERE run_id=$1",
    [c.runId],
  );
  const before = await f.state();
  await assert.rejects(f.collector.worker.fail(c, { category: 'source-unavailable' }));
  assert.deepEqual(await f.state(), before);
});
