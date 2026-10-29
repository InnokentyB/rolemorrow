// Public catalog only. Private account/workspace data never enters this adapter.
import pg from 'pg';
import { unicodeSql } from './postgres-unicode.mjs';
import { classificationSql } from './postgres-classification.mjs';
import { createHash } from 'node:crypto';
import { organizationSeed, ORGANIZATION_MAX_AGE } from './organizations.mjs';
import {
  classifyVacancy,
  CLASSIFICATION_VERSION,
  normalizeVacancyFacts,
} from './vacancy-classification.mjs';
import { INDUSTRIES, EMPLOYEE_RANGES, classifyIndustry } from './organization-classification.mjs';
import { countryKey, sourceLocations } from './vacancy-geography.mjs';
import { listingIdentity } from './discovery-coverage.mjs';
import { validatePublicUrl } from './network.mjs';
import { pageSize, pageOffset } from './catalog-query.mjs';

const DAY = 86400000,
  MAP = 'RM-MAP-001-r1';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const error = (message, code = 'CATALOG_INVALID') => Object.assign(Error(message), { code });
const requireThat = (condition, message) => {
  if (!condition) throw error(message);
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const encoded = (value) => JSON.stringify(canonical(value));
function keys(value, allowed, where) {
  requireThat(
    value && typeof value === 'object' && !Array.isArray(value),
    where + ' must be an object',
  );
  for (const key of Object.keys(value))
    requireThat(allowed.includes(key), where + ' contains unmapped field ' + key);
}
const finiteInteger = (value, nullable = false) =>
  (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0);
function timestamp(value, nullable = false) {
  requireThat(finiteInteger(value, nullable), 'Invalid catalog timestamp');
  return value;
}
function urls(values, { required = false, max = 20 } = {}) {
  requireThat(
    Array.isArray(values) && values.length <= max && (!required || values.length > 0),
    'Invalid source URL evidence',
  );
  return values.map((value) => {
    requireThat(typeof value === 'string' && value.length <= 4096, 'Invalid source URL');
    return validatePublicUrl(value).href;
  });
}
function date(value) {
  if (value === null || value === undefined) return null;
  requireThat(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'Invalid source date',
  );
  const day = value.slice(0, 10);
  requireThat(
    new Date(Date.parse(day + 'T00:00:00Z')).toISOString().slice(0, 10) === day,
    'Invalid calendar date',
  );
  return value;
}
const bounded = (value, max, where, { empty = true } = {}) => {
  requireThat(
    typeof value === 'string' && value.length <= max && (empty || value.length > 0),
    where + ' is invalid',
  );
  return value;
};
function organization(value) {
  keys(
    value,
    [
      'id',
      'domain',
      'name',
      'homepage',
      'careers',
      'industry',
      'industryGroup',
      'employees',
      'provenance',
      'createdAt',
      'lastAttemptAt',
      'checkedAt',
      'lastError',
      'observation',
    ],
    'organization',
  );
  for (const field of ['id', 'domain', 'name', 'homepage', 'careers'])
    bounded(value[field], field === 'name' ? 100 : 4096, field, { empty: false });
  const seed = organizationSeed({
    name: value.name,
    homepage: value.homepage,
    careers: value.careers,
    industry: value.industry ?? '',
    employees: value.employees,
  });
  requireThat(value.domain === seed.domain, 'Organization domain mismatch');
  const out = structuredClone(value);
  out.industry ??= '';
  out.industryGroup ??= classifyIndustry(out.industry);
  requireThat(Object.hasOwn(INDUSTRIES, out.industryGroup), 'Unknown industry');
  if (out.employees) {
    keys(out.employees, ['count', 'range', 'asOf', 'reviewedAt', 'source'], 'employees');
    requireThat(out.employees.range === seed.employees.range, 'Employee range mismatch');
    date(out.employees.asOf);
    date(out.employees.reviewedAt);
  }
  if (out.provenance) {
    keys(out.provenance, ['kind', 'url', 'careersUrl'], 'provenance');
    requireThat(
      ['operator-reviewed-public-source', 'public-website-linked-careers'].includes(
        out.provenance.kind,
      ),
      'Unknown company provenance',
    );
    validatePublicUrl(out.provenance.url);
    if (out.provenance.careersUrl) validatePublicUrl(out.provenance.careersUrl);
  }
  for (const field of ['createdAt', 'lastAttemptAt', 'checkedAt'])
    if (out[field] !== undefined) timestamp(out[field], true);
  if (out.lastError !== undefined && out.lastError !== null)
    bounded(out.lastError, 120, 'lastError');
  if (out.observation) observation(out.observation);
  return out;
}
function observation(value) {
  keys(value, ['status', 'openingCount', 'sources', 'ats'], 'organization observation');
  requireThat(
    ['openings-observed', 'no-openings-observed', 'unknown'].includes(value.status),
    'Invalid company status',
  );
  requireThat(
    Number.isSafeInteger(value.openingCount) &&
      value.openingCount >= 0 &&
      value.openingCount <= 100000,
    'Invalid opening count',
  );
  urls(value.sources);
  if (value.ats) urls(value.ats, { max: 10 });
  return value;
}
function facts(value = {}) {
  keys(
    value,
    [
      'department',
      'team',
      'country',
      'employmentType',
      'workplaceType',
      'salary',
      'locations',
      'countries',
      'employmentTypes',
      'applicantLocations',
    ],
    'facts',
  );
  for (const field of ['department', 'team', 'country', 'employmentType', 'workplaceType'])
    if (value[field] !== undefined) bounded(value[field], 300, 'facts.' + field);
  for (const field of ['locations', 'countries', 'employmentTypes', 'applicantLocations'])
    if (value[field] !== undefined) {
      requireThat(Array.isArray(value[field]) && value[field].length <= 20, 'Invalid facts array');
      for (const item of value[field]) bounded(item, 300, 'facts.' + field, { empty: false });
    }
  if (value.salary !== undefined) {
    requireThat(Array.isArray(value.salary) && value.salary.length <= 20, 'Invalid salary list');
    for (const salary of value.salary) {
      keys(salary, ['currency', 'interval', 'min', 'max'], 'salary');
      requireThat(
        /^[A-Z]{3}$/.test(salary.currency) &&
          ['1 YEAR', '1 MONTH', '1 HOUR'].includes(salary.interval) &&
          Number.isFinite(salary.min) &&
          salary.min >= 0 &&
          Number.isFinite(salary.max) &&
          salary.max >= salary.min,
        'Invalid normalized salary',
      );
    }
  }
  return structuredClone(value);
}
function revision(row) {
  const names = [
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
  const material = Object.fromEntries(names.map((name) => [name, row[name] ?? null]));
  return sha(
    encoded({
      ...material,
      classificationVersion: CLASSIFICATION_VERSION,
      mappingVersion: MAP,
      revisionSchemaVersion: 1,
    }),
  );
}
function vacancy(value) {
  keys(
    value,
    [
      'id',
      'organizationId',
      'identity',
      'url',
      'companyName',
      'domain',
      'title',
      'text',
      'location',
      'facts',
      'sources',
      'industryGroup',
      'publishedAt',
      'validThrough',
      'textTruncated',
      'contentHash',
      'firstSeenAt',
      'lastSeenAt',
      'checkedAt',
      'textFetchedAt',
      'changedAt',
      'observedStatus',
      'classification',
      'canonicalRevision',
    ],
    'vacancy',
  );
  for (const field of ['id', 'organizationId', 'identity', 'title', 'text'])
    bounded(value[field], field === 'title' ? 200 : field === 'text' ? 10000 : 4096, field, {
      empty: false,
    });
  const out = structuredClone(value);
  validatePublicUrl(out.identity);
  out.url = validatePublicUrl(out.url).href;
  out.sources = urls(out.sources, { required: true });
  out.facts = facts(out.facts ?? {});
  out.location ??= '';
  bounded(out.location, 300, 'location');
  for (const field of ['companyName', 'domain'])
    if (out[field] !== undefined) bounded(out[field], field === 'companyName' ? 100 : 4096, field);
  out.publishedAt = date(out.publishedAt);
  out.validThrough = date(out.validThrough);
  out.industryGroup ??= 'unknown';
  requireThat(Object.hasOwn(INDUSTRIES, out.industryGroup), 'Invalid vacancy industry');
  if (out.textTruncated !== undefined)
    requireThat(typeof out.textTruncated === 'boolean', 'Invalid excerpt flag');
  for (const field of ['firstSeenAt', 'lastSeenAt', 'checkedAt', 'textFetchedAt', 'changedAt'])
    if (out[field] !== undefined) timestamp(out[field], true);
  requireThat(
    ['active', 'not-listed', 'unknown', 'unavailable'].includes(out.observedStatus),
    'Invalid observed status',
  );
  const expected = sha(out.title + '\n' + out.text);
  if (out.contentHash !== undefined)
    requireThat(out.contentHash === expected, 'Vacancy content hash mismatch');
  else out.contentHash = expected;
  if (out.classification) {
    keys(
      out.classification,
      [
        'version',
        'roles',
        'levels',
        'workModes',
        'employmentTypes',
        'skills',
        'department',
        'team',
        'country',
        'countries',
        'locations',
        'basis',
      ],
      'classification',
    );
    requireThat(
      out.classification.version === CLASSIFICATION_VERSION,
      'Unsupported classification version',
    );
  }
  out.classification = classifyVacancy(out);
  out.canonicalRevision = revision(out);
  return out;
}
function projection(row) {
  return {
    data: row,
    labels: { ...row.classification, countryKeys: row.classification.countries.map(countryKey) },
    searchText: [row.title, row.companyName ?? '', row.text, sourceLocations(row).join(' ')]
      .join(' ')
      .toLowerCase(),
    locationText: sourceLocations(row).join(' ').toLowerCase(),
    expiresAt: row.validThrough
      ? Date.parse(row.validThrough) + (row.validThrough.length === 10 ? DAY : 0)
      : null,
  };
}
function coverage(value) {
  keys(
    value,
    [
      'checkedAt',
      'lastAttemptAt',
      'nextRefreshAt',
      'complete',
      'knownListings',
      'stored',
      'truncated',
      'status',
      'storageLimited',
    ],
    'coverage',
  );
  for (const field of ['checkedAt', 'lastAttemptAt', 'nextRefreshAt'])
    if (value[field] !== undefined) timestamp(value[field]);
  for (const field of ['knownListings', 'stored'])
    if (value[field] !== undefined)
      requireThat(
        Number.isSafeInteger(value[field]) && value[field] >= 0,
        'Invalid coverage count',
      );
  for (const field of ['complete', 'truncated', 'storageLimited'])
    if (value[field] !== undefined)
      requireThat(typeof value[field] === 'boolean', 'Invalid coverage flag');
  if (value.status !== undefined)
    requireThat(
      ['checked', 'unavailable', 'unknown'].includes(value.status),
      'Invalid coverage status',
    );
  return value;
}

function legacyLedger(value = []) {
  requireThat(Array.isArray(value) && value.length <= 2, 'Invalid legacy migration ledger');
  const kinds = new Set();
  for (const item of value) {
    keys(item, ['kind', 'sourceHash', 'rowCount', 'importedAt', 'sourceRef'], 'legacy migration');
    requireThat(
      ['organizations', 'vacancies'].includes(item.kind) && !kinds.has(item.kind),
      'Invalid legacy migration kind',
    );
    kinds.add(item.kind);
    requireThat(
      item.sourceHash === null ||
        (typeof item.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(item.sourceHash)),
      'Invalid legacy migration source hash',
    );
    requireThat(
      Number.isSafeInteger(item.rowCount) && item.rowCount >= 0,
      'Invalid legacy migration count',
    );
    timestamp(item.importedAt);
    if (item.sourceRef !== undefined)
      requireThat(
        typeof item.sourceRef === 'string' && /^sha256:[a-f0-9]{64}$/.test(item.sourceRef),
        'Invalid protected source reference',
      );
  }
  return structuredClone(value);
}

const tokenValues = (value) =>
  (Array.isArray(value)
    ? value
    : String(value ?? '')
        .slice(0, 1000)
        .split(',')
  )
    .slice(0, 30)
    .map((item) => String(item).trim().slice(0, 100).toLowerCase())
    .filter(Boolean);

function schemaSql(s) {
  return `
CREATE TABLE IF NOT EXISTS ${s}.control(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),schema_version integer NOT NULL,epoch bigint NOT NULL DEFAULT 1,paused boolean NOT NULL DEFAULT false,active_batch text NOT NULL,capacity_observed_at timestamptz,capacity_total_bytes bigint,capacity_free_bytes bigint,capacity_store_id text);
INSERT INTO ${s}.control(singleton,schema_version,active_batch) VALUES(true,1,'empty') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${s}.organizations(id text PRIMARY KEY,domain text UNIQUE NOT NULL,name text NOT NULL,sort_name text NOT NULL,industry text NOT NULL,data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'));
CREATE INDEX IF NOT EXISTS organization_sort ON ${s}.organizations(sort_name COLLATE "C",id COLLATE "C");
CREATE TABLE IF NOT EXISTS ${s}.vacancies(id text PRIMARY KEY,organization_id text NOT NULL REFERENCES ${s}.organizations(id),identity text NOT NULL,data jsonb NOT NULL,labels jsonb NOT NULL,search_text text NOT NULL,location_text text NOT NULL,last_seen_at bigint NOT NULL,checked_at bigint NOT NULL,expires_at bigint,UNIQUE(organization_id,identity));
CREATE INDEX IF NOT EXISTS vacancy_order ON ${s}.vacancies(last_seen_at DESC,id COLLATE "C");
CREATE INDEX IF NOT EXISTS vacancy_org ON ${s}.vacancies(organization_id,last_seen_at DESC,id COLLATE "C");
CREATE TABLE IF NOT EXISTS ${s}.coverage(organization_id text PRIMARY KEY REFERENCES ${s}.organizations(id),data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS ${s}.jobs(organization_id text PRIMARY KEY REFERENCES ${s}.organizations(id),eligible_at timestamptz NOT NULL DEFAULT clock_timestamp(),consecutive_failures integer NOT NULL DEFAULT 0);
ALTER TABLE ${s}.jobs ADD COLUMN IF NOT EXISTS source_pause_reason text;
ALTER TABLE ${s}.jobs ADD COLUMN IF NOT EXISTS source_retry_at timestamptz;
CREATE TABLE IF NOT EXISTS ${s}.rounds(id uuid PRIMARY KEY,state text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS ${s}.members(round_id uuid NOT NULL REFERENCES ${s}.rounds(id),organization_id text NOT NULL REFERENCES ${s}.organizations(id),state text NOT NULL DEFAULT 'pending',claim_count integer NOT NULL DEFAULT 0,run_id uuid,lease_token uuid,lease_until timestamptz,started_at timestamptz,PRIMARY KEY(round_id,organization_id));
CREATE TABLE IF NOT EXISTS ${s}.runs(id uuid PRIMARY KEY,round_id uuid NOT NULL,organization_id text NOT NULL,epoch bigint NOT NULL,lease_token uuid NOT NULL,state text NOT NULL,result jsonb);
CREATE TABLE IF NOT EXISTS ${s}.import_batches(source_hash text NOT NULL,mapping_version text NOT NULL,state text NOT NULL,manifest_hash text NOT NULL,PRIMARY KEY(source_hash,mapping_version));
CREATE TABLE IF NOT EXISTS ${s}.import_stage(batch text NOT NULL,kind text NOT NULL,id text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(batch,kind,id));
CREATE TABLE IF NOT EXISTS ${s}.metadata(key text PRIMARY KEY,value jsonb NOT NULL);
INSERT INTO ${s}.metadata(key,value) VALUES('retryAfterRevision','1'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC,rm_web,rm_collector;
GRANT USAGE ON SCHEMA ${s} TO rm_web,rm_collector,rm_catalog_owner;
GRANT CREATE ON SCHEMA ${s} TO rm_catalog_owner;
GRANT SELECT ON ${s}.organizations,${s}.vacancies,${s}.coverage,${s}.control TO rm_web,rm_collector;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${s} TO rm_catalog_owner;

${unicodeSql(s)}
${classificationSql(s)}
CREATE OR REPLACE FUNCTION ${s}.assert_object(v jsonb,allowed text[],required text[],label text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid object: %',label;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE NOT(k=ANY(allowed))) OR EXISTS(SELECT 1 FROM unnest(required) k WHERE NOT(v?k) OR v->k='null'::jsonb) THEN RAISE EXCEPTION 'Invalid fields: %',label;END IF;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.utf16_length(v text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,${s},pg_temp AS $guard$
 SELECT CASE WHEN length(v)=octet_length(v) THEN length(v) ELSE coalesce((SELECT sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END)::integer FROM regexp_split_to_table(v,'') AS chars(ch)),0) END
$guard$;
CREATE OR REPLACE FUNCTION ${s}.assert_string(v jsonb,minimum integer,maximum integer,label text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR ${s}.utf16_length(v#>>'{}') NOT BETWEEN minimum AND maximum THEN RAISE EXCEPTION 'Invalid string: %',label;END IF;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.assert_number(v jsonb,minimum numeric,maximum numeric,integral boolean,label text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE n numeric;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid number: %',label;END IF;
 n:=(v#>>'{}')::numeric;
 IF n<minimum OR n>maximum OR integral AND n<>trunc(n) THEN RAISE EXCEPTION 'Invalid numeric bounds: %',label;END IF;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.assert_boolean(v jsonb,label text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
BEGIN IF jsonb_typeof(v) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid boolean: %',label;END IF;END $guard$;
CREATE OR REPLACE FUNCTION ${s}.assert_strings(v jsonb,minimum integer,maximum integer,width integer,allowed text[],label text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid string list: %',label;END IF;
 IF jsonb_array_length(v) NOT BETWEEN minimum AND maximum THEN RAISE EXCEPTION 'Invalid list length: %',label;END IF;
 FOR item IN SELECT element.value FROM jsonb_array_elements(v) AS element(value) LOOP
  PERFORM ${s}.assert_string(item,1,width,label);
  IF allowed IS NOT NULL AND NOT((item#>>'{}')=ANY(allowed)) THEN RAISE EXCEPTION 'Invalid enumeration: %',label;END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(v))<>(SELECT count(DISTINCT element.value) FROM jsonb_array_elements(v) AS element(value)) THEN RAISE EXCEPTION 'Duplicate list item: %',label;END IF;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.assert_url(v jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE target text;host text;
BEGIN
 PERFORM ${s}.assert_string(v,1,4096,'public source URL');target:=v#>>'{}';
 IF target !~ '^https://[a-z0-9][a-z0-9.-]*\\.[a-z][a-z0-9-]*(?::443)?(?:/|$)' OR target~'[[:space:][:cntrl:]]' THEN RAISE EXCEPTION 'Invalid public source URL';END IF;
 host:=split_part(split_part(substr(target,9),'/',1),':',1);
 IF host~'(^|\\.)(localhost|local|internal|invalid)$' OR host~'\\.\\.' THEN RAISE EXCEPTION 'Restricted public source URL';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.assert_urls(v jsonb,minimum integer,maximum integer) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid source URL list';END IF;
 IF jsonb_array_length(v) NOT BETWEEN minimum AND maximum THEN RAISE EXCEPTION 'Invalid source count';END IF;
 FOR item IN SELECT element.value FROM jsonb_array_elements(v) AS element(value) LOOP PERFORM ${s}.assert_url(item);END LOOP;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.assert_date(v jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN;END IF;
 PERFORM ${s}.assert_string(v,10,35,'source date');PERFORM ${s}.js_date_parse(v#>>'{}');
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.canonical_json(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE result text;n numeric;raw text;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(entry.key)::text||':'||${s}.canonical_json(entry.value),',' ORDER BY entry.key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v) AS entry(key,value);RETURN result;
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(${s}.canonical_json(a.value),',' ORDER BY a.ordinal),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY a(value,ordinal);RETURN result;
 WHEN 'number' THEN
  n:=(v#>>'{}')::numeric;
  IF n=0 THEN RETURN '0';END IF;
  IF abs(n)>=0.000001 AND abs(n)<1000000000000000000000 THEN RETURN trim_scale(n)::text;END IF;
  raw:=(n::double precision)::text;raw:=regexp_replace(raw,'e([+-])0+','e\\1');RETURN raw;
 ELSE RETURN v::text;
 END CASE;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.country_key(v text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
 SELECT CASE WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['pt','prt','portugal']) THEN 'pt' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['es','esp','spain']) THEN 'es' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['de','deu','germany']) THEN 'de' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['us','usa','united states','united states of america']) THEN 'us' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['gb','gbr','uk','united kingdom']) THEN 'gb' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['fr','fra','france']) THEN 'fr' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['nl','nld','netherlands']) THEN 'nl' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['ie','irl','ireland']) THEN 'ie' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['it','ita','italy']) THEN 'it' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['ca','can','canada']) THEN 'ca' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['au','aus','australia']) THEN 'au' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['nz','nzl','new zealand']) THEN 'nz' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['in','ind','india']) THEN 'in' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['pl','pol','poland']) THEN 'pl' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['se','swe','sweden']) THEN 'se' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['no','nor','norway']) THEN 'no' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['dk','dnk','denmark']) THEN 'dk' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['fi','fin','finland']) THEN 'fi' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['ch','che','switzerland']) THEN 'ch' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['at','aut','austria']) THEN 'at' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['be','bel','belgium']) THEN 'be' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['br','bra','brazil']) THEN 'br' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['mx','mex','mexico']) THEN 'mx' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['sg','sgp','singapore']) THEN 'sg' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['jp','jpn','japan']) THEN 'jp' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['kr','kor','south korea']) THEN 'kr' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['cz','cze','czechia','czech republic']) THEN 'cz' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['ro','rou','romania']) THEN 'ro' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['ee','est','estonia']) THEN 'ee' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['lt','ltu','lithuania']) THEN 'lt' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['lv','lva','latvia']) THEN 'lv' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['il','isr','israel']) THEN 'il' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['ae','are','united arab emirates']) THEN 'ae' WHEN ${s}.js_lower(${s}.js_trim_slice(v,100))=ANY(ARRAY['za','zaf','south africa']) THEN 'za' ELSE ${s}.js_lower(${s}.js_trim_slice(v,100)) END
$guard$;
CREATE OR REPLACE FUNCTION ${s}.validate_claim(p jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE field text;
BEGIN
 PERFORM ${s}.assert_object(p,ARRAY['runId','roundId','organizationId','leaseToken','epoch'],ARRAY['runId','roundId','organizationId','leaseToken','epoch'],'claim');
 FOREACH field IN ARRAY ARRAY['runId','roundId','leaseToken'] LOOP PERFORM ${s}.assert_string(p->field,36,36,'claim UUID');PERFORM (p->>field)::uuid;END LOOP;
 PERFORM ${s}.assert_string(p->'organizationId',1,4096,'claim organization');PERFORM ${s}.assert_number(p->'epoch',1,9007199254740991,true,'claim epoch');
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.validate_publication(x jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE d jsonb;f jsonb;c jsonb;pay jsonb;field text;material jsonb;expected_labels jsonb;country_keys jsonb;locations jsonb;expected_expiry bigint;
BEGIN
 PERFORM ${s}.assert_object(x,ARRAY['data','labels','searchText','locationText','expiresAt'],ARRAY['data','labels','searchText','locationText'],'projection');d:=x->'data';
 PERFORM ${s}.assert_object(d,ARRAY['id','organizationId','identity','url','companyName','domain','title','text','location','facts','sources','industryGroup','publishedAt','validThrough','textTruncated','contentHash','firstSeenAt','lastSeenAt','checkedAt','textFetchedAt','changedAt','observedStatus','classification','canonicalRevision'],ARRAY['id','organizationId','identity','url','title','text','location','facts','sources','industryGroup','observedStatus','classification','contentHash','canonicalRevision'],'public vacancy');
 FOREACH field IN ARRAY ARRAY['id','organizationId','identity'] LOOP PERFORM ${s}.assert_string(d->field,1,4096,'vacancy identity');END LOOP;
 PERFORM ${s}.assert_string(d->'title',1,200,'vacancy title');PERFORM ${s}.assert_string(d->'text',1,10000,'vacancy excerpt');PERFORM ${s}.assert_string(d->'location',0,300,'vacancy location');
 IF d?'companyName' THEN PERFORM ${s}.assert_string(d->'companyName',0,100,'company name');END IF;
 IF d?'domain' THEN PERFORM ${s}.assert_string(d->'domain',0,4096,'company domain');END IF;
 PERFORM ${s}.assert_url(d->'url');PERFORM ${s}.assert_url(d->'identity');PERFORM ${s}.assert_urls(d->'sources',1,20);
 PERFORM ${s}.assert_string(d->'industryGroup',1,32,'industry');IF d->>'industryGroup' NOT IN ('ai','cloud','data','developer','security','design','business','fintech','commerce','media','hardware','unknown') THEN RAISE EXCEPTION 'Invalid industry';END IF;
 PERFORM ${s}.assert_date(d->'publishedAt');PERFORM ${s}.assert_date(d->'validThrough');IF d?'textTruncated' THEN PERFORM ${s}.assert_boolean(d->'textTruncated','excerpt truncation');END IF;
 FOREACH field IN ARRAY ARRAY['firstSeenAt','lastSeenAt','checkedAt','textFetchedAt','changedAt'] LOOP IF d?field AND d->field<>'null'::jsonb THEN PERFORM ${s}.assert_number(d->field,0,9007199254740991,true,'vacancy timestamp');END IF;END LOOP;
 PERFORM ${s}.assert_string(d->'observedStatus',1,20,'vacancy status');IF d->>'observedStatus' NOT IN ('active','not-listed','unknown','unavailable') THEN RAISE EXCEPTION 'Invalid status';END IF;
 PERFORM ${s}.assert_string(d->'contentHash',64,64,'content hash');PERFORM ${s}.assert_string(d->'canonicalRevision',64,64,'canonical revision');IF d->>'contentHash' !~ '^[a-f0-9]{64}$' OR d->>'canonicalRevision' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid revision encoding';END IF;
 IF d->>'contentHash'<>encode(sha256(convert_to((d->>'title')||E'\\n'||(d->>'text'),'UTF8')),'hex') THEN RAISE EXCEPTION 'Title/excerpt hash mismatch';END IF;
 f:=d->'facts';PERFORM ${s}.assert_object(f,ARRAY['department','team','country','employmentType','workplaceType','salary','locations','countries','employmentTypes','applicantLocations'],ARRAY[]::text[],'public facts');
 FOREACH field IN ARRAY ARRAY['department','team','country','employmentType','workplaceType'] LOOP IF f?field THEN PERFORM ${s}.assert_string(f->field,0,300,'fact scalar');END IF;END LOOP;
 FOREACH field IN ARRAY ARRAY['locations','countries','employmentTypes','applicantLocations'] LOOP IF f?field THEN PERFORM ${s}.assert_strings(f->field,0,20,300,NULL,'fact list');END IF;END LOOP;
 IF f?'salary' THEN
  IF jsonb_typeof(f->'salary') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid salary list';END IF;
  IF jsonb_array_length(f->'salary')>20 THEN RAISE EXCEPTION 'Salary list exceeds bounds';END IF;
  FOR pay IN SELECT element.value FROM jsonb_array_elements(f->'salary') AS element(value) LOOP
   PERFORM ${s}.assert_object(pay,ARRAY['currency','interval','min','max'],ARRAY['currency','interval','min','max'],'salary');
   PERFORM ${s}.assert_string(pay->'currency',3,3,'salary currency');PERFORM ${s}.assert_string(pay->'interval',1,10,'salary interval');
   IF pay->>'currency' !~ '^[A-Z]{3}$' OR pay->>'interval' NOT IN ('1 YEAR','1 MONTH','1 HOUR') THEN RAISE EXCEPTION 'Invalid salary units';END IF;
   PERFORM ${s}.assert_number(pay->'min',0,1.7976931348623157e308,false,'salary minimum');PERFORM ${s}.assert_number(pay->'max',(pay->>'min')::numeric,1.7976931348623157e308,false,'salary maximum');
  END LOOP;
 END IF;
 c:=d->'classification';PERFORM ${s}.assert_object(c,ARRAY['version','roles','levels','workModes','employmentTypes','skills','department','team','country','countries','locations','basis'],ARRAY['version','roles','levels','workModes','employmentTypes','skills','department','team','country','countries','locations','basis'],'classification');
 PERFORM ${s}.assert_number(c->'version',2,2,true,'classification version');
 PERFORM ${s}.assert_strings(c->'roles',1,16,30,ARRAY['backend','frontend','full-stack','platform-sre','data','ai-ml','mobile','security','qa','product','design','sales','marketing','support','engineering','unknown'],'roles');
 PERFORM ${s}.assert_strings(c->'levels',1,8,30,ARRAY['intern','junior','senior','staff','principal','lead','manager','unknown'],'levels');
 PERFORM ${s}.assert_strings(c->'workModes',1,4,30,ARRAY['remote','hybrid','onsite','unknown'],'work modes');
 PERFORM ${s}.assert_strings(c->'employmentTypes',1,6,30,ARRAY['full-time','part-time','contract','internship','temporary','unknown'],'employment');
 PERFORM ${s}.assert_strings(c->'skills',0,30,30,ARRAY['python','javascript','typescript','java','golang','rust','ruby','php','c++','c#','react','vue','angular','nodejs','sql','postgresql','kubernetes','docker','terraform','aws','azure','gcp','linux','pytorch','tensorflow','figma'],'skills');
 FOREACH field IN ARRAY ARRAY['department','team'] LOOP PERFORM ${s}.assert_string(c->field,0,300,'classification scalar');END LOOP;
 PERFORM ${s}.assert_string(c->'country',0,100,'classification country');PERFORM ${s}.assert_strings(c->'countries',0,20,100,NULL,'classification countries');PERFORM ${s}.assert_strings(c->'locations',0,20,300,NULL,'classification locations');
 PERFORM ${s}.assert_string(c->'basis',1,300,'classification basis');IF c->>'basis'<>'Title, location and source metadata; skills are text mentions, not confirmed requirements. Remote does not establish country eligibility.' THEN RAISE EXCEPTION 'Invalid classification basis';END IF;
 IF c IS DISTINCT FROM ${s}.derive_classification(d) THEN RAISE EXCEPTION 'Classification is not derived from canonical evidence';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(${s}.country_key(a.value)) ORDER BY a.ordinal),'[]') INTO country_keys FROM jsonb_array_elements_text(c->'countries') WITH ORDINALITY a(value,ordinal);
 expected_labels:=c||jsonb_build_object('countryKeys',country_keys);IF x->'labels' IS DISTINCT FROM expected_labels THEN RAISE EXCEPTION 'Labels do not match canonical classification';END IF;
 PERFORM ${s}.assert_string(x->'searchText',1,20000,'search projection');PERFORM ${s}.assert_string(x->'locationText',0,7000,'location projection');
 SELECT coalesce(jsonb_agg(to_jsonb(a.value) ORDER BY a.ordinal),'[]') INTO locations FROM jsonb_array_elements_text(c->'locations') WITH ORDINALITY a(value,ordinal);
 IF x->>'locationText'<>${s}.js_lower(coalesce((SELECT string_agg(a.value,' ' ORDER BY a.ordinal) FROM jsonb_array_elements_text(locations) WITH ORDINALITY a(value,ordinal)),'')) OR x->>'searchText'<>${s}.js_lower((d->>'title')||' '||coalesce(d->>'companyName','')||' '||(d->>'text')||' '||coalesce((SELECT string_agg(a.value,' ' ORDER BY a.ordinal) FROM jsonb_array_elements_text(locations) WITH ORDINALITY a(value,ordinal)),'')) THEN RAISE EXCEPTION 'Search projection mismatch';END IF;
 expected_expiry:=${s}.js_date_parse(d->>'validThrough')+CASE WHEN length(d->>'validThrough')=10 THEN 86400000 ELSE 0 END;
 IF x->>'expiresAt' IS NOT NULL THEN PERFORM ${s}.assert_number(x->'expiresAt',-8640000000000000,8640000000000000,true,'expiry projection');END IF;
 IF (x->>'expiresAt')::bigint IS DISTINCT FROM expected_expiry THEN RAISE EXCEPTION 'Expiry projection mismatch';END IF;
 SELECT coalesce(jsonb_object_agg(material_name,coalesce(d->material_name,'null'::jsonb)),'{}') INTO material FROM unnest(ARRAY['identity','organizationId','title','text','url','sources','location','facts','publishedAt','validThrough','observedStatus','textTruncated','companyName','domain','industryGroup']) AS material_fields(material_name);
 material:=material||jsonb_build_object('classificationVersion',2,'mappingVersion','RM-MAP-001-r1','revisionSchemaVersion',1);
 IF d->>'canonicalRevision'<>encode(sha256(convert_to(${s}.canonical_json(material),'UTF8')),'hex') THEN RAISE EXCEPTION 'Canonical revision mismatch';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.validate_report(v jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
DECLARE field text;
BEGIN
 PERFORM ${s}.assert_object(v,ARRAY['checkedAt','nextRefreshAt','complete','knownListings','stored','truncated','status','storageLimited'],ARRAY['checkedAt','nextRefreshAt','complete','knownListings','stored','truncated','status','storageLimited'],'coverage');
 FOREACH field IN ARRAY ARRAY['checkedAt','nextRefreshAt','knownListings','stored'] LOOP PERFORM ${s}.assert_number(v->field,0,9007199254740991,true,'coverage integer');END LOOP;
 FOREACH field IN ARRAY ARRAY['complete','truncated','storageLimited'] LOOP PERFORM ${s}.assert_boolean(v->field,'coverage flag');END LOOP;
 IF v->>'status' IS DISTINCT FROM 'checked' THEN RAISE EXCEPTION 'Invalid coverage status';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION ${s}.validate_company_outcome(v jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,${s},pg_temp AS $guard$
BEGIN
 PERFORM ${s}.assert_object(v,ARRAY['status','openingCount','sources','ats'],ARRAY['status','openingCount','sources'],'company outcome');
 PERFORM ${s}.assert_string(v->'status',1,30,'company status');IF v->>'status' NOT IN ('openings-observed','no-openings-observed','unknown') THEN RAISE EXCEPTION 'Invalid company status';END IF;
 PERFORM ${s}.assert_number(v->'openingCount',0,100000,true,'opening count');PERFORM ${s}.assert_urls(v->'sources',0,20);IF v?'ats' THEN PERFORM ${s}.assert_urls(v->'ats',0,10);END IF;
END $guard$;


CREATE OR REPLACE FUNCTION ${s}.capacity_state() RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,${s},pg_temp AS $capacity$
DECLARE c record;status text;
BEGIN
 SELECT * INTO c FROM ${s}.control WHERE singleton;
 IF c.capacity_observed_at IS NULL OR c.capacity_total_bytes IS NULL OR c.capacity_free_bytes IS NULL OR c.capacity_store_id IS NULL OR c.capacity_total_bytes<=0 OR c.capacity_free_bytes<0 OR c.capacity_free_bytes>c.capacity_total_bytes THEN status:='unavailable';
 ELSIF c.capacity_observed_at<clock_timestamp()-interval '60 seconds' OR c.capacity_observed_at>clock_timestamp()+interval '1 second' THEN status:='unavailable';
 ELSIF c.capacity_free_bytes<536870912 OR c.capacity_free_bytes*10<=c.capacity_total_bytes THEN status:='unavailable';
 ELSIF c.capacity_free_bytes*5<=c.capacity_total_bytes THEN status:='warning';
 ELSE status:='ok';END IF;
 RETURN jsonb_build_object('status',status,'observedAt',CASE WHEN c.capacity_observed_at IS NULL THEN NULL ELSE floor(extract(epoch FROM c.capacity_observed_at)*1000)::bigint END);
END $capacity$;
CREATE OR REPLACE FUNCTION ${s}.assert_capacity() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,${s},pg_temp AS $capacity$
BEGIN
 IF ${s}.capacity_state()->>'status'='unavailable' THEN RAISE EXCEPTION 'Catalog capacity unavailable or stale';END IF;
END $capacity$;
CREATE OR REPLACE FUNCTION ${s}.attest_capacity(v jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $capacity$
DECLARE c record;
BEGIN
 IF session_user<>'rm_migrator' THEN RAISE EXCEPTION 'Capacity operator credential required' USING ERRCODE='42501';END IF;
 PERFORM ${s}.assert_object(v,ARRAY['observedAt','totalBytes','freeBytes','storeId','database'],ARRAY['observedAt','totalBytes','freeBytes','storeId','database'],'capacity attestation');
 PERFORM ${s}.assert_number(v->'observedAt',0,9007199254740991,true,'capacity observation time');
 PERFORM ${s}.assert_number(v->'totalBytes',1,9007199254740991,true,'capacity filesystem bytes');
 PERFORM ${s}.assert_number(v->'freeBytes',0,(v->>'totalBytes')::numeric,true,'capacity filesystem free bytes');
 PERFORM ${s}.assert_string(v->'storeId',1,80,'capacity store identity');PERFORM ${s}.assert_string(v->'database',1,63,'capacity database');
 IF v->>'storeId' !~ '^[a-z0-9][a-z0-9._-]{0,79}$' OR v->>'database' IS DISTINCT FROM current_database() OR (v->>'observedAt')::numeric>extract(epoch FROM clock_timestamp())*1000+1000 THEN RAISE EXCEPTION 'Invalid capacity observation binding';END IF;
 SELECT * INTO c FROM ${s}.control WHERE singleton FOR UPDATE;
 IF c.capacity_store_id IS NOT NULL AND c.capacity_store_id<>v->>'storeId' THEN RAISE EXCEPTION 'Capacity store identity changed; explicit recovery required';END IF;
 UPDATE ${s}.control SET capacity_observed_at=to_timestamp((v->>'observedAt')::double precision/1000),capacity_total_bytes=(v->>'totalBytes')::bigint,capacity_free_bytes=(v->>'freeBytes')::bigint,capacity_store_id=v->>'storeId' WHERE singleton;
 RETURN ${s}.capacity_state();
END $capacity$;
ALTER FUNCTION ${s}.capacity_state() OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_capacity() OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.attest_capacity(jsonb) OWNER TO rm_catalog_owner;
REVOKE ALL ON FUNCTION ${s}.capacity_state(),${s}.assert_capacity(),${s}.attest_capacity(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${s}.attest_capacity(jsonb) TO rm_migrator;

CREATE OR REPLACE FUNCTION ${s}.start_round() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $fn$
DECLARE c record;r uuid;
BEGIN
 PERFORM ${s}.assert_capacity();
 SELECT * INTO c FROM ${s}.control WHERE singleton FOR UPDATE;
 IF c.paused THEN RAISE EXCEPTION 'Catalog paused';END IF;
 SELECT id INTO r FROM ${s}.rounds WHERE state='active' ORDER BY created_at LIMIT 1;
 IF r IS NOT NULL AND EXISTS(SELECT 1 FROM ${s}.members WHERE round_id=r AND state NOT IN ('done','error','interrupted')) THEN RETURN jsonb_build_object('roundId',r);END IF;
 IF r IS NOT NULL THEN UPDATE ${s}.rounds SET state='complete' WHERE id=r;END IF;
 IF NOT EXISTS(SELECT 1 FROM ${s}.jobs WHERE source_pause_reason IS NULL AND eligible_at<=clock_timestamp()) THEN RETURN NULL;END IF;
 r:=gen_random_uuid();INSERT INTO ${s}.rounds(id,state) VALUES(r,'active');
 INSERT INTO ${s}.members(round_id,organization_id) SELECT r,organization_id FROM ${s}.jobs WHERE source_pause_reason IS NULL AND eligible_at<=clock_timestamp() ORDER BY organization_id COLLATE "C";
 RETURN jsonb_build_object('roundId',r);
END $fn$;
CREATE OR REPLACE FUNCTION ${s}.claim_turn() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $fn$
DECLARE c record;m record;r uuid;rid uuid;tok uuid;
BEGIN
 PERFORM ${s}.assert_capacity();
 SELECT * INTO c FROM ${s}.control WHERE singleton FOR UPDATE;IF c.paused THEN RAISE EXCEPTION 'Catalog paused';END IF;
 SELECT id INTO r FROM ${s}.rounds WHERE state='active' ORDER BY created_at LIMIT 1;IF r IS NULL THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM ${s}.members WHERE state='claimed' AND lease_until>clock_timestamp()) THEN RETURN NULL;END IF;
 FOR m IN SELECT * FROM ${s}.members WHERE round_id=r AND state='claimed' AND lease_until<=clock_timestamp() FOR UPDATE LOOP
  UPDATE ${s}.runs SET state='interrupted' WHERE id=m.run_id AND state='claimed';
  IF m.claim_count>=3 THEN
   UPDATE ${s}.members SET state='interrupted' WHERE round_id=r AND organization_id=m.organization_id;
   UPDATE ${s}.jobs SET eligible_at=clock_timestamp()+interval '15 minutes' WHERE organization_id=m.organization_id;
  ELSE UPDATE ${s}.members SET state='pending' WHERE round_id=r AND organization_id=m.organization_id;END IF;
 END LOOP;
 UPDATE ${s}.members pending_member SET state='interrupted' WHERE pending_member.round_id=r AND pending_member.state='pending' AND EXISTS(SELECT 1 FROM ${s}.jobs pending_job WHERE pending_job.organization_id=pending_member.organization_id AND pending_job.source_pause_reason IS NOT NULL);
 SELECT * INTO m FROM ${s}.members WHERE round_id=r AND state='pending' ORDER BY organization_id COLLATE "C" LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN UPDATE ${s}.rounds SET state='complete' WHERE id=r;RETURN NULL;END IF;
 rid:=gen_random_uuid();tok:=gen_random_uuid();
 UPDATE ${s}.members SET state='claimed',claim_count=claim_count+1,run_id=rid,lease_token=tok,lease_until=clock_timestamp()+interval '120 seconds',started_at=clock_timestamp() WHERE round_id=r AND organization_id=m.organization_id;
 INSERT INTO ${s}.runs(id,round_id,organization_id,epoch,lease_token,state) VALUES(rid,r,m.organization_id,c.epoch,tok,'claimed');
 RETURN jsonb_build_object('runId',rid,'roundId',r,'organizationId',m.organization_id,'leaseToken',tok,'epoch',c.epoch);
END $fn$;
CREATE OR REPLACE FUNCTION ${s}.heartbeat_turn(p jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $fn$
DECLARE c record;m record;
BEGIN
 PERFORM ${s}.assert_capacity();
 PERFORM ${s}.validate_claim(p);
 SELECT * INTO c FROM ${s}.control WHERE singleton FOR UPDATE;
 SELECT * INTO m FROM ${s}.members WHERE round_id=(p->>'roundId')::uuid AND organization_id=p->>'organizationId' FOR UPDATE;
 IF c.paused OR c.epoch<>(p->>'epoch')::bigint OR m.state IS DISTINCT FROM 'claimed' OR m.run_id IS DISTINCT FROM (p->>'runId')::uuid OR m.lease_token IS DISTINCT FROM (p->>'leaseToken')::uuid OR m.lease_until<=clock_timestamp() OR m.started_at+interval '60 seconds'<=clock_timestamp() OR m.started_at+interval '180 seconds'<=clock_timestamp() THEN RETURN false;END IF;
 UPDATE ${s}.members SET lease_until=least(clock_timestamp()+interval '120 seconds',started_at+interval '180 seconds') WHERE round_id=m.round_id AND organization_id=m.organization_id;RETURN true;
END $fn$;
CREATE OR REPLACE FUNCTION ${s}.publish_turn(p jsonb,rows jsonb,report jsonb,company_outcome jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $fn$
DECLARE c record;m record;prior record;x jsonb;d jsonb;answer jsonb;at_ms bigint;
BEGIN
 PERFORM ${s}.assert_capacity();
 PERFORM ${s}.validate_claim(p);
 SELECT * INTO c FROM ${s}.control WHERE singleton FOR UPDATE;
 SELECT * INTO prior FROM ${s}.runs WHERE id=(p->>'runId')::uuid;
 IF prior.state='done' AND prior.epoch=(p->>'epoch')::bigint AND prior.lease_token=(p->>'leaseToken')::uuid AND prior.organization_id=p->>'organizationId' THEN RETURN prior.result;END IF;
 SELECT * INTO m FROM ${s}.members WHERE round_id=(p->>'roundId')::uuid AND organization_id=p->>'organizationId' FOR UPDATE;
 IF c.paused OR c.epoch<>(p->>'epoch')::bigint OR m.state IS DISTINCT FROM 'claimed' OR m.run_id IS DISTINCT FROM (p->>'runId')::uuid OR m.lease_token IS DISTINCT FROM (p->>'leaseToken')::uuid OR m.lease_until<=clock_timestamp() OR m.started_at+interval '60 seconds'<=clock_timestamp() THEN RAISE EXCEPTION 'Stale collection authority';END IF;
 PERFORM ${s}.validate_report(report);PERFORM ${s}.validate_company_outcome(company_outcome);
 IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows)>100000 OR jsonb_typeof(report)<>'object' OR jsonb_typeof(company_outcome)<>'object' OR company_outcome->>'status' NOT IN ('openings-observed','no-openings-observed','unknown') THEN RAISE EXCEPTION 'Invalid result envelope';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(report) k WHERE k NOT IN ('checkedAt','nextRefreshAt','complete','knownListings','stored','truncated','status','storageLimited')) OR EXISTS(SELECT 1 FROM jsonb_object_keys(company_outcome) k WHERE k NOT IN ('status','openingCount','sources','ats')) THEN RAISE EXCEPTION 'Unmapped publication metadata';END IF;
 FOR x IN SELECT element.value FROM jsonb_array_elements(rows) AS element(value) LOOP
  d:=x->'data';
  PERFORM ${s}.validate_publication(x);
  IF d->>'organizationId' IS DISTINCT FROM m.organization_id OR coalesce(length(d->>'id'),0)=0 OR coalesce(length(d->>'identity'),0)=0 OR coalesce(length(d->>'title'),0)=0 OR length(d->>'title')>200 OR coalesce(length(d->>'text'),0)=0 OR length(d->>'text')>10000 OR d->>'url' !~ '^https://' OR d->>'identity' !~ '^https://' OR jsonb_typeof(d->'sources')<>'array' OR jsonb_array_length(d->'sources')=0 OR d->>'canonicalRevision' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid public vacancy';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('id','organizationId','identity','url','companyName','domain','title','text','location','facts','sources','industryGroup','publishedAt','validThrough','textTruncated','contentHash','firstSeenAt','lastSeenAt','checkedAt','textFetchedAt','changedAt','observedStatus','classification','canonicalRevision')) THEN RAISE EXCEPTION 'Unmapped vacancy field';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(d->'facts','{}')) k WHERE k NOT IN ('department','team','country','employmentType','workplaceType','salary','locations','countries','employmentTypes','applicantLocations')) THEN RAISE EXCEPTION 'Unmapped facts';END IF;
  IF EXISTS(SELECT 1 FROM ${s}.vacancies v WHERE v.id=d->>'id' AND (v.organization_id<>m.organization_id OR v.identity<>d->>'identity')) THEN RAISE EXCEPTION 'Conflicting vacancy identity';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(x) k WHERE k NOT IN ('data','labels','searchText','locationText','expiresAt')) OR jsonb_typeof(d->'facts') IS DISTINCT FROM 'object' OR jsonb_typeof(d->'classification') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid public projection';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(d->'classification') k WHERE k NOT IN ('version','roles','levels','workModes','employmentTypes','skills','department','team','country','countries','locations','basis')) THEN RAISE EXCEPTION 'Unmapped classification';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(x->'labels') k WHERE k NOT IN ('version','roles','levels','workModes','employmentTypes','skills','department','team','country','countries','locations','basis','countryKeys')) THEN RAISE EXCEPTION 'Unmapped projection label';END IF;
  IF jsonb_typeof(d->'facts'->'salary') IS NOT NULL AND jsonb_typeof(d->'facts'->'salary')<>'array' THEN RAISE EXCEPTION 'Invalid salary';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'facts'->'salary','[]')) pay WHERE jsonb_typeof(pay)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(pay) k WHERE k NOT IN ('currency','interval','min','max')) OR pay->>'currency' !~ '^[A-Z]{3}$' OR pay->>'interval' NOT IN ('1 YEAR','1 MONTH','1 HOUR') OR jsonb_typeof(pay->'min') IS DISTINCT FROM 'number' OR jsonb_typeof(pay->'max') IS DISTINCT FROM 'number' OR (pay->>'min')::numeric<0 OR (pay->>'max')::numeric<(pay->>'min')::numeric) THEN RAISE EXCEPTION 'Invalid normalized salary';END IF;
  INSERT INTO ${s}.vacancies(id,organization_id,identity,data,labels,search_text,location_text,last_seen_at,checked_at,expires_at) VALUES(d->>'id',m.organization_id,d->>'identity',d,x->'labels',x->>'searchText',x->>'locationText',coalesce((d->>'lastSeenAt')::bigint,0),coalesce((d->>'checkedAt')::bigint,0),(x->>'expiresAt')::bigint) ON CONFLICT(id) DO UPDATE SET data=excluded.data,labels=excluded.labels,search_text=excluded.search_text,location_text=excluded.location_text,last_seen_at=excluded.last_seen_at,checked_at=excluded.checked_at,expires_at=excluded.expires_at WHERE vacancies.organization_id=excluded.organization_id AND vacancies.identity=excluded.identity;
 END LOOP;
 PERFORM ${s}.assert_capacity();
 IF m.lease_until<=clock_timestamp() OR m.started_at+interval '60 seconds'<=clock_timestamp() THEN RAISE EXCEPTION 'Collection deadline expired before publication';END IF;
 at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 INSERT INTO ${s}.coverage(organization_id,data) VALUES(m.organization_id,report) ON CONFLICT(organization_id) DO UPDATE SET data=excluded.data;
 UPDATE ${s}.organizations SET data=data||jsonb_build_object('lastAttemptAt',at_ms,'checkedAt',at_ms,'lastError',NULL,'observation',company_outcome) WHERE id=m.organization_id;
 UPDATE ${s}.jobs SET eligible_at=clock_timestamp()+interval '24 hours',consecutive_failures=0 WHERE organization_id=m.organization_id;
 answer:=jsonb_build_object('runId',p->>'runId','published',jsonb_array_length(rows));
 UPDATE ${s}.runs SET state='done',result=answer WHERE id=(p->>'runId')::uuid;
 UPDATE ${s}.members SET state='done' WHERE round_id=m.round_id AND organization_id=m.organization_id;
 RETURN answer;
END $fn$;
DROP FUNCTION IF EXISTS ${s}.fail_turn(jsonb,text);
CREATE OR REPLACE FUNCTION ${s}.fail_turn(p jsonb,category text,retry_after text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $fn$
DECLARE c record;m record;prior record;j record;at_ms bigint;answer jsonb;failures integer;failure_at timestamptz;deadline timestamptz;eligible timestamptz;hint text;seconds numeric;parts text[];month_no integer;pause_reason text;parsed boolean:=false;
BEGIN
 PERFORM ${s}.validate_claim(p);
 SELECT * INTO c FROM ${s}.control WHERE singleton FOR UPDATE;
 SELECT * INTO prior FROM ${s}.runs WHERE id=(p->>'runId')::uuid FOR UPDATE;
 SELECT * INTO m FROM ${s}.members WHERE round_id=(p->>'roundId')::uuid AND organization_id=p->>'organizationId' FOR UPDATE;
 IF c.epoch<>(p->>'epoch')::bigint OR prior.epoch IS DISTINCT FROM c.epoch OR prior.round_id IS DISTINCT FROM (p->>'roundId')::uuid OR prior.organization_id IS DISTINCT FROM p->>'organizationId' OR prior.lease_token IS DISTINCT FROM (p->>'leaseToken')::uuid OR m.run_id IS DISTINCT FROM prior.id OR m.lease_token IS DISTINCT FROM prior.lease_token OR m.round_id IS DISTINCT FROM prior.round_id OR m.organization_id IS DISTINCT FROM prior.organization_id THEN RAISE EXCEPTION 'Stale collection authority';END IF;
 IF prior.state='error' THEN RETURN prior.result;END IF;
 SELECT * INTO j FROM ${s}.jobs WHERE organization_id=p->>'organizationId' FOR UPDATE;
 failure_at:=clock_timestamp();
 IF c.paused OR prior.state IS DISTINCT FROM 'claimed' OR m.state IS DISTINCT FROM 'claimed' OR m.run_id IS DISTINCT FROM (p->>'runId')::uuid OR m.lease_token IS DISTINCT FROM (p->>'leaseToken')::uuid OR m.lease_until<=failure_at OR j.source_pause_reason IS NOT NULL THEN RAISE EXCEPTION 'Stale collection authority';END IF;
 PERFORM ${s}.assert_capacity();
 IF category IS NULL OR category NOT IN ('source-unavailable','source-timeout','source-restricted','source-partial','source-invalid') THEN RAISE EXCEPTION 'Invalid failure category';END IF;
 failures:=j.consecutive_failures+1;
 eligible:=failure_at+make_interval(secs=>least(86400,900*power(2,least(failures-1,8)))::integer);
 IF retry_after IS NOT NULL AND octet_length(retry_after)<=128 THEN
  hint:=btrim(retry_after,chr(32)||chr(9));
  IF hint ~ '^[0-9]+$' THEN
   seconds:=hint::numeric;
   BEGIN deadline:=failure_at+make_interval(secs=>seconds::double precision);parsed:=true;
   EXCEPTION WHEN datetime_field_overflow OR interval_field_overflow OR numeric_value_out_of_range THEN pause_reason:='retry-after-overflow';END;
  ELSE
   parts:=regexp_match(hint,'^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$');
   IF parts IS NOT NULL AND parts[4]::integer>=1 AND parts[5]::integer<=23 AND parts[6]::integer<=59 AND parts[7]::integer<=59 THEN
    month_no:=array_position(ARRAY['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],parts[3]);
    BEGIN
     deadline:=make_timestamptz(parts[4]::integer,month_no,parts[2]::integer,parts[5]::integer,parts[6]::integer,parts[7]::integer,'UTC');
     parsed:=(ARRAY['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[extract(dow FROM deadline AT TIME ZONE 'UTC')::integer+1]=parts[1] AND deadline>failure_at;
    EXCEPTION WHEN datetime_field_overflow THEN parsed:=false;END;
   END IF;
  END IF;
 END IF;
 IF parsed THEN
  IF deadline-failure_at>interval '24 hours' THEN pause_reason:='source-review';ELSE eligible:=greatest(eligible,deadline);END IF;
 ELSE deadline:=NULL;END IF;
 at_ms:=floor(extract(epoch FROM failure_at)*1000)::bigint;
 UPDATE ${s}.jobs SET consecutive_failures=failures,eligible_at=eligible,source_pause_reason=pause_reason,source_retry_at=CASE WHEN pause_reason IS NOT NULL THEN deadline ELSE NULL END WHERE organization_id=m.organization_id;
 INSERT INTO ${s}.coverage(organization_id,data) VALUES(m.organization_id,jsonb_build_object('lastAttemptAt',at_ms,'status','unavailable')) ON CONFLICT(organization_id) DO UPDATE SET data=coverage.data||excluded.data;
 UPDATE ${s}.organizations SET data=data||jsonb_build_object('lastAttemptAt',at_ms,'lastError',category) WHERE id=m.organization_id;
 answer:=jsonb_build_object('runId',p->>'runId','status','unavailable');
 UPDATE ${s}.runs SET state='error',result=answer WHERE id=(p->>'runId')::uuid;
 UPDATE ${s}.members SET state='error' WHERE round_id=m.round_id AND organization_id=m.organization_id;RETURN answer;
END $fn$;
CREATE OR REPLACE FUNCTION ${s}.resume_source(org text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $fn$
DECLARE j record;at_time timestamptz;
BEGIN
 PERFORM ${s}.assert_capacity();
 PERFORM 1 FROM ${s}.control WHERE singleton FOR UPDATE;
 SELECT * INTO j FROM ${s}.jobs WHERE organization_id=org FOR UPDATE;
 at_time:=clock_timestamp();
 IF j.source_pause_reason IS NULL OR j.source_retry_at IS NULL OR at_time<j.source_retry_at THEN RAISE EXCEPTION 'Source pause cannot resume';END IF;
 UPDATE ${s}.jobs SET source_pause_reason=NULL,source_retry_at=NULL,eligible_at=greatest(eligible_at,at_time) WHERE organization_id=org;
 RETURN jsonb_build_object('organizationId',org,'resumed',true);
END $fn$;
ALTER FUNCTION ${s}.resume_source(text) OWNER TO rm_catalog_owner;
REVOKE ALL ON FUNCTION ${s}.resume_source(text) FROM PUBLIC,rm_web,rm_collector;
GRANT EXECUTE ON FUNCTION ${s}.resume_source(text) TO rm_migrator;
ALTER FUNCTION ${s}.assert_object(jsonb,text[],text[],text) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.utf16_length(text) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_string(jsonb,integer,integer,text) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_number(jsonb,numeric,numeric,boolean,text) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_boolean(jsonb,text) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_strings(jsonb,integer,integer,integer,text[],text) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_url(jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_urls(jsonb,integer,integer) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.assert_date(jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.canonical_json(jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.country_key(text) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.validate_claim(jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.validate_publication(jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.validate_report(jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.validate_company_outcome(jsonb) OWNER TO rm_catalog_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC;

CREATE OR REPLACE FUNCTION ${s}.collection_meta() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $fn$
DECLARE active_round uuid;due_count bigint;oldest timestamptz;remaining bigint;last_check bigint;paused boolean;
BEGIN
 SELECT r.id INTO active_round FROM ${s}.rounds r WHERE r.state='active' ORDER BY r.created_at LIMIT 1;
 SELECT count(*),min(j.eligible_at) INTO due_count,oldest FROM ${s}.jobs j WHERE j.source_pause_reason IS NULL AND j.eligible_at<=clock_timestamp();
 SELECT count(*) INTO remaining FROM ${s}.members m WHERE m.round_id=active_round AND m.state NOT IN ('done','error','interrupted');
 SELECT max((c.data->>'checkedAt')::bigint) INTO last_check FROM ${s}.coverage c;
 SELECT c.paused INTO paused FROM ${s}.control c WHERE c.singleton;
 RETURN jsonb_build_object('mode','sequential-rounds','concurrency',1,'enabled',false,'roundId',active_round,'dueCount',due_count,'remainingInRound',remaining,'oldestDueAt',CASE WHEN oldest IS NULL THEN NULL ELSE floor(extract(epoch FROM oldest)*1000)::bigint END,'lastSuccessfulCheckAt',last_check,'companyIntervalHours',24,'partialCoverage',true,'paused',paused,'sourcePausedCount',(SELECT count(*) FROM ${s}.jobs WHERE source_pause_reason IS NOT NULL),'capacity',${s}.capacity_state());
END $fn$;
CREATE OR REPLACE FUNCTION ${s}.retry_after_revision() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,${s},pg_temp AS $revision$ SELECT (value#>>'{}')::integer FROM ${s}.metadata WHERE key='retryAfterRevision' $revision$;
ALTER FUNCTION ${s}.retry_after_revision() OWNER TO rm_catalog_owner;
REVOKE ALL ON FUNCTION ${s}.retry_after_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${s}.retry_after_revision() TO rm_web,rm_collector,rm_migrator;
ALTER FUNCTION ${s}.collection_meta() OWNER TO rm_catalog_owner;
REVOKE ALL ON FUNCTION ${s}.collection_meta() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${s}.collection_meta() TO rm_web,rm_collector;

ALTER FUNCTION ${s}.start_round() OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.claim_turn() OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.heartbeat_turn(jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.publish_turn(jsonb,jsonb,jsonb,jsonb) OWNER TO rm_catalog_owner;
ALTER FUNCTION ${s}.fail_turn(jsonb,text,text) OWNER TO rm_catalog_owner;
GRANT EXECUTE ON FUNCTION ${s}.start_round(),${s}.claim_turn(),${s}.heartbeat_turn(jsonb),${s}.publish_turn(jsonb,jsonb,jsonb,jsonb),${s}.fail_turn(jsonb,text,text) TO rm_collector;
`;
}

/**
 * @param {{connectionString?:string,namespace?:string,role?:'operator'|'web'|'collector',capacityObservation?:{observedAt:number,totalBytes:number,freeBytes:number,storeId:string,database:string}}} [options]
 */
export async function openPostgresCatalog({
  connectionString,
  namespace = 'rolemorrow_catalog',
  role = 'web',
  capacityObservation,
} = {}) {
  requireThat(
    typeof connectionString === 'string' && connectionString.length > 0,
    'PostgreSQL connection string required',
  );
  requireThat(/^[a-z][a-z0-9_]{0,62}$/.test(namespace), 'Invalid catalog namespace');
  requireThat(['operator', 'web', 'collector'].includes(role), 'Unknown requested role');
  const s = '"' + namespace + '"',
    pool = new pg.Pool({
      connectionString,
      max: role === 'web' ? 4 : role === 'collector' ? 2 : 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 1000,
      statement_timeout: 5000,
      query_timeout: 5500,
    });
  let closed = false;
  /** @param {string} sql @param {unknown[]} [args] @returns {Promise<import('pg').QueryResult<import('pg').QueryResultRow>>} */
  async function query(sql, args = []) {
    if (closed) throw error('Catalog closed');
    return pool.query(sql, args);
  }
  const identity = (await query('SELECT current_user AS name')).rows[0].name;
  const expectedIdentity = { operator: 'rm_migrator', web: 'rm_web', collector: 'rm_collector' }[
    role
  ];
  if (identity !== expectedIdentity) {
    await pool.end();
    throw error('Catalog role credential mismatch', '42501');
  }
  const operator = role === 'operator';
  const requireOperator = () => {
    if (!operator) throw error('Operator-only catalog operation', '42501');
  };
  /**
   * @template T
   * @param {(query:(sql:string,args?:unknown[])=>Promise<import('pg').QueryResult<import('pg').QueryResultRow>>)=>Promise<T>} fn
   * @param {{maintenance?:boolean}} [options]
   * @returns {Promise<T>}
   */
  async function transaction(fn, { maintenance = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'");
      if (!maintenance) await client.query('SELECT ' + s + '.assert_capacity()');
      const result = await fn((sql, args = []) => client.query(sql, args));
      if (!maintenance) await client.query('SELECT ' + s + '.assert_capacity()');
      await client.query('COMMIT');
      return result;
    } catch (problem) {
      await client.query('ROLLBACK').catch(() => {});
      throw problem;
    } finally {
      client.release();
    }
  }
  if (role === 'operator') {
    try {
      const marker = (await query('SELECT to_regclass($1) AS relation', [s + '.control'])).rows[0]
        .relation;
      if (marker) {
        const current = (
          await query('SELECT schema_version,active_batch FROM ' + s + '.control WHERE singleton')
        ).rows[0];
        requireThat(
          current?.schema_version === 1 && typeof current.active_batch === 'string',
          'Unsupported catalog identity/version',
        );
        const revision = (
          await query('SELECT value FROM ' + s + ".metadata WHERE key='retryAfterRevision'")
        ).rows[0]?.value;
        if (revision !== 1)
          await transaction(
            async (q) => {
              await q(schemaSql(s));
            },
            { maintenance: true },
          );
      } else {
        const objects = Number(
          (
            await query(
              "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S')",
              [namespace],
            )
          ).rows[0].count,
        );
        requireThat(objects === 0, 'Refusing unrelated namespace');
        await transaction(
          async (q) => {
            await q('CREATE SCHEMA IF NOT EXISTS ' + s);
            await q(schemaSql(s));
          },
          { maintenance: true },
        );
      }
    } catch (problem) {
      await pool.end();
      throw problem;
    }
  }
  try {
    const control = (
      await query('SELECT schema_version,active_batch FROM ' + s + '.control WHERE singleton')
    ).rows[0];
    requireThat(
      control?.schema_version === 1 && typeof control.active_batch === 'string',
      'Catalog schema/batch not ready',
    );
    const retryRevision = (await query('SELECT ' + s + '.retry_after_revision() AS value')).rows[0]
      ?.value;
    requireThat(retryRevision === 1, 'Catalog Retry-After schema not ready');
    const procedureConfig = (
      await query(
        'SELECT p.proname,p.prosecdef,p.proconfig,r.rolname AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname=$1 AND p.proname=ANY($2)',
        [
          namespace,
          [
            'start_round',
            'claim_turn',
            'heartbeat_turn',
            'publish_turn',
            'fail_turn',
            'collection_meta',
            'attest_capacity',
            'resume_source',
            'retry_after_revision',
          ],
        ],
      )
    ).rows;
    requireThat(
      procedureConfig.length === 9 &&
        procedureConfig.every(
          (p) =>
            p.prosecdef &&
            p.owner === 'rm_catalog_owner' &&
            (p.proconfig ?? []).some(
              (value) =>
                value.replaceAll('"', '').replaceAll(' ', '') ===
                'search_path=pg_catalog,' + namespace + ',pg_temp',
            ),
        ),
      'Unsafe catalog procedure installation',
    );
  } catch (problem) {
    await pool.end();
    throw problem;
  }
  const dataRows = async (sql, args = []) => (await query(sql, args)).rows.map((row) => row.data);
  const displayOrganization = (row) => {
    const stale = !row.checkedAt || Date.now() - row.checkedAt >= ORGANIZATION_MAX_AGE;
    return {
      ...row,
      industryGroup: row.industryGroup ?? classifyIndustry(row.industry),
      employeeSize:
        row.employees && Date.now() - Date.parse(row.employees.asOf) <= 365 * DAY
          ? row.employees.range
          : 'unknown',
      stale,
      hiring: stale || row.lastError ? 'unknown' : (row.observation?.status ?? 'unknown'),
    };
  };
  function organizationWhere(filters = {}) {
    const args = [],
      sql = ['true'],
      bind = (value) => {
        args.push(value);
        return '$' + args.length;
      };
    const text = String(filters.query ?? '')
      .trim()
      .slice(0, 200)
      .toLowerCase();
    if (text) sql.push('strpos(lowerless.search_text,' + bind(text) + ')>0');
    if (filters.industry) sql.push('o.industry=' + bind(filters.industry));
    if (filters.employeeSize)
      sql.push(
        "CASE WHEN (o.data->'employees'->>'asOf')::date>=CURRENT_DATE-365 THEN o.data->'employees'->>'range' ELSE 'unknown' END=" +
          bind(filters.employeeSize),
      );
    return { sql: sql.join(' AND '), args };
  }
  const organizationFrom =
    ' FROM ' +
    s +
    '.organizations o CROSS JOIN LATERAL (SELECT o.sort_name||chr(32)||o.domain AS search_text) lowerless';
  async function putOrganization(q, row) {
    await q(
      'INSERT INTO ' +
        s +
        '.organizations(id,domain,name,sort_name,industry,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET domain=excluded.domain,name=excluded.name,sort_name=excluded.sort_name,industry=excluded.industry,data=excluded.data',
      [
        row.id,
        row.domain,
        row.name,
        row.name.toLowerCase(),
        row.industryGroup,
        JSON.stringify(row),
      ],
    );
    await q('INSERT INTO ' + s + '.jobs(organization_id) VALUES($1) ON CONFLICT DO NOTHING', [
      row.id,
    ]);
  }

  const organizations = {
    async importSeeds(inputs) {
      requireOperator();
      requireThat(
        Array.isArray(inputs) && inputs.length <= 500,
        'Import at most500 reviewed companies',
      );
      return transaction(async (q) => {
        for (const input of inputs) {
          const seed = organizationSeed(input),
            existing = (
              await q('SELECT data FROM ' + s + '.organizations WHERE domain=$1 FOR UPDATE', [
                seed.domain,
              ])
            ).rows[0]?.data;
          if (existing) {
            requireThat(existing.careers === seed.careers, 'Conflicting careers requires review');
            const next = {
              ...existing,
              industry: seed.industry,
              industryGroup: seed.industryGroup,
            };
            if (
              seed.employees &&
              (!existing.employees || seed.employees.asOf >= existing.employees.asOf)
            )
              next.employees = seed.employees;
            await putOrganization(q, organization(next));
          } else
            await putOrganization(
              q,
              organization({
                ...seed,
                createdAt: Date.now(),
                lastAttemptAt: null,
                checkedAt: null,
                observation: null,
              }),
            );
        }
        return {
          count: Number((await q('SELECT count(*) FROM ' + s + '.organizations')).rows[0].count),
        };
      });
    },
    async list(options = {}) {
      const p = organizationWhere(options);
      return (
        await dataRows(
          'SELECT o.data' +
            organizationFrom +
            ' WHERE ' +
            p.sql +
            ' ORDER BY o.sort_name COLLATE "C",o.id COLLATE "C" LIMIT $' +
            (p.args.length + 1) +
            ' OFFSET $' +
            (p.args.length + 2),
          [...p.args, pageSize(options.limit, 30), pageOffset(options.offset)],
        )
      ).map(displayOrganization);
    },
    async resolve(input) {
      let domain;
      try {
        domain = organizationSeed({
          name: 'Lookup',
          homepage: input.homepage,
          careers: input.homepage,
        }).domain;
      } catch {
        return null;
      }
      const row = (
        await dataRows('SELECT data FROM ' + s + '.organizations WHERE domain=$1', [domain])
      )[0];
      return row ? displayOrganization(row) : null;
    },
    async count() {
      return Number((await query('SELECT count(*) FROM ' + s + '.organizations')).rows[0].count);
    },
    async matchingCount(input) {
      const p = organizationWhere(typeof input === 'string' ? { query: input } : input);
      return Number(
        (await query('SELECT count(*)' + organizationFrom + ' WHERE ' + p.sql, p.args)).rows[0]
          .count,
      );
    },
    async entries() {
      return (
        await dataRows('SELECT data FROM ' + s + '.organizations ORDER BY id COLLATE "C"')
      ).map(displayOrganization);
    },
    async facets() {
      const rows = await organizations.entries(),
        industries = new Map(),
        sizes = new Map();
      for (const row of rows) {
        industries.set(row.industryGroup, (industries.get(row.industryGroup) ?? 0) + 1);
        sizes.set(row.employeeSize, (sizes.get(row.employeeSize) ?? 0) + 1);
      }
      return {
        industries: Object.entries(INDUSTRIES).map(([value, label]) => ({
          value,
          label,
          count: industries.get(value) ?? 0,
        })),
        employeeSizes: [...EMPLOYEE_RANGES, 'unknown'].map((value) => ({
          value,
          label: value === 'unknown' ? 'Size unknown' : value + ' employees',
          count: sizes.get(value) ?? 0,
        })),
      };
    },
    async refreshCandidates({ limit = 10 } = {}) {
      return (
        await dataRows(
          'SELECT o.data FROM ' +
            s +
            '.organizations o JOIN ' +
            s +
            '.jobs j ON j.organization_id=o.id WHERE j.source_pause_reason IS NULL AND j.eligible_at<=clock_timestamp() ORDER BY j.eligible_at,o.id COLLATE "C" LIMIT $1',
          [Math.max(1, Math.min(200, limit))],
        )
      ).map(displayOrganization);
    },
    async due(options = {}) {
      return organizations.refreshCandidates(options);
    },
    async record(id, outcome) {
      requireOperator();
      return transaction(async (q) => {
        const old = (
          await q('SELECT data FROM ' + s + '.organizations WHERE id=$1 FOR UPDATE', [id])
        ).rows[0]?.data;
        requireThat(old, 'Unknown organization');
        const at = Date.now();
        const next = outcome.error
          ? { ...old, lastAttemptAt: at, lastError: 'Source unavailable' }
          : {
              ...old,
              lastAttemptAt: at,
              checkedAt: at,
              lastError: null,
              observation: observation(outcome),
            };
        await putOrganization(q, organization(next));
      });
    },
    async importVerified(input) {
      requireOperator();
      requireThat(
        input.provenance?.kind === 'public-website-linked-careers',
        'Independent verification required',
      );
      const seed = organizationSeed(input);
      if (await organizations.resolve(seed)) return { added: false };
      await organizations.importSeeds([input]);
      return { added: true };
    },
  };
  function vacancyWhere(filters = {}) {
    const args = [],
      parts = ['true'],
      bind = (value) => {
        args.push(value);
        return '$' + args.length;
      };
    for (const term of String(filters.query ?? '')
      .trim()
      .slice(0, 200)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean))
      parts.push('strpos(v.search_text,' + bind(term) + ')>0');
    if (filters.organizationId) parts.push('v.organization_id=' + bind(filters.organizationId));
    if (filters.status)
      parts.push(
        'CASE WHEN v.expires_at IS NOT NULL AND v.expires_at<' +
          bind(Date.now()) +
          " THEN 'expired' WHEN v.checked_at<=" +
          bind(Date.now() - 2 * DAY) +
          " THEN 'unknown' ELSE v.data->>'observedStatus' END=" +
          bind(filters.status),
      );
    for (const [kind, key] of [
      ['role', 'roles'],
      ['level', 'levels'],
      ['workMode', 'workModes'],
      ['employmentType', 'employmentTypes'],
    ]) {
      const values = tokenValues(filters[kind]);
      if (values.length)
        parts.push('(v.labels->' + bind(key) + ') ?| ' + bind(values) + '::text[]');
    }
    const skills = tokenValues(filters.skills);
    if (skills.length)
      parts.push(
        "(v.labels->'skills') " +
          (filters.skillMatch === 'any' ? '?|' : '?&') +
          ' ' +
          bind(skills) +
          '::text[]',
      );
    if (filters.country)
      parts.push("(v.labels->'countryKeys') ? " + bind(countryKey(filters.country)));
    if (filters.location)
      parts.push(
        'strpos(v.location_text,' +
          bind(String(filters.location).trim().slice(0, 200).toLowerCase()) +
          ')>0',
      );
    if (filters.industry) parts.push("v.data->>'industryGroup'=" + bind(filters.industry));
    for (const word of tokenValues(filters.exclude))
      parts.push('strpos(v.search_text,' + bind(word) + ')=0');
    if (filters.salaryDisclosed === 'yes')
      parts.push("jsonb_array_length(coalesce(v.data->'facts'->'salary','[]'))>0");
    if (filters.salaryMin) {
      const amount = Number(filters.salaryMin);
      if (!Number.isFinite(amount) || amount < 0 || !filters.currency || !filters.salaryInterval)
        parts.push('false');
      else
        parts.push(
          "EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.data->'facts'->'salary','[]')) pay WHERE pay->>'currency'=" +
            bind(filters.currency) +
            " AND pay->>'interval'=" +
            bind(filters.salaryInterval) +
            " AND (pay->>'max')::numeric>=" +
            bind(amount) +
            ')',
        );
    }
    return { sql: parts.join(' AND '), args };
  }
  const vacancyView = (row) => ({
    ...row,
    status:
      row.validThrough &&
      Date.parse(row.validThrough) + (row.validThrough.length === 10 ? DAY : 0) < Date.now()
        ? 'expired'
        : Date.now() - (row.checkedAt ?? 0) >= 2 * DAY
          ? 'unknown'
          : row.observedStatus,
  });
  const vacancies = {
    async list(filters = {}) {
      const p = vacancyWhere(filters),
        offset = pageOffset(filters.offset),
        limit = pageSize(filters.limit),
        matching = Number(
          (await query('SELECT count(*) FROM ' + s + '.vacancies v WHERE ' + p.sql, p.args)).rows[0]
            .count,
        );
      const rows = await dataRows(
        'SELECT v.data FROM ' +
          s +
          '.vacancies v WHERE ' +
          p.sql +
          ' ORDER BY v.last_seen_at DESC,v.id COLLATE "C" LIMIT $' +
          (p.args.length + 1) +
          ' OFFSET $' +
          (p.args.length + 2),
        [...p.args, limit, offset],
      );
      const facets = {};
      for (const [key, label] of [
        ['role', 'roles'],
        ['level', 'levels'],
        ['workMode', 'workModes'],
        ['employmentType', 'employmentTypes'],
        ['skills', 'skills'],
      ]) {
        const result = await query(
          'SELECT label.value,count(*)::integer AS count FROM ' +
            s +
            '.vacancies v CROSS JOIN LATERAL jsonb_array_elements_text(v.labels->$' +
            (p.args.length + 1) +
            ') label(value) WHERE ' +
            p.sql +
            ' GROUP BY label.value ORDER BY label.value COLLATE "C"',
          [...p.args, label],
        );
        facets[key] = result.rows;
      }
      const report = filters.organizationId
        ? ((
            await query('SELECT data FROM ' + s + '.coverage WHERE organization_id=$1', [
              filters.organizationId,
            ])
          ).rows[0]?.data ?? null)
        : null;
      return {
        vacancies: rows.map(vacancyView),
        matching,
        total: await vacancies.count(),
        facets,
        nextOffset: offset + limit < matching ? offset + limit : null,
        coverage: report,
      };
    },
    async count() {
      return Number((await query('SELECT count(*) FROM ' + s + '.vacancies')).rows[0].count);
    },
    async get(id) {
      const row = (await dataRows('SELECT data FROM ' + s + '.vacancies WHERE id=$1', [id]))[0];
      return row ? vacancyView(row) : null;
    },
    async needsRefresh(id) {
      return !(
        await query(
          'SELECT 1 FROM ' +
            s +
            '.jobs WHERE organization_id=$1 AND (source_pause_reason IS NOT NULL OR eligible_at>clock_timestamp())',
          [id],
        )
      ).rowCount;
    },
    async nextCheckAt(id) {
      const row = (
        await query(
          'SELECT extract(epoch FROM eligible_at)*1000 AS time FROM ' +
            s +
            '.jobs WHERE organization_id=$1',
          [id],
        )
      ).rows[0];
      return Number(row?.time ?? 0);
    },
    async batchSchedule() {
      return collectionMetadata();
    },
    async nextPassAtForCatalog() {
      return (await collectionMetadata()).oldestDueAt ?? Date.now() + DAY;
    },
    async nextPassAt() {
      return vacancies.nextPassAtForCatalog();
    },
    async observe(org, result) {
      requireOperator();
      await worker.startRound();
      const claim = await worker.claim();
      requireThat(claim?.organizationId === org.id, 'Use worker queue order to publish');
      return worker.publish(claim, {
        ...result,
        organizationOutcome: {
          status: result.postings?.length
            ? 'openings-observed'
            : result.inventory?.complete
              ? 'no-openings-observed'
              : 'unknown',
          openingCount: result.inventory?.urls?.length ?? 0,
          sources: result.inventory?.sources ?? [],
          ats: [],
        },
      });
    },
    async fail(org) {
      requireOperator();
      await worker.startRound();
      const claim = await worker.claim();
      requireThat(claim?.organizationId === org.id, 'Use queue order');
      return worker.fail(claim, { category: 'source-unavailable' });
    },
  };
  async function importSnapshot(input) {
    requireOperator();
    keys(
      input,
      [
        'sourceHash',
        'mappingVersion',
        'organizations',
        'vacancies',
        'coverage',
        'schedule',
        'legacyMigrations',
      ],
      'import',
    );
    requireThat(
      /^[a-f0-9]{64}$/.test(input.sourceHash) && input.mappingVersion === MAP,
      'Invalid migration provenance',
    );
    requireThat(
      Array.isArray(input.organizations) && Array.isArray(input.vacancies),
      'Invalid import collections',
    );
    const orgs = input.organizations.map(organization),
      rows = input.vacancies.map(vacancy),
      orgIds = new Set(orgs.map((row) => row.id)),
      domains = new Set(orgs.map((row) => row.domain));
    requireThat(
      orgIds.size === orgs.length && domains.size === orgs.length,
      'Conflicting organization identity',
    );
    const ids = new Set(),
      identities = new Set();
    for (const row of rows) {
      requireThat(
        orgIds.has(row.organizationId) &&
          !ids.has(row.id) &&
          !identities.has(row.organizationId + '\n' + row.identity),
        'Invalid/duplicate vacancy identity',
      );
      ids.add(row.id);
      identities.add(row.organizationId + '\n' + row.identity);
    }
    const reports = input.coverage ?? {};
    requireThat(
      reports && typeof reports === 'object' && !Array.isArray(reports),
      'Invalid coverage mapping',
    );
    for (const [id, report] of Object.entries(reports)) {
      requireThat(orgIds.has(id), 'Unknown coverage organization');
      coverage(report);
    }
    if (input.schedule) {
      keys(input.schedule, ['nextBatchAt'], 'legacy schedule');
      timestamp(input.schedule.nextBatchAt);
    }
    const legacyMigrations = legacyLedger(input.legacyMigrations ?? []);
    const manifestHash = sha(
      encoded({ orgs, rows, reports, schedule: input.schedule ?? null, legacyMigrations }),
    );
    const batch = input.sourceHash + ':' + input.mappingVersion;
    const previous = (
      await query(
        'SELECT * FROM ' + s + '.import_batches WHERE source_hash=$1 AND mapping_version=$2',
        [input.sourceHash, input.mappingVersion],
      )
    ).rows[0];
    if (previous) {
      requireThat(previous.manifest_hash === manifestHash, 'Migration source drift');
      if (previous.state === 'complete')
        return { organizations: orgs.length, vacancies: rows.length };
    }
    const destination = Number(
      (
        await query(
          'SELECT (SELECT count(*) FROM ' +
            s +
            '.organizations)+(SELECT count(*) FROM ' +
            s +
            '.vacancies) AS count',
        )
      ).rows[0].count,
    );
    requireThat(destination === 0, 'Refusing import into nonempty destination');
    await transaction((q) =>
      q(
        'INSERT INTO ' +
          s +
          ".import_batches(source_hash,mapping_version,state,manifest_hash) VALUES($1,$2,'staging',$3) ON CONFLICT DO NOTHING",
        [input.sourceHash, input.mappingVersion, manifestHash],
      ),
    );
    for (const [kind, values] of [
      ['organization', orgs],
      ['vacancy', rows],
    ])
      for (let start = 0; start < values.length; start += 200)
        await transaction(async (q) => {
          for (const row of values.slice(start, start + 200))
            await q(
              'INSERT INTO ' +
                s +
                '.import_stage(batch,kind,id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(batch,kind,id) DO NOTHING',
              [
                batch,
                kind,
                row.id,
                JSON.stringify(
                  kind === 'vacancy'
                    ? projection(row)
                    : { ...row, sortName: row.name.toLowerCase() },
                ),
              ],
            );
        });
    return transaction(async (q) => {
      const control = (await q('SELECT * FROM ' + s + '.control WHERE singleton FOR UPDATE'))
        .rows[0];
      requireThat(control.active_batch === 'empty', 'Import destination already published');
      await q(
        'INSERT INTO ' +
          s +
          ".organizations(id,domain,name,sort_name,industry,data) SELECT payload->>'id',payload->>'domain',payload->>'name',payload->>'sortName',payload->>'industryGroup',payload-'sortName' FROM " +
          s +
          ".import_stage WHERE batch=$1 AND kind='organization'",
        [batch],
      );
      await q('INSERT INTO ' + s + '.jobs(organization_id) SELECT id FROM ' + s + '.organizations');
      await q(
        'INSERT INTO ' +
          s +
          ".vacancies(id,organization_id,identity,data,labels,search_text,location_text,last_seen_at,checked_at,expires_at) SELECT payload->'data'->>'id',payload->'data'->>'organizationId',payload->'data'->>'identity',payload->'data',payload->'labels',payload->>'searchText',payload->>'locationText',coalesce((payload->'data'->>'lastSeenAt')::bigint,0),coalesce((payload->'data'->>'checkedAt')::bigint,0),(payload->>'expiresAt')::bigint FROM " +
          s +
          ".import_stage WHERE batch=$1 AND kind='vacancy'",
        [batch],
      );
      for (const [id, report] of Object.entries(reports)) {
        await q('INSERT INTO ' + s + '.coverage(organization_id,data) VALUES($1,$2)', [
          id,
          JSON.stringify(report),
        ]);
        await q(
          'UPDATE ' + s + '.jobs SET eligible_at=to_timestamp($2/1000.0) WHERE organization_id=$1',
          [
            id,
            report.nextRefreshAt ??
              Math.max(report.checkedAt ?? 0, report.lastAttemptAt ?? 0) + DAY,
          ],
        );
      }
      if (input.schedule)
        await q('INSERT INTO ' + s + ".metadata(key,value) VALUES('legacySchedule',$1)", [
          JSON.stringify(input.schedule),
        ]);
      await q('INSERT INTO ' + s + ".metadata(key,value) VALUES('legacyMigrations',$1)", [
        JSON.stringify(legacyMigrations),
      ]);
      await q('UPDATE ' + s + '.control SET active_batch=$1 WHERE singleton', [batch]);
      await q(
        'UPDATE ' +
          s +
          ".import_batches SET state='complete' WHERE source_hash=$1 AND mapping_version=$2",
        [input.sourceHash, input.mappingVersion],
      );
      await q('DELETE FROM ' + s + '.import_stage WHERE batch=$1', [batch]);
      return { organizations: orgs.length, vacancies: rows.length };
    });
  }
  async function snapshot() {
    requireOperator();
    const orgs = await dataRows('SELECT data FROM ' + s + '.organizations ORDER BY id COLLATE "C"'),
      rows = await dataRows('SELECT data FROM ' + s + '.vacancies ORDER BY id COLLATE "C"'),
      reports = (
        await query(
          'SELECT organization_id,data FROM ' +
            s +
            '.coverage ORDER BY organization_id COLLATE "C"',
        )
      ).rows;
    const provenance =
      (await query('SELECT value FROM ' + s + ".metadata WHERE key='legacyMigrations'")).rows[0]
        ?.value ?? [];
    return {
      organizations: orgs,
      vacancies: rows,
      coverage: Object.fromEntries(reports.map((row) => [row.organization_id, row.data])),
      legacyMigrations: provenance,
    };
  }
  async function collectionMetadata() {
    const result = (await query('SELECT ' + s + '.collection_meta() AS result')).rows[0].result;
    if (operator)
      result.sourcePauses = (
        await query(
          'SELECT organization_id AS "organizationId",source_pause_reason AS reason,CASE WHEN source_retry_at IS NULL THEN NULL ELSE floor(extract(epoch FROM source_retry_at)*1000)::bigint END AS "retryAt" FROM ' +
            s +
            '.jobs WHERE source_pause_reason IS NOT NULL ORDER BY organization_id COLLATE "C"',
        )
      ).rows.map((row) => ({ ...row, retryAt: row.retryAt === null ? null : Number(row.retryAt) }));
    return result;
  }
  const worker = {
    async startRound() {
      return (await query('SELECT ' + s + '.start_round() AS result')).rows[0].result;
    },
    async claim() {
      return (await query('SELECT ' + s + '.claim_turn() AS result')).rows[0].result;
    },
    async heartbeat(claim) {
      return (
        await query('SELECT ' + s + '.heartbeat_turn($1::jsonb) AS result', [JSON.stringify(claim)])
      ).rows[0].result;
    },
    async publish(claim, result) {
      keys(result, ['postings', 'inventory', 'organizationOutcome'], 'worker result');
      requireThat(
        Array.isArray(result.postings) && result.postings.length <= 100000,
        'Invalid posting collection',
      );
      keys(result.inventory, ['urls', 'sources', 'complete'], 'inventory');
      const known = new Set(
          urls(result.inventory.urls ?? [], { max: 100000 }).map(listingIdentity),
        ),
        sources = urls(result.inventory.sources ?? []);
      requireThat(typeof result.inventory.complete === 'boolean', 'Missing source completeness');
      const company = (
        await dataRows('SELECT data FROM ' + s + '.organizations WHERE id=$1', [
          claim.organizationId,
        ])
      )[0];
      requireThat(company, 'Unknown claim organization');
      const current = await dataRows(
          'SELECT data FROM ' + s + '.vacancies WHERE organization_id=$1',
          [claim.organizationId],
        ),
        byIdentity = new Map(current.map((row) => [row.identity, row]));
      const at = Date.now();
      for (const previous of current) {
        previous.checkedAt = at;
        if (known.has(previous.identity)) {
          previous.lastSeenAt = at;
          previous.observedStatus = 'active';
        } else previous.observedStatus = 'unknown';
      }
      for (const posting of result.postings) {
        keys(
          posting,
          [
            'url',
            'title',
            'text',
            'location',
            'facts',
            'sources',
            'publishedAt',
            'validThrough',
            'textTruncated',
          ],
          'posting',
        );
        const url = validatePublicUrl(posting.url).href,
          identity = listingIdentity(url);
        requireThat(
          known.has(identity) || (posting.sources ?? []).includes(company.careers),
          'Posting lacks inventory evidence',
        );
        const title = String(posting.title ?? '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
            .trim()
            .slice(0, 200),
          text = String(posting.text ?? '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
            .trim()
            .slice(0, 10000);
        requireThat(title && text, 'Posting requires title and excerpt');
        const old = byIdentity.get(identity),
          contentHash = sha(title + '\n' + text);
        byIdentity.set(
          identity,
          vacancy({
            ...old,
            id: old?.id ?? 'vac-' + sha(company.id + '\n' + identity).slice(0, 32),
            organizationId: company.id,
            identity,
            url,
            companyName: company.name,
            domain: company.domain,
            title,
            text,
            location: String(posting.location ?? '')
              .trim()
              .slice(0, 300),
            facts: normalizeVacancyFacts(posting.facts ?? {}),
            sources: urls(posting.sources, { required: true }),
            industryGroup: company.industryGroup,
            publishedAt: date(posting.publishedAt),
            validThrough: date(posting.validThrough),
            textTruncated: String(posting.text).length > 10000,
            contentHash,
            firstSeenAt: old?.firstSeenAt ?? at,
            lastSeenAt: at,
            checkedAt: at,
            textFetchedAt: at,
            changedAt: !old || old.contentHash !== contentHash ? at : old.changedAt,
            observedStatus: 'active',
          }),
        );
      }
      const records = [...byIdentity.values()].map((row) => projection(vacancy(row))),
        storedKnown = records.filter((row) => known.has(row.data.identity)).length;
      const report = {
        checkedAt: at,
        nextRefreshAt: at + DAY,
        complete: result.inventory.complete,
        knownListings: known.size,
        stored: records.length,
        truncated: known.size > storedKnown,
        status: 'checked',
        storageLimited: false,
      };
      const companyOutcome = observation(
        result.organizationOutcome ?? {
          status: result.postings.length ? 'openings-observed' : 'unknown',
          openingCount: known.size,
          sources,
          ats: [],
        },
      );
      return (
        await query(
          'SELECT ' + s + '.publish_turn($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) AS result',
          [
            JSON.stringify(claim),
            JSON.stringify(records),
            JSON.stringify(report),
            JSON.stringify(companyOutcome),
          ],
        )
      ).rows[0].result;
    },
    async fail(claim, { category = 'source-unavailable', retryAfter = undefined } = {}) {
      return (
        await query('SELECT ' + s + '.fail_turn($1::jsonb,$2,$3) AS result', [
          JSON.stringify(claim),
          category,
          typeof retryAfter === 'string' &&
          Buffer.byteLength(retryAfter, 'utf8') <= 128 &&
          !retryAfter.includes('\0')
            ? retryAfter
            : null,
        ])
      ).rows[0].result;
    },
    async resumeSource(organizationId) {
      requireOperator();
      return (await query('SELECT ' + s + '.resume_source($1) AS result', [organizationId])).rows[0]
        .result;
    },
    async rotateEpoch() {
      requireOperator();
      return transaction(
        async (q) => {
          const result = (
            await q(
              'UPDATE ' +
                s +
                '.control SET epoch=epoch+1,paused=true WHERE singleton RETURNING epoch',
            )
          ).rows[0];
          await q('UPDATE ' + s + ".runs SET state='interrupted' WHERE state='claimed'");
          await q(
            'UPDATE ' + s + ".members SET state='interrupted' WHERE state IN ('pending','claimed')",
          );
          await q('UPDATE ' + s + ".rounds SET state='complete' WHERE state='active'");
          return { epoch: Number(result.epoch) };
        },
        { maintenance: true },
      );
    },
    async resume() {
      requireOperator();
      await transaction((q) => q('UPDATE ' + s + '.control SET paused=false WHERE singleton'));
    },
    metadata: collectionMetadata,
  };
  async function attestCapacity(observation) {
    requireOperator();
    return (
      await query('SELECT ' + s + '.attest_capacity($1::jsonb) AS result', [
        JSON.stringify(observation),
      ])
    ).rows[0].result;
  }
  if (capacityObservation !== undefined) await attestCapacity(capacityObservation);
  return {
    organizations,
    vacancies,
    worker,
    importSnapshot,
    snapshot,
    collectionMetadata,
    collection: collectionMetadata,
    namespace,
    attestCapacity,
    async close() {
      if (!closed) {
        closed = true;
        await pool.end();
      }
    },
  };
}
