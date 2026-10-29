// Explicit public consistent-backup migration only; never startup or live stores.
import { DatabaseSync } from 'node:sqlite';
import { readFile, lstat, open, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { classifyVacancy, CLASSIFICATION_VERSION } from './vacancy-classification.mjs';
import { classifyIndustry } from './organization-classification.mjs';
import { countryKey, sourceLocations } from './vacancy-geography.mjs';
const DAY = 86400000;
/** @param {import('node:crypto').BinaryLike} value */
const sha = (value) => createHash('sha256').update(value).digest('hex');
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid public source object');
  return /** @type {Record<string,unknown>} */ (value);
}
/** @param {Record<string,unknown>} row @param {string} key @returns {string} */
function string(row, key) {
  if (typeof row[key] !== 'string') throw Error('Invalid source string field: ' + key);
  return /** @type {string} */ (row[key]);
}
/** @param {unknown} value @returns {Record<string,unknown>} */
function jsonObject(value) {
  if (typeof value !== 'string') throw Error('Invalid source JSON encoding');
  return object(JSON.parse(value));
}
/** @param {unknown} actual @param {unknown} expected @param {string} label */
function equal(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw Error('Source projection discrepancy: ' + label);
}
/** @param {DatabaseSync} db */
function validateSchema(db) {
  equal(
    db.prepare('PRAGMA application_id').get()?.application_id,
    1380795201,
    'application identity',
  );
  equal(db.prepare('PRAGMA user_version').get()?.user_version, 1, 'schema version');
  equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok', 'integrity');
  equal(db.prepare('PRAGMA foreign_key_check').all(), [], 'foreign keys');
  const columns = {
    catalog_meta: ['key', 'value'],
    catalog_migrations: ['kind', 'source_path', 'source_hash', 'row_count', 'imported_at'],
    organizations: [
      'id',
      'domain',
      'name',
      'sort_name',
      'search_text',
      'industry',
      'employee_range',
      'employee_asof',
      'last_attempt_at',
      'data',
    ],
    vacancies: [
      'id',
      'organization_id',
      'identity',
      'title',
      'text',
      'search_text',
      'location_text',
      'industry',
      'last_seen_at',
      'checked_at',
      'expires_at',
      'observed_status',
      'data',
    ],
    vacancy_labels: ['vacancy_id', 'kind', 'value'],
    vacancy_salary: ['vacancy_id', 'currency', 'interval', 'minimum', 'maximum'],
    coverage: ['organization_id', 'next_refresh_at', 'data'],
  };
  for (const [table, names] of Object.entries(columns))
    equal(
      db
        .prepare('PRAGMA table_info(' + table + ')')
        .all()
        .map((row) => row.name)
        .sort(),
      [...names].sort(),
      'columns ' + table,
    );
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const name = string(row, 'name');
    if (
      name.startsWith('sqlite_') ||
      Object.hasOwn(columns, name) ||
      /^(organization_search|vacancy_search)(_(data|idx|docsize|config|content))?$/.test(name)
    )
      continue;
    throw Error('Unmapped public source table');
  }
}
/** @param {DatabaseSync} db */
function exportPublic(db) {
  validateSchema(db);
  const meta = db.prepare('SELECT key,value FROM catalog_meta').all();
  for (const row of meta)
    if (!['classificationVersion', 'schedule'].includes(string(row, 'key')))
      throw Error('Unmapped source metadata');
  const classifier = meta.find((row) => row.key === 'classificationVersion');
  equal(
    classifier && JSON.parse(string(classifier, 'value')),
    CLASSIFICATION_VERSION,
    'classification version',
  );
  const organizations = db
    .prepare('SELECT * FROM organizations ORDER BY id')
    .all()
    .map((row) => {
      const data = jsonObject(row.data),
        name = string(data, 'name'),
        domain = string(data, 'domain');
      for (const [column, expected] of /** @type {Array<[string,unknown]>} */ ([
        ['id', data.id],
        ['domain', domain],
        ['name', name],
        ['sort_name', name.toLowerCase()],
        ['search_text', (name + ' ' + domain).toLowerCase()],
        ['industry', data.industryGroup ?? classifyIndustry(data.industry)],
        ['last_attempt_at', data.lastAttemptAt ?? null],
      ]))
        equal(row[column], expected, 'organization ' + column);
      const employees =
        data.employees === null || data.employees === undefined ? null : object(data.employees);
      equal(row.employee_range, employees?.range ?? null, 'employee band');
      equal(
        row.employee_asof,
        employees ? Date.parse(string(employees, 'asOf')) : null,
        'employee evidence date',
      );
      return data;
    });
  const vacancies = db
    .prepare('SELECT * FROM vacancies ORDER BY id')
    .all()
    .map((row) => {
      const data = jsonObject(row.data),
        text = string(row, 'text');
      if (Object.hasOwn(data, 'text')) equal(data.text, text, 'duplicate text evidence');
      /** @type {Record<string,unknown>} */ const out = { ...data, text };
      for (const [column, expected] of /** @type {Array<[string,unknown]>} */ ([
        ['id', out.id],
        ['organization_id', out.organizationId],
        ['identity', out.identity],
        ['title', out.title],
        ['industry', out.industryGroup ?? 'unknown'],
        ['last_seen_at', out.lastSeenAt ?? 0],
        ['checked_at', out.checkedAt ?? 0],
        ['observed_status', out.observedStatus ?? 'unknown'],
      ]))
        equal(row[column], expected, 'vacancy ' + column);
      const labels = classifyVacancy(out);
      equal(out.classification, labels, 'classification evidence');
      const locations = sourceLocations(out).join(' ').toLowerCase();
      equal(row.location_text, locations, 'location text');
      equal(
        row.search_text,
        [out.title, out.companyName ?? '', text, locations].join(' ').toLowerCase(),
        'search text',
      );
      const expiry =
        typeof out.validThrough === 'string'
          ? Date.parse(out.validThrough) + (out.validThrough.length === 10 ? DAY : 0)
          : null;
      equal(row.expires_at, Number.isFinite(expiry) ? expiry : null, 'source expiry');
      const actualLabels = db
        .prepare('SELECT kind,value FROM vacancy_labels WHERE vacancy_id=?')
        .all(string(row, 'id'))
        .map((item) => JSON.stringify([item.kind, item.value]))
        .sort();
      const dimensions = {
        role: labels.roles,
        level: labels.levels,
        workMode: labels.workModes,
        employmentType: labels.employmentTypes,
        skills: labels.skills,
        country: labels.countries.map(countryKey),
      };
      const expectedLabels = Object.entries(dimensions)
        .flatMap(([kind, values]) =>
          [...new Set(values)].map((value) => JSON.stringify([kind, value])),
        )
        .sort();
      equal(actualLabels, expectedLabels, 'search labels');
      const salaryFacts = object(out.facts ?? {}).salary ?? [];
      if (!Array.isArray(salaryFacts)) throw Error('Invalid source salary list');
      const expectedSalary = salaryFacts
        .map((value) => {
          const pay = object(value);
          return JSON.stringify([pay.currency, pay.interval, pay.min, pay.max]);
        })
        .sort();
      const actualSalary = db
        .prepare('SELECT currency,interval,minimum,maximum FROM vacancy_salary WHERE vacancy_id=?')
        .all(string(row, 'id'))
        .map((pay) => JSON.stringify([pay.currency, pay.interval, pay.minimum, pay.maximum]))
        .sort();
      equal(actualSalary, expectedSalary, 'salary components');
      return out;
    });
  const reports = Object.fromEntries(
    db
      .prepare('SELECT organization_id,next_refresh_at,data FROM coverage ORDER BY organization_id')
      .all()
      .map((row) => {
        const report = jsonObject(row.data),
          checked = report.checkedAt ?? 0,
          attempt = report.lastAttemptAt ?? 0;
        if (typeof checked !== 'number' || typeof attempt !== 'number')
          throw Error('Invalid coverage timestamp');
        equal(
          row.next_refresh_at,
          report.nextRefreshAt ?? Math.max(checked, attempt) + DAY,
          'coverage next eligibility',
        );
        return [string(row, 'organization_id'), report];
      }),
  );
  const scheduleRow = meta.find((row) => row.key === 'schedule'),
    schedule = scheduleRow ? jsonObject(scheduleRow.value) : { nextBatchAt: 0 };
  const legacyMigrations = db
    .prepare(
      'SELECT kind,source_path,source_hash,row_count,imported_at FROM catalog_migrations ORDER BY kind',
    )
    .all()
    .map((row) => ({
      kind: row.kind,
      sourceHash: row.source_hash,
      rowCount: row.row_count,
      importedAt: row.imported_at,
      sourceRef: 'sha256:' + sha(string(row, 'source_path')),
    }));
  return { organizations, vacancies, coverage: reports, schedule, legacyMigrations };
}
/** @param {string} sourceFile */
async function rejectSidecars(sourceFile) {
  for (const suffix of ['-wal', '-shm', '-journal'])
    try {
      const info = await lstat(sourceFile + suffix);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 0)
        throw Error('Consistent standalone backup required; source sidecar present');
    } catch (problem) {
      if (problem?.code !== 'ENOENT') throw problem;
    }
}
/**
 * @param {{sourceFile?:string,targetCatalog?:{importSnapshot:(input:Record<string,unknown>)=>Promise<Record<string,unknown>>},maxBytes?:number}} [options]
 */
export async function migrateSqliteSnapshot({
  sourceFile,
  targetCatalog,
  maxBytes = 256 * 1024 * 1024,
} = {}) {
  if (typeof sourceFile !== 'string' || !targetCatalog?.importSnapshot)
    throw Error('Explicit public backup and target catalog required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024)
    throw Error('Invalid migration memory budget');
  await rejectSidecars(sourceFile);
  const handle = await open(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes, identity;
  try {
    identity = await handle.stat();
    if (!identity.isFile() || identity.size > maxBytes)
      throw Error('Bounded regular standalone public backup required');
    bytes = await handle.readFile();
    if (bytes.length !== identity.size) throw Error('Source backup changed while reading');
  } finally {
    await handle.close();
  }
  const sourceHash = sha(bytes),
    directory = await mkdtemp(join(tmpdir(), 'rm-public-migration-')),
    copy = join(directory, 'verified.sqlite');
  async function unchanged() {
    await rejectSidecars(sourceFile);
    const current = await lstat(sourceFile);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.size !== identity.size
    )
      throw Error('Source backup identity changed');
    if (
      sha(await readFile(sourceFile, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })) !==
      sourceHash
    )
      throw Error('Source backup bytes changed; reconciliation required');
  }
  try {
    const staged = await open(copy, 'wx', 0o400);
    try {
      await staged.writeFile(bytes);
      await staged.sync();
    } finally {
      await staged.close();
    }
    const db = new DatabaseSync(copy, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    let snapshot;
    try {
      snapshot = { sourceHash, mappingVersion: 'RM-MAP-001-r1', ...exportPublic(db) };
    } finally {
      db.close();
    }
    equal(sha(await readFile(copy)), sourceHash, 'staged immutable bytes');
    await unchanged();
    const result = await targetCatalog.importSnapshot(snapshot);
    await unchanged();
    return { sourceHash, ...result };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
