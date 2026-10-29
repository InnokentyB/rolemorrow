import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalogDatabase } from '../app/catalog-database.mjs';
import { organizationSeed } from '../app/organizations.mjs';
import { migrateSqliteSnapshot } from '../app/postgres-migration.mjs';
async function backup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rm-migration-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await openCatalogDatabase({ file: join(dir, 'working.sqlite') });
  const org = {
    ...organizationSeed({
      name: 'Integrity Synthetic',
      homepage: 'https://integrity.example',
      careers: 'https://integrity.example/careers',
    }),
    createdAt: 1,
    lastAttemptAt: null,
    checkedAt: null,
    observation: null,
  };
  const row = {
    id: 'vac-integrity',
    organizationId: org.id,
    identity: org.careers + '/one',
    url: org.careers + '/one',
    companyName: org.name,
    domain: org.domain,
    title: 'Backend Engineer',
    text: 'Python PostgreSQL',
    location: 'Portugal',
    facts: {
      country: 'PT',
      countries: ['PT'],
      salary: [{ currency: 'EUR', interval: '1 YEAR', min: 80000, max: 100000 }],
    },
    sources: [org.careers],
    industryGroup: org.industryGroup,
    firstSeenAt: 1,
    lastSeenAt: 2,
    checkedAt: 3,
    observedStatus: 'active',
  };
  try {
    await source.write(() => {
      source.putOrganization(org);
      source.putVacancy(row);
      source.putCoverage(org.id, {
        checkedAt: 3,
        nextRefreshAt: 86400003,
        complete: true,
        status: 'checked',
      });
    });
    const file = join(dir, 'consistent.sqlite');
    await source.backup(file);
    return { file, dir };
  } finally {
    await source.close();
  }
}
async function refuses(t, mutate, pattern) {
  const { file } = await backup(t),
    db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=DELETE');
    mutate(db);
  } finally {
    db.close();
  }
  const before = await readFile(file);
  let calls = 0;
  await assert.rejects(
    migrateSqliteSnapshot({
      sourceFile: file,
      targetCatalog: {
        importSnapshot: async () => {
          calls++;
          return {};
        },
      },
    }),
    pattern,
  );
  assert.equal(calls, 0, 'refuse before target write');
  assert.deepEqual(await readFile(file), before, 'source remains unchanged');
}
test('MIG-I01 source SQL name/search projection drift refuses before PostgreSQL', async (t) => {
  await refuses(t, (db) => db.exec("UPDATE organizations SET sort_name='poison'"), /projection/i);
});
test('MIG-I02 normalized salary SQL component drift refuses before PostgreSQL', async (t) => {
  await refuses(t, (db) => db.exec('UPDATE vacancy_salary SET minimum=1'), /salary|projection/i);
});
test('MIG-I03 missing indexed skill label refuses rather than rebuilding away disagreement', async (t) => {
  await refuses(
    t,
    (db) => db.exec("DELETE FROM vacancy_labels WHERE kind='skills' AND value='python'"),
    /label|projection/i,
  );
});
test('MIG-I04 next-refresh projection and unmapped column refuse lossless-migration claim', async (t) => {
  await refuses(
    t,
    (db) => db.exec('UPDATE coverage SET next_refresh_at=1'),
    /eligibility|projection/i,
  );
  await refuses(
    t,
    (db) => db.exec('ALTER TABLE organizations ADD COLUMN private_notes TEXT'),
    /column|projection/i,
  );
});
test('MIG-I05 nonempty sidecar and symlink source are rejected before target access', async (t) => {
  const { file, dir } = await backup(t),
    before = await readFile(file);
  let calls = 0;
  const targetCatalog = {
    importSnapshot: async () => {
      calls++;
      return {};
    },
  };
  await writeFile(file + '-wal', 'unhashed sidecar');
  await assert.rejects(
    migrateSqliteSnapshot({ sourceFile: file, targetCatalog }),
    /standalone|sidecar/i,
  );
  await rm(file + '-wal');
  const alias = join(dir, 'alias.sqlite');
  await symlink(file, alias);
  await assert.rejects(migrateSqliteSnapshot({ sourceFile: alias, targetCatalog }));
  assert.equal(calls, 0);
  assert.deepEqual(await readFile(file), before);
});
