import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { organizationSeed } from '../app/organizations.mjs';
import { countryKey, sourceLocations } from '../app/vacancy-geography.mjs';
import { openPostgresCatalog } from './pg-capacity.mjs';
import { classifyVacancy } from '../app/vacancy-classification.mjs';
const sha = (v) => createHash('sha256').update(v).digest('hex');
async function fixture(t, { unicode = false } = {}) {
  assert.equal(process.env.ROLEMORROW_PG_SYNTHETIC, '1', 'Synthetic marker required');
  const admin = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await admin.connect();
  assert.equal(
    (await admin.query('select current_database() name')).rows[0].name,
    'rolemorrow_synthetic',
  );
  const namespace = 'pgsec_' + randomBytes(8).toString('hex'),
    db = await openPostgresCatalog({
      connectionString: process.env.RM_TEST_PG,
      namespace,
      role: 'operator',
    });
  const collector = new pg.Client({ connectionString: process.env.RM_TEST_PG_COLLECTOR });
  await collector.connect();
  t.after(async () => {
    await collector.end();
    await db.close();
    await admin.query('DROP SCHEMA ' + namespace + ' CASCADE');
    await admin.end();
  });
  const org = {
    ...organizationSeed({
      name: 'Synthetic Security',
      homepage: 'https://security.example',
      careers: 'https://security.example/careers',
      industry: 'Developer infrastructure',
    }),
    createdAt: 1,
    lastAttemptAt: null,
    checkedAt: null,
    observation: null,
  };
  const title = 'Backend Engineer',
    text =
      typeof unicode === 'string'
        ? unicode
        : unicode
          ? 'Python PostgreSQL résumé'
          : 'Python PostgreSQL',
    now = Date.now();
  const row = {
    id: 'vac-security',
    organizationId: org.id,
    identity: org.careers + '/one',
    url: org.careers + '/one',
    companyName: org.name,
    domain: org.domain,
    title,
    text,
    location: 'Portugal',
    facts: { department: 'Engineering', country: 'PT', countries: ['PT'], salary: [] },
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
    sourceHash: sha(JSON.stringify(row)),
    mappingVersion: 'RM-MAP-001-r1',
    organizations: [org],
    vacancies: [row],
    coverage: {},
    schedule: { nextBatchAt: 0 },
  };
  await db.importSnapshot(input);
  const data = (await db.snapshot()).vacancies[0];
  const projected = {
    data,
    labels: { ...data.classification, countryKeys: data.classification.countries.map(countryKey) },
    searchText: [data.title, data.companyName ?? '', data.text, sourceLocations(data).join(' ')]
      .join(' ')
      .toLowerCase(),
    locationText: sourceLocations(data).join(' ').toLowerCase(),
    expiresAt: Date.parse(data.validThrough) + 86400000,
  };
  await db.worker.startRound();
  const claim = await db.worker.claim();
  assert.ok(claim);
  const report = {
    checkedAt: now,
    nextRefreshAt: now + 86400000,
    complete: true,
    knownListings: 1,
    stored: 1,
    truncated: false,
    status: 'checked',
    storageLimited: false,
  };
  const outcome = { status: 'openings-observed', openingCount: 1, sources: [org.careers], ats: [] };
  const publish = (rows = [projected], r = report, o = outcome, p = claim) =>
    collector.query(
      'SELECT ' + namespace + '.publish_turn($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) result',
      [JSON.stringify(p), JSON.stringify(rows), JSON.stringify(r), JSON.stringify(o)],
    );
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
  return { admin, collector, namespace, db, projected, report, outcome, claim, publish, state };
}
test('SCN-PG-SEC-000 well-typed raw collector publication is reachable through actual role', async (t) => {
  const f = await fixture(t);
  const result = await f.publish();
  assert.equal(result.rows[0].result.runId, f.claim.runId);
  assert.equal(result.rows[0].result.published, 1);
});
test('SCN-PG-SEC-001 runtime collector lacks temporary-object privilege and definer has safe temp resolution', async (t) => {
  const f = await fixture(t);
  const canTemp = (
    await f.collector.query(
      "SELECT has_database_privilege(current_user,current_database(),'TEMP') allowed",
    )
  ).rows[0].allowed;
  assert.equal(canTemp, false, 'Collector temporary-table shadowing must be prevented');
  await assert.rejects(
    f.collector.query('CREATE TEMP TABLE control(singleton boolean,paused boolean,epoch bigint)'),
    (e) => e.code === '42501',
  );
  const functions = (
    await f.admin.query(
      'SELECT p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prosecdef',
      [f.namespace],
    )
  ).rows;
  assert.ok(functions.length);
  for (const fn of functions) {
    const path = fn.proconfig?.find((v) => v.startsWith('search_path='));
    assert.ok(
      path?.endsWith('pg_temp'),
      'Definer temp schema must be explicitly last: ' + fn.proname,
    );
  }
});
test('SCN-PG-SEC-002 raw collector rejects nested private objects in scalar public facts atomically', async (t) => {
  const f = await fixture(t),
    before = await f.state();
  f.projected.data.facts.department = { privateCandidateEmail: 'private@example.invalid' };
  await assert.rejects(f.publish());
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-003 raw collector rejects nested private values in typed classification arrays atomically', async (t) => {
  const f = await fixture(t),
    before = await f.state();
  f.projected.data.classification.skills = [{ privateProfile: 'must never publish' }];
  f.projected.labels.skills = f.projected.data.classification.skills;
  await assert.rejects(f.publish());
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-004 raw collector rejects nonboolean coverage and private company source payload atomically', async (t) => {
  const f = await fixture(t),
    before = await f.state();
  await assert.rejects(
    f.publish([f.projected], { ...f.report, complete: { privateCv: 'secret' } }),
  );
  assert.deepEqual(await f.state(), before);
  await assert.rejects(
    f.publish([f.projected], f.report, { ...f.outcome, sources: [{ privateMail: 'secret' }] }),
  );
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-005 required claim epoch cannot be omitted via SQL NULL comparison', async (t) => {
  const f = await fixture(t),
    before = await f.state(),
    claim = { ...f.claim };
  delete claim.epoch;
  await assert.rejects(f.publish([f.projected], f.report, f.outcome, claim));
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-006 required public status and canonical revision cannot be omitted', async (t) => {
  const f = await fixture(t),
    before = await f.state();
  delete f.projected.data.observedStatus;
  delete f.projected.data.canonicalRevision;
  await assert.rejects(f.publish());
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-007 non-ASCII canonical text cannot bypass search projection validation', async (t) => {
  const f = await fixture(t, { unicode: true }),
    before = await f.state();
  f.projected.searchText = 'PRIVATE-CANDIDATE-SECRET-CANARY';
  f.projected.locationText = 'unrelated hidden field';
  await assert.rejects(f.publish());
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-008 raw collector preserves default JS Unicode lower for dotted I, final sigma and supplementary letters', async (t) => {
  const f = await fixture(t, { unicode: 'Python İ ΟΣ ΟΣΑ AΣ\u0301 AΣ\u0301B 𐐀 K résumé' });
  const result = await f.publish();
  assert.equal(result.rows[0].result.published, 1);
  assert.equal((await f.db.vacancies.list({ query: 'résumé' })).matching, 1);
  assert.equal((await f.db.vacancies.list({ query: 'ΟΣ' })).matching, 1);
});
test('SCN-PG-SEC-009 legal label enum cannot assert skill absent canonical source evidence', async (t) => {
  const f = await fixture(t),
    before = await f.state();
  assert.equal(f.projected.data.text.toLowerCase().includes('rust'), false);
  const invented = [...f.projected.data.classification.skills, 'rust'];
  f.projected.data.classification.skills = invented;
  f.projected.labels.skills = invented;
  await assert.rejects(f.publish());
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-010 raw collector rejects source datetime rejected by the locked JS source parser', async (t) => {
  const f = await fixture(t),
    before = await f.state(),
    d = f.projected.data;
  d.publishedAt = '2026-10-20T23:59:60Z';
  assert.equal(Number.isNaN(Date.parse(d.publishedAt)), true);
  const fields = [
    'identity',
    'organizationId',
    'title',
    'text',
    'url',
    'sources',
    'location',
    'facts',
    'publishedAt',
    'validThrough',
    'observedStatus',
    'textTruncated',
    'companyName',
    'domain',
    'industryGroup',
  ];
  const material = Object.fromEntries(fields.map((name) => [name, d[name] ?? null]));
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, sort(v[key])]),
          )
        : v;
  d.canonicalRevision = sha(
    JSON.stringify(
      sort({
        ...material,
        classificationVersion: 2,
        mappingVersion: 'RM-MAP-001-r1',
        revisionSchemaVersion: 1,
      }),
    ),
  );
  await assert.rejects(f.publish());
  assert.deepEqual(await f.state(), before);
});
test('SCN-PG-SEC-011 SQL ISO parser preserves valid JS boundary dates and refuses invalid calendar/time components', async (t) => {
  const f = await fixture(t);
  for (const sample of [
    '0000-01-01',
    '0000-02-29',
    '1960-01-01',
    '2000-02-29',
    '2026-10-20T24:00:00Z',
    '2026-10-20T23:59:59.999+23:59',
    '2026-10-20T00:00:00.1-23:59',
    '9999-12-31T23:59:59.999Z',
  ]) {
    const expected = Date.parse(sample);
    assert.equal(Number.isFinite(expected), true, sample);
    const actual = (
      await f.admin.query('SELECT ' + f.namespace + '.js_date_parse($1) actual', [sample])
    ).rows[0].actual;
    assert.equal(Number(actual), expected, sample);
  }
  for (const sample of [
    '2026-02-29',
    '1900-02-29',
    '2026-10-20T23:59:60Z',
    '2026-10-20T24:00:00.001Z',
    '2026-10-20T12:00:00+24:00',
  ])
    await assert.rejects(
      f.admin.query('SELECT ' + f.namespace + '.js_date_parse($1)', [sample]),
      undefined,
      sample,
    );
});
test('SCN-PG-SEC-012 full SQL classification matches source JS for narrow specialties, ASCII boundaries and Unicode metadata', async (t) => {
  const f = await fixture(t),
    cases = [
      ['Senior Backend Engineer', 'Python PostgreSQL Kubernetes', {}],
      ['Staff Site Reliability Engineer', 'Terraform AWS Linux', {}],
      ['Junior Front-end Web Developer', 'React.js TypeScript', {}],
      ['Principal Machine Learning Engineer', 'PyTorch TensorFlow', {}],
      [
        'Product Manager',
        'Figma analytics',
        { employmentType: 'Part_Time', workplaceType: 'Remote' },
      ],
      [
        'Security Test Engineer',
        'Rust C++ C#',
        { employmentType: 'Contractor', locations: [' Lisbon ', 'Lisbon', 'Porto'] },
      ],
      ['Intern Mobile Engineer', 'Android Java', { employmentTypes: ['Intern', 'Full_Time'] }],
      ['Unknown position', 'éPythoné Kubernetes longſql', {}],
      [
        'Remote Full-time Engineering Lead',
        'Node.js SQL',
        {
          country: '\u00a0PT\u00a0',
          countries: [' PT ', 'Portugal', 'PT'],
          department: '\u2003Engineering\u2003',
          team: '\ufeffAPI\ufeff',
          locations: ['\u00a0Lisbon\u00a0', 'Lisbon'],
        },
      ],
    ];
  for (const [title, text, facts] of cases) {
    const row = { title, text, location: ' Portugal ', facts };
    const expected = classifyVacancy(row);
    const actual = (
      await f.admin.query('SELECT ' + f.namespace + '.derive_classification($1::jsonb) actual', [
        JSON.stringify(row),
      ])
    ).rows[0].actual;
    assert.deepEqual(actual, expected, title);
  }
});
