import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { openPostgresCatalog } from './pg-capacity.mjs';
import { organizationSeed } from '../app/organizations.mjs';
import { createCatalogWorker } from '../app/catalog-worker.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  assert.equal(process.env.ROLEMORROW_PG_SYNTHETIC, '1');
  const admin = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await admin.connect();
  assert.equal(
    (await admin.query('SELECT current_database() name')).rows[0].name,
    'rolemorrow_synthetic',
  );
  const namespace = 'pgbound_' + randomBytes(8).toString('hex'),
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
  const org = {
    ...organizationSeed({
      name: 'Boundary Synthetic',
      homepage: 'https://boundary.example',
      careers: 'https://boundary.example/careers',
      industry: 'Developer tools',
    }),
    createdAt: 1,
    lastAttemptAt: null,
    checkedAt: null,
    observation: null,
  };
  const title = 'Backend Engineer',
    text = 'Python PostgreSQL',
    now = Date.now(),
    row = {
      id: 'vac-boundary',
      organizationId: org.id,
      identity: org.careers + '/one',
      url: org.careers + '/one',
      companyName: org.name,
      domain: org.domain,
      title,
      text,
      location: 'Portugal',
      facts: { country: 'PT', countries: ['PT'], salary: [] },
      sources: [org.careers],
      industryGroup: org.industryGroup,
      publishedAt: '2026-10-20',
      validThrough: '2027-12-31',
      textTruncated: false,
      contentHash: sha(title + '\n' + text),
      firstSeenAt: 1,
      lastSeenAt: 2,
      checkedAt: now,
      textFetchedAt: now,
      changedAt: 2,
      observedStatus: 'active',
    };
  const input = {
    sourceHash: sha(JSON.stringify({ org, row })),
    mappingVersion: 'RM-MAP-001-r1',
    organizations: [org],
    vacancies: [row],
    coverage: {},
  };
  const outcome = {
    postings: [
      {
        url: row.url,
        title,
        text,
        location: row.location,
        facts: { country: 'PT', countries: ['PT'] },
        sources: [org.careers],
      },
    ],
    inventory: { urls: [row.url], sources: [org.careers], complete: true },
    organizationOutcome: {
      status: 'openings-observed',
      openingCount: 1,
      sources: [org.careers],
      ats: [],
    },
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
  return { admin, namespace, db, org, row, input, outcome, state };
}
test('PG-B01 web and collector can read aggregate coverage without reading coordination tokens', async (t) => {
  const f = await fixture(t);
  await f.db.importSnapshot(f.input);
  await f.db.worker.startRound();
  assert.ok(await f.db.worker.claim());
  for (const [role, variable] of [
    ['web', 'RM_TEST_PG_WEB'],
    ['collector', 'RM_TEST_PG_COLLECTOR'],
  ]) {
    const client = await openPostgresCatalog({
      connectionString: process.env[variable],
      namespace: f.namespace,
      role,
    });
    t.after(() => client.close());
    const metadata = await client.collection();
    assert.equal(metadata.mode, 'sequential-rounds');
    assert.equal(metadata.concurrency, 1);
    assert.equal(metadata.remainingInRound, 1);
    assert.equal(JSON.stringify(metadata).includes('leaseToken'), false);
    const raw = new pg.Client({ connectionString: process.env[variable] });
    await raw.connect();
    t.after(() => raw.end());
    for (const table of ['members', 'rounds', 'jobs', 'runs', 'metadata', 'import_stage'])
      await assert.rejects(
        raw.query('SELECT * FROM ' + f.namespace + '.' + table),
        (error) => error.code === '42501',
        role + ' ' + table,
      );
  }
});
test('PG-B02 valid lease does not extend the sixty-second attempt publication deadline', async (t) => {
  const f = await fixture(t);
  await f.db.importSnapshot(f.input);
  await f.db.worker.startRound();
  const claim = await f.db.worker.claim();
  await f.admin.query(
    'UPDATE ' +
      f.namespace +
      ".members SET started_at=clock_timestamp()-interval '61 seconds',lease_until=clock_timestamp()+interval '100 seconds' WHERE run_id=$1",
    [claim.runId],
  );
  const before = await f.state();
  await assert.rejects(f.db.worker.publish(claim, f.outcome), /authority|deadline|expired/i);
  assert.deepEqual(await f.state(), before);
  assert.equal(await f.db.worker.heartbeat(claim), false);
});
test('PG-B03 crossing deadline during publication rolls back vacancy and all coordination changes', async (t) => {
  const f = await fixture(t);
  await f.db.importSnapshot(f.input);
  await f.db.worker.startRound();
  const claim = await f.db.worker.claim();
  await f.admin.query(
    'CREATE FUNCTION ' +
      f.namespace +
      '.slow_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_catalog.pg_sleep(1.5);RETURN NEW;END$$',
  );
  await f.admin.query(
    'CREATE TRIGGER delay_publication BEFORE INSERT OR UPDATE ON ' +
      f.namespace +
      '.vacancies FOR EACH ROW EXECUTE FUNCTION ' +
      f.namespace +
      '.slow_write()',
  );
  await f.admin.query(
    'UPDATE ' +
      f.namespace +
      ".members SET started_at=clock_timestamp()-interval '59 seconds',lease_until=clock_timestamp()+interval '100 seconds' WHERE run_id=$1",
    [claim.runId],
  );
  const before = await f.state();
  await assert.rejects(f.db.worker.publish(claim, f.outcome), /deadline|expired/i);
  assert.deepEqual(await f.state(), before);
});
test('PG-B04 protected legacy ledger survives import, replay and adapter reopen', async (t) => {
  const f = await fixture(t),
    ledger = [
      {
        kind: 'organizations',
        sourceHash: sha('old organizations'),
        rowCount: 1,
        importedAt: 1,
        sourceRef: 'sha256:' + sha('/protected/organization-source.json'),
      },
      { kind: 'vacancies', sourceHash: null, rowCount: 0, importedAt: 2 },
    ];
  const input = { ...f.input, legacyMigrations: ledger };
  await f.db.importSnapshot(input);
  assert.deepEqual((await f.db.snapshot()).legacyMigrations, ledger);
  await f.db.importSnapshot(input);
  const reopened = await openPostgresCatalog({
    connectionString: process.env.RM_TEST_PG,
    namespace: f.namespace,
    role: 'operator',
  });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.snapshot()).legacyMigrations, ledger);
  const before = await f.db.snapshot();
  await assert.rejects(
    f.db.importSnapshot({ ...input, legacyMigrations: [{ ...ledger[0], rowCount: 2 }] }),
  );
  assert.deepEqual(await f.db.snapshot(), before);
});
test('PG-B05 raw legacy paths, unknown ledger fields and duplicate source kinds refuse before publication', async (t) => {
  const f = await fixture(t),
    base = { kind: 'organizations', sourceHash: sha('source'), rowCount: 1, importedAt: 1 };
  for (const legacyMigrations of [
    [{ ...base, source_path: '/home/private/path' }],
    [{ ...base, sourceRef: '/home/private/path' }],
    [base, base],
    [{ ...base, rowCount: -1 }],
  ]) {
    await assert.rejects(f.db.importSnapshot({ ...f.input, legacyMigrations }));
    assert.equal(await f.db.organizations.count(), 0);
    assert.equal(await f.db.vacancies.count(), 0);
  }
});
test('PG-B06 completing an attempt fences an already-in-flight heartbeat from rescheduling', async () => {
  let releaseHeartbeat, heartbeatStarted, inspectDone;
  const begun = new Promise((resolve) => {
      heartbeatStarted = resolve;
    }),
    inspected = new Promise((resolve) => {
      inspectDone = resolve;
    });
  let beats = 0,
    published = 0;
  const catalog = {
    organizations: {
      entries: async () => [{ id: 'org-test', careers: 'https://boundary.example/careers' }],
    },
    worker: {
      startRound: async () => ({ roundId: 'round' }),
      claim: async () => ({ organizationId: 'org-test' }),
      heartbeat: async () => {
        beats++;
        heartbeatStarted();
        if (beats === 1)
          return new Promise((resolve) => {
            releaseHeartbeat = resolve;
          });
        return false;
      },
      publish: async () => {
        published++;
      },
      fail: async () => {
        throw Error('Unexpected failure');
      },
    },
  };
  const worker = createCatalogWorker({
    catalog,
    deadlineMs: 1000,
    heartbeatMs: 1,
    inspect: async () => {
      inspectDone();
      await begun;
      return {
        postings: [],
        inventory: { urls: [], sources: [], complete: false },
        status: 'unknown',
      };
    },
  });
  const running = worker.run();
  await inspected;
  await begun;
  assert.equal((await running).checked, 1);
  assert.equal(published, 1);
  releaseHeartbeat(true);
  await delay(15);
  assert.equal(beats, 1, 'no heartbeat is scheduled after completed attempt');
  worker.stop();
});
