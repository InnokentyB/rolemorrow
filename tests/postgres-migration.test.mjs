import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { openCatalogDatabase } from '../app/catalog-database.mjs';
import { organizationSeed } from '../app/organizations.mjs';
import { openPostgresCatalog } from './pg-capacity.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
test('MIG01 consistent SQLite public backup migrates to PostgreSQL preserving IDs, salary, dates, legacy ledger and original bytes; replay idempotent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-pg-migration-')),
    namespace = 'mig_' + randomBytes(8).toString('hex');
  let target, source;
  const admin = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await admin.connect();
  t.after(async () => {
    await source?.close();
    await target?.close();
    await admin.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  source = await openCatalogDatabase({ file: join(directory, 'working.sqlite') });
  const company = {
    ...organizationSeed({
      name: 'Migration Tech',
      homepage: 'https://migration.example',
      careers: 'https://migration.example/careers',
    }),
    createdAt: 1,
    lastAttemptAt: null,
    checkedAt: null,
    observation: null,
  };
  const title = 'Senior Backend Engineer',
    text = 'Python PostgreSQL Kubernetes';
  const row = {
    id: 'vac-original-stable',
    organizationId: company.id,
    identity: company.careers + '/one',
    url: company.careers + '/one',
    title,
    text,
    companyName: company.name,
    domain: company.domain,
    location: 'Portugal',
    facts: {
      country: 'PT',
      countries: ['PT'],
      salary: [{ currency: 'EUR', interval: '1 YEAR', min: 80000, max: 100000 }],
    },
    sources: [company.careers],
    industryGroup: company.industryGroup,
    publishedAt: '2026-10-20',
    validThrough: '2027-12-31',
    firstSeenAt: 1,
    lastSeenAt: 2,
    checkedAt: Date.now(),
    textFetchedAt: Date.now(),
    changedAt: 2,
    observedStatus: 'active',
    textTruncated: false,
    contentHash: sha(title + String.fromCharCode(10) + text),
  };
  await source.write(() => {
    source.putOrganization(company);
    source.putVacancy(row);
    source.setMeta('schedule', { nextBatchAt: 0 });
    source
      .statement(
        'INSERT INTO catalog_migrations(kind,source_path,source_hash,row_count,imported_at) VALUES(?,?,?,?,?)',
      )
      .run('organizations', '/synthetic/public/organizations.json', 'a'.repeat(64), 1, 1);
  });
  const backup = join(directory, 'consistent.sqlite');
  await source.backup(backup);
  await source.close();
  source = null;
  const before = await readFile(backup);
  target = await openPostgresCatalog({
    connectionString: process.env.RM_TEST_PG,
    namespace,
    role: 'operator',
  });
  const { migrateSqliteSnapshot } = await import('../app/postgres-migration.mjs');
  const result = await migrateSqliteSnapshot({ sourceFile: backup, targetCatalog: target });
  assert.equal(result.sourceHash, sha(before));
  const imported = await target.vacancies.get(row.id);
  for (const key of [
    'id',
    'identity',
    'firstSeenAt',
    'lastSeenAt',
    'checkedAt',
    'textFetchedAt',
    'publishedAt',
    'validThrough',
    'text',
    'contentHash',
  ])
    assert.deepEqual(imported[key], row[key]);
  assert.deepEqual(imported.facts.salary, row.facts.salary);
  const snapshot = await target.snapshot();
  assert.equal(snapshot.legacyMigrations[0].kind, 'organizations');
  assert.equal(snapshot.legacyMigrations[0].sourceHash, 'a'.repeat(64));
  assert.equal(snapshot.legacyMigrations[0].rowCount, 1);
  assert.equal(JSON.stringify(snapshot).includes('/synthetic/public'), false);
  await migrateSqliteSnapshot({ sourceFile: backup, targetCatalog: target });
  assert.equal(await target.vacancies.count(), 1);
  assert.deepEqual(await readFile(backup), before);
});
