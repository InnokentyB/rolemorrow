import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { organizationSeed } from '../app/organizations.mjs';

const connectionString = process.env.ROLEMORROW_PG_TEST_URL ?? process.env.RM_TEST_PG;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const observedAt = Date.parse('2026-10-20T12:00:00Z');
const company = (index) => ({
  ...organizationSeed({
    name: 'Synthetic ' + index,
    homepage: 'https://synthetic' + index + '.example',
    careers: 'https://synthetic' + index + '.example/careers',
    industry: 'Developer infrastructure',
  }),
  createdAt: 1,
  lastAttemptAt: null,
  checkedAt: null,
  observation: null,
});
const vacancy = (org, index, extra = {}) => {
  const title = 'Senior Backend Engineer ' + index,
    text = 'Python PostgreSQL Kubernetes résumé %literal _value C++';
  const row = {
    id: 'vac-fixture-' + index,
    organizationId: org.id,
    identity: org.careers + '/' + index,
    url: org.careers + '/' + index,
    companyName: org.name,
    domain: org.domain,
    title,
    text,
    location: 'Lisbon, Portugal',
    facts: {
      department: 'Engineering',
      team: 'API',
      country: 'PT',
      employmentType: 'FullTime',
      workplaceType: 'Remote',
      locations: ['Lisbon, Portugal'],
      countries: ['PT'],
      employmentTypes: [],
      applicantLocations: ['European Union'],
      salary: [{ currency: 'EUR', interval: '1 YEAR', min: 80000, max: 100000 }],
    },
    sources: [org.careers],
    industryGroup: org.industryGroup,
    publishedAt: '2026-10-20',
    validThrough: '2027-12-31',
    textTruncated: false,
    contentHash: hash(title + '\n' + text),
    firstSeenAt: 1,
    lastSeenAt: 2,
    checkedAt: observedAt,
    textFetchedAt: observedAt,
    changedAt: 2,
    observedStatus: 'active',
    ...extra,
  };
  row.contentHash = hash(row.title + '\n' + row.text);
  return row;
};
const snapshot = (organizations, vacancies = []) => ({
  sourceHash: hash(JSON.stringify({ organizations, vacancies })),
  mappingVersion: 'RM-MAP-001-r1',
  organizations,
  vacancies,
  coverage: {},
  schedule: { nextBatchAt: 0 },
});
async function setup(t) {
  assert.equal(
    process.env.ROLEMORROW_PG_SYNTHETIC,
    '1',
    'INFRA: synthetic PostgreSQL marker absent',
  );
  assert.ok(connectionString, 'INFRA: ROLEMORROW_PG_TEST_URL absent');
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const info = await admin.query('SELECT current_database() AS name');
  assert.equal(info.rows[0].name, 'rolemorrow_synthetic', 'INFRA: refusing unexpected database');
  const namespace = 'pgtest_' + randomBytes(8).toString('hex');
  await admin.query('CREATE SCHEMA ' + namespace);
  let module;
  try {
    module = await import('./pg-capacity.mjs');
  } catch (error) {
    await admin.query('DROP SCHEMA ' + namespace + ' CASCADE');
    await admin.end();
    assert.fail(
      'FEATURE_UNAVAILABLE: postgres module not importable; this is NOT behavioral RED: ' +
        error.code,
    );
  }
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await admin.query('DROP SCHEMA ' + namespace + ' CASCADE');
    await admin.end();
  });
  const open = async (role = 'operator', url = connectionString) => {
    const client = await module.openPostgresCatalog({ connectionString: url, namespace, role });
    clients.push(client);
    return client;
  };
  return { db: await open(), open, namespace, admin };
}

test('PG01 migration preserves identity, normalized salary, dates and source metadata; retry is idempotent', async (t) => {
  const { db } = await setup(t),
    org = company(1),
    row = vacancy(org, 1),
    input = snapshot([org], [row]);
  const original = JSON.stringify(input);
  await db.importSnapshot(input);
  const result = await db.vacancies.list({ organizationId: org.id });
  assert.equal(result.matching, 1);
  for (const key of [
    'id',
    'identity',
    'text',
    'firstSeenAt',
    'lastSeenAt',
    'checkedAt',
    'textFetchedAt',
    'publishedAt',
    'validThrough',
    'contentHash',
  ])
    assert.deepEqual(result.vacancies[0][key], row[key], key);
  assert.deepEqual(result.vacancies[0].facts.salary, row.facts.salary);
  assert.equal((await db.organizations.resolve(org)).id, org.id);
  await db.importSnapshot(input);
  assert.equal(await db.vacancies.count(), 1);
  assert.equal(JSON.stringify(input), original, 'migration must not mutate source object');
});

test('PG02 literal Unicode/special-character queries, exact salary units and conjunctive skill semantics', async (t) => {
  const { db } = await setup(t),
    org = company(2),
    a = vacancy(org, 1),
    b = vacancy(org, 2, {
      title: 'Junior Backend Engineer',
      text: 'Rust and SQL',
      facts: { country: 'US', countries: ['US'], locations: ['Boston'], salary: [] },
    });
  await db.importSnapshot(snapshot([org], [a, b]));
  for (const query of ['RÉSUMÉ', '%literal _value', 'C++', 'python kubernetes'])
    assert.equal((await db.vacancies.list({ query })).matching, 1, query);
  assert.equal((await db.vacancies.list({ query: "' OR 1=1 --" })).matching, 0);
  assert.equal((await db.vacancies.list({ skills: 'python,rust', skillMatch: 'any' })).matching, 2);
  assert.equal((await db.vacancies.list({ skills: 'python,rust', skillMatch: 'all' })).matching, 0);
  assert.equal(
    (
      await db.vacancies.list({
        country: 'Portugal',
        salaryMin: '90000',
        currency: 'EUR',
        salaryInterval: '1 YEAR',
      })
    ).matching,
    1,
  );
  assert.equal(
    (await db.vacancies.list({ salaryMin: '90000', currency: 'USD', salaryInterval: '1 YEAR' }))
      .matching,
    0,
  );
  assert.equal(
    (await db.vacancies.list({ salaryMin: '90000', currency: 'EUR', salaryInterval: '1 MONTH' }))
      .matching,
    0,
  );
});

test('PG03 stable tied pages and facets are computed across all matching rows', async (t) => {
  const { db } = await setup(t),
    org = company(3),
    rows = Array.from({ length: 7 }, (_, index) => vacancy(org, index));
  await db.importSnapshot(snapshot([org], rows));
  const first = await db.vacancies.list({ limit: 3 }),
    second = await db.vacancies.list({ limit: 3, offset: first.nextOffset });
  assert.equal(first.matching, 7);
  assert.equal(first.nextOffset, 3);
  assert.equal(second.nextOffset, 6);
  assert.equal(new Set([...first.vacancies, ...second.vacancies].map((row) => row.id)).size, 6);
  assert.deepEqual(
    first.vacancies.map((row) => row.id),
    rows
      .map((row) => row.id)
      .sort()
      .slice(0, 3),
  );
  assert.equal(first.facets.skills.find((row) => row.value === 'python').count, 7);
  assert.equal((await db.vacancies.list({ offset: 6, limit: 3 })).nextOffset, null);
});

test('PG04 duplicate identities and foreign organization fail atomically without publishing a partial batch', async (t) => {
  const { db } = await setup(t),
    org = company(4),
    row = vacancy(org, 1);
  await assert.rejects(db.importSnapshot(snapshot([org], [row, { ...row, id: 'different-id' }])));
  assert.equal(await db.vacancies.count(), 0);
  assert.equal(await db.organizations.count(), 0);
  await assert.rejects(
    db.importSnapshot(snapshot([org], [{ ...row, organizationId: 'missing-org' }])),
  );
  assert.equal(await db.vacancies.count(), 0);
  assert.equal(await db.organizations.count(), 0);
});

test('PG05 unknown/private keys and source-hash drift refuse rather than become public metadata', async (t) => {
  const { db } = await setup(t),
    org = company(5),
    row = vacancy(org, 1);
  await assert.rejects(
    db.importSnapshot(snapshot([{ ...org, privateProfile: 'must never become public' }], [row])),
  );
  assert.equal(await db.organizations.count(), 0);
  const input = snapshot([org], [row]);
  await db.importSnapshot(input);
  const before = await db.snapshot();
  await assert.rejects(
    db.importSnapshot({
      ...input,
      sourceHash: hash('drift'),
      vacancies: [{ ...row, text: 'changed silently' }],
    }),
  );
  assert.deepEqual(await db.snapshot(), before);
});

test('PG06 canonical revision changes for salary/company material facts; legacy text hash stays provenance', async (t) => {
  const first = await setup(t),
    second = await setup(t),
    org = company(6),
    a = vacancy(org, 1);
  await first.db.importSnapshot(snapshot([org], [a]));
  const changed = {
    ...a,
    companyName: 'Renamed evidence',
    industryGroup: 'security',
    facts: {
      ...a.facts,
      salary: [{ currency: 'EUR', interval: '1 YEAR', min: 90000, max: 120000 }],
    },
  };
  await second.db.importSnapshot(snapshot([org], [changed]));
  const left = (await first.db.vacancies.list()).vacancies[0],
    right = (await second.db.vacancies.list()).vacancies[0];
  assert.match(left.canonicalRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(left.canonicalRevision, right.canonicalRevision);
  assert.equal(left.contentHash, right.contentHash);
});

const outcome = (org, index = 10) => ({
  postings: [
    {
      url: org.careers + '/' + index,
      title: 'Senior Backend Engineer',
      text: 'Python and PostgreSQL',
      location: 'Portugal',
      facts: { country: 'PT', countries: ['PT'] },
      sources: [org.careers],
    },
  ],
  inventory: { urls: [org.careers + '/' + index], complete: true, sources: [org.careers] },
  organizationOutcome: {
    status: 'openings-observed',
    openingCount: 1,
    sources: [org.careers],
    ats: [],
  },
});

test('PG07 independent connections cannot claim simultaneous active turns; publication includes organization and coverage', async (t) => {
  const { db, open } = await setup(t),
    org = company(7);
  await db.importSnapshot(snapshot([org]));
  await db.worker.startRound();
  const peer = await open();
  const claims = await Promise.all([db.worker.claim(), peer.worker.claim()]);
  assert.equal(claims.filter(Boolean).length, 1, 'one global collection attempt is permitted');
  const claim = claims.find(Boolean);
  await db.worker.publish(claim, outcome(org));
  assert.equal((await db.vacancies.list({ organizationId: org.id })).matching, 1);
  assert.equal((await db.organizations.resolve(org)).observation.status, 'openings-observed');
  assert.equal((await db.vacancies.list({ organizationId: org.id })).coverage.complete, true);
});

test('PG08 replay is idempotent and pre-rotation worker cannot publish after epoch recovery', async (t) => {
  const { db } = await setup(t),
    org = company(8);
  await db.importSnapshot(snapshot([org]));
  await db.worker.startRound();
  const claim = await db.worker.claim();
  const result = await db.worker.publish(claim, outcome(org));
  assert.deepEqual(await db.worker.publish(claim, outcome(org)), result);
  assert.equal(await db.vacancies.count(), 1);
  const second = await setup(t),
    other = company(9);
  await second.db.importSnapshot(snapshot([other]));
  await second.db.worker.startRound();
  const stale = await second.db.worker.claim();
  await second.db.worker.rotateEpoch();
  const before = await second.db.snapshot();
  await assert.rejects(second.db.worker.publish(stale, outcome(other)));
  assert.deepEqual(
    await second.db.snapshot(),
    before,
    'rejected authority cannot alter catalog/coverage/round',
  );
});

test('PG09 finite cohort progresses before later additions; invalid publication is atomic', async (t) => {
  const { db } = await setup(t),
    a = company(10),
    b = company(11),
    late = company(12);
  await db.importSnapshot(snapshot([a, b]));
  await db.worker.startRound();
  await db.organizations.importSeeds([late]);
  const first = await db.worker.claim();
  assert.notEqual(first.organizationId, late.id);
  const before = await db.snapshot();
  await assert.rejects(
    db.worker.publish(first, {
      ...outcome(first.organizationId === a.id ? a : b),
      postings: [{ url: 'https://127.0.0.1/forbidden', title: 'Invalid', text: 'x', sources: [] }],
    }),
  );
  assert.deepEqual(await db.snapshot(), before);
  await db.worker.fail(first, { category: 'source-unavailable' });
  const next = await db.worker.claim();
  assert.ok(next);
  assert.notEqual(next.organizationId, first.organizationId);
  assert.notEqual(next.organizationId, late.id);
});

test('PG10 actual collector/web credentials cannot bypass public mutation procedures or create objects', async (t) => {
  const { db, namespace } = await setup(t),
    org = company(13);
  await db.importSnapshot(snapshot([org]));
  const before = await db.snapshot();
  for (const [variable, alias] of [
    ['ROLEMORROW_PG_COLLECTOR_URL', 'RM_TEST_PG_COLLECTOR'],
    ['ROLEMORROW_PG_WEB_URL', 'RM_TEST_PG_WEB'],
  ]) {
    const roleConnection = process.env[variable] ?? process.env[alias];
    assert.ok(roleConnection, 'INFRA: least-privilege credentials absent: ' + variable);
    const raw = new pg.Client({ connectionString: roleConnection });
    await raw.connect();
    t.after(() => raw.end());
    const identity = (await raw.query('SELECT current_user AS name')).rows[0].name;
    const properties = (
      await raw.query(
        'SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    assert.equal(properties.rolsuper, false, identity);
    assert.equal(properties.rolcreaterole, false, identity);
    assert.equal(properties.rolcreatedb, false, identity);
    await assert.rejects(
      raw.query('UPDATE ' + namespace + '.organizations SET name=$1 WHERE id=$2', [
        'forbidden overwrite',
        org.id,
      ]),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      raw.query('CREATE TABLE ' + namespace + '.forbidden_table(value text)'),
      (error) => error.code === '42501',
    );
  }
  assert.deepEqual(
    await db.snapshot(),
    before,
    'forbidden role writes leave public state unchanged',
  );
});
