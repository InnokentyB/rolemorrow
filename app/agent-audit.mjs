import { createHash, randomUUID } from 'node:crypto';
const MAX = 16 * 1024 * 1024,
  RESERVE = 64 * 1024,
  SLOT = 8192,
  RESERVATION = SLOT + 1024,
  ZERO = '0'.repeat(64);
const statuses = new Set(
  'start proposed accepted rejected failed cancelled stale interrupted observed unknown simulated'.split(
    ' ',
  ),
);
const failure = (message, status = 400) => {
  throw Object.assign(new Error('Audit: ' + message), { status });
};
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
const hash = (v) => createHash('sha256').update(canonical(v)).digest('hex');
function json(v, depth = 0) {
  if (depth > 40) failure('nested data');
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) failure('number');
    return;
  }
  if (typeof v === 'string') return;
  if (Array.isArray(v)) {
    if (v.length > MAX) failure('array');
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) failure('sparse array');
      json(v[i], depth + 1);
    }
    return;
  }
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) failure('JSON object');
  for (const [k, x] of Object.entries(v)) {
    if (
      /^(?:__proto__|prototype|constructor|authorization|apiKey|api_key|accessToken|password|secret|rawResponse|reasoning|chainOfThought|base64)$/i.test(
        k,
      )
    )
      failure('unsafe field');
    json(x, depth + 1);
  }
}
function shape(v, required, optional = []) {
  if (!v || Array.isArray(v) || typeof v !== 'object') failure('object required');
  for (const k of required) if (!Object.hasOwn(v, k)) failure('missing ' + k);
  for (const k of Object.keys(v))
    if (!required.includes(k) && !optional.includes(k)) failure('unknown ' + k);
}
function text(v, max = 200, nullable = false) {
  if (nullable && v === null) return;
  if (typeof v !== 'string' || !v.trim() || v.length > max) failure('bounded text');
}
const integer = (v) => {
  if (!Number.isSafeInteger(v) || v < 0) failure('integer');
};
function iso(v) {
  text(v, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)))
    failure('UTC timestamp');
}
function digest(v) {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) failure('digest');
}
function snapshot(s) {
  json(s);
  shape(s, ['kind', 'data']);
  if (!['profile', 'job', 'packet', 'proposal'].includes(s.kind)) failure('snapshot kind');
  const fields = {
    profile: ['version', 'profileVersion', 'facts', 'goal', 'preferences', 'savedAt'],
    job: [
      'vacancyKey',
      'catalogId',
      'id',
      'title',
      'company',
      'url',
      'text',
      'requirements',
      'source',
      'countries',
      'workMode',
      'salary',
      'profileVersion',
      'evidencePolicy',
      'checkedAt',
      'sourceAuthority',
      'authorizationRequirement',
      'companyIndustry',
    ],
    packet: [
      'cvVersion',
      'cvText',
      'coverLetter',
      'answers',
      'revision',
      'profileVersion',
      'opportunityHash',
      'files',
    ],
    proposal: [
      'stage',
      'profileVersion',
      'document',
      'assessment',
      'classification',
      'verification',
      'issues',
    ],
  };
  shape(s.data, [], fields[s.kind]);
  if (s.kind === 'proposal') text(s.data.stage);
  if (s.kind === 'profile' && s.data.facts !== undefined) {
    if (!Array.isArray(s.data.facts) || s.data.facts.length > 256) failure('facts');
    for (const f of s.data.facts) {
      shape(f, ['id', 'text']);
      text(f.id);
      text(f.text, 500000);
    }
  }
  if (s.kind === 'packet' && s.data.files !== undefined) {
    if (!Array.isArray(s.data.files)) failure('files');
    for (const f of s.data.files) shape(f, [], ['id', 'name', 'type', 'size', 'hash', 'sha256']);
  }
  if (bytes(s) > 512 * 1024) failure('snapshot capacity', 507);
}
export function snapshotDigest(s) {
  snapshot(s);
  return hash(s);
}
export function createAudit() {
  return {
    version: 1,
    commitRevision: 0,
    nextSequence: 1,
    headHash: ZERO,
    events: [],
    snapshots: {},
  };
}
const inputFields = [
  'eventId',
  'traceId',
  'spanId',
  'parentSpanId',
  'operationId',
  'idempotencyKey',
  'vacancyKey',
  'opportunityId',
  'applicationAttemptId',
  'packetRevision',
  'actor',
  'action',
  'status',
  'reasonCode',
  'reason',
  'at',
  'durationMs',
  'recoveryAt',
  'snapshotRefs',
  'evidenceRefs',
  'usage',
];
function event(e, stored = false) {
  json(e);
  shape(
    e,
    ['eventId', 'traceId', 'actor', 'action', 'status', 'reasonCode', 'reason', 'at'],
    [...inputFields, ...(stored ? ['sequence', 'previousHash', 'hash'] : [])],
  );
  text(e.eventId, 100);
  text(e.traceId);
  for (const k of ['spanId', 'operationId', 'idempotencyKey']) if (e[k] !== undefined) text(e[k]);
  for (const k of ['parentSpanId', 'vacancyKey', 'opportunityId', 'applicationAttemptId'])
    if (e[k] !== undefined) text(e[k], 1000, true);
  for (const k of ['packetRevision', 'durationMs'])
    if (e[k] !== undefined && e[k] !== null) integer(e[k]);
  if (!statuses.has(e.status)) failure('status');
  if (e.status === 'start' && !e.spanId) failure('start span required');
  text(e.action);
  text(e.reasonCode);
  text(e.reason, 3000);
  iso(e.at);
  if (e.recoveryAt !== undefined) iso(e.recoveryAt);
  shape(
    e.actor,
    ['type', 'role', 'mode'],
    ['id', 'codeRevision', 'promptHash', 'provider', 'model'],
  );
  if (!['agent', 'system', 'user', 'employer'].includes(e.actor.type)) failure('actor type');
  for (const v of Object.values(e.actor)) text(v, 200, true);
  if (e.snapshotRefs !== undefined) {
    if (!Array.isArray(e.snapshotRefs) || e.snapshotRefs.length > 32) failure('snapshot refs');
    for (const d of e.snapshotRefs) digest(d);
  }
  if (e.evidenceRefs !== undefined) {
    if (!Array.isArray(e.evidenceRefs) || e.evidenceRefs.length > 32) failure('evidence');
    for (const x of e.evidenceRefs) {
      shape(x, ['factId', 'quote']);
      text(x.factId);
      text(x.quote, 1500);
    }
  }
  if (e.usage !== undefined && e.usage !== null) {
    shape(e.usage, [], ['inputTokens', 'outputTokens', 'totalTokens', 'cost']);
    for (const x of Object.values(e.usage))
      if (x !== null && (typeof x !== 'number' || !Number.isFinite(x) || x < 0)) failure('usage');
  }
  if (bytes(e) > SLOT) failure('event capacity', 507);
}
function opens(events) {
  const map = new Map();
  for (const e of events) {
    if (!e.spanId) continue;
    const k = JSON.stringify([e.traceId, e.spanId]);
    if (e.status === 'start') {
      if (map.has(k)) failure('duplicate open span', 409);
      map.set(k, e);
    } else map.delete(k);
  }
  return map;
}
export function validateAudit(a) {
  json(a);
  shape(a, ['version', 'commitRevision', 'nextSequence', 'headHash', 'events', 'snapshots']);
  if (a.version !== 1) failure('version');
  integer(a.commitRevision);
  integer(a.nextSequence);
  if (!Array.isArray(a.events) || !a.snapshots || Array.isArray(a.snapshots)) failure('aggregate');
  let prev = ZERO,
    seq = 1;
  const ids = new Set();
  for (const e of a.events) {
    event(e, true);
    if (e.sequence !== seq++ || e.previousHash !== prev || ids.has(e.eventId)) failure('sequence');
    ids.add(e.eventId);
    const { hash: h, ...content } = e;
    if (hash(content) !== h) failure('event hash');
    prev = h;
    for (const d of e.snapshotRefs ?? [])
      if (!Object.hasOwn(a.snapshots, d)) failure('missing snapshot');
  }
  if (a.headHash !== prev || a.nextSequence !== seq) failure('chain head');
  for (const [d, s] of Object.entries(a.snapshots)) {
    digest(d);
    if (snapshotDigest(s) !== d) failure('snapshot hash');
  }
  if (opens(a.events).size > 4) failure('open span capacity', 507);
  if (bytes(a) > MAX) failure('aggregate capacity', 507);
  return a;
}
export function appendAudit(a, input, { snapshots = [] } = {}) {
  validateAudit(a);
  json(input);
  shape(input, ['traceId', 'actor', 'action', 'status', 'reasonCode', 'reason'], inputFields);
  if (!Array.isArray(snapshots) || snapshots.length > 32) failure('snapshots');
  const prior = input.eventId && a.events.find((e) => e.eventId === input.eventId);
  const refs = [...(input.snapshotRefs ?? [])];
  const additions = {};
  for (const s of snapshots) {
    const d = snapshotDigest(s);
    additions[d] = structuredClone(s);
    if (!refs.includes(d)) refs.push(d);
  }
  const e = {
    ...structuredClone(input),
    eventId: input.eventId ?? randomUUID(),
    at: input.at ?? prior?.at ?? new Date().toISOString(),
    ...(refs.length ? { snapshotRefs: refs } : {}),
  };
  event(e);
  if (prior) {
    const old = { ...prior };
    delete old.sequence;
    delete old.previousHash;
    delete old.hash;
    if (canonical(e) !== canonical(old)) failure('event identity reused', 409);
    return structuredClone(a);
  }
  const next = structuredClone(a);
  Object.assign(next.snapshots, additions);
  const record = { ...e, sequence: a.nextSequence, previousHash: a.headHash };
  record.hash = hash(record);
  next.events.push(record);
  next.headHash = record.hash;
  next.nextSequence++;
  next.commitRevision++;
  const open = opens(next.events);
  if (open.size > 4) failure('open span capacity', 507);
  const emergency = e.status === 'interrupted' || e.reasonCode === 'AUDIT_CAPACITY';
  const ceiling = MAX - (emergency ? 0 : RESERVE) - open.size * RESERVATION;
  if (bytes(next) > ceiling) failure('aggregate capacity', 507);
  validateAudit(next);
  return next;
}
export function recoverAudit(a, { now = new Date().toISOString() } = {}) {
  validateAudit(a);
  iso(now);
  let next = a;
  for (const e of opens(a.events).values())
    next = appendAudit(next, {
      traceId: e.traceId,
      spanId: e.spanId,
      actor: { type: 'system', role: 'recovery', mode: 'recovery' },
      action: e.action,
      status: 'interrupted',
      reasonCode: 'RECOVERED_INTERRUPTION',
      reason: 'The persisted stage was interrupted; its outcome is unknown.',
      at: now,
      recoveryAt: now,
      ...(e.vacancyKey ? { vacancyKey: e.vacancyKey } : {}),
    });
  return structuredClone(next);
}
function filtered(a, f) {
  shape(
    f,
    [],
    [
      'vacancyKey',
      'opportunityId',
      'applicationAttemptId',
      'actorRole',
      'errorsOnly',
      'after',
      'limit',
    ],
  );
  for (const k of ['vacancyKey', 'opportunityId', 'applicationAttemptId', 'actorRole'])
    if (f[k] !== undefined) text(f[k], 1000);
  if (f.errorsOnly !== undefined && typeof f.errorsOnly !== 'boolean') failure('errors filter');
  const after = f.after ?? 0,
    limit = f.limit ?? 100;
  integer(after);
  integer(limit);
  if (limit < 1 || limit > 100) failure('page limit');
  const entityKeys = ['vacancyKey', 'opportunityId', 'applicationAttemptId'];
  const scoped = entityKeys.some((k) => f[k] !== undefined);
  const matches = (e) => entityKeys.every((k) => f[k] === undefined || e[k] === f[k]);
  const chosen = new Set(a.events.filter(matches).map((e) => e.eventId));
  if (f.applicationAttemptId !== undefined) {
    const packets = a.events.filter(
      (e) =>
        chosen.has(e.eventId) &&
        e.opportunityId &&
        Number.isSafeInteger(e.packetRevision) &&
        e.packetRevision >= 0 &&
        e.action.startsWith('dispatch'),
    );
    for (const e of a.events)
      if (
        e.action === 'packet-save' &&
        packets.some(
          (p) => e.opportunityId === p.opportunityId && e.packetRevision === p.packetRevision,
        )
      )
        chosen.add(e.eventId);
  }
  if (scoped) {
    const spanKey = (trace, span) => JSON.stringify([trace, span]);
    const bySpan = new Map();
    for (const e of a.events)
      if (e.spanId) {
        const key = spanKey(e.traceId, e.spanId);
        if (!bySpan.has(key)) bySpan.set(key, []);
        bySpan.get(key).push(e);
      }
    const visited = new Set(),
      queue = a.events.filter((e) => chosen.has(e.eventId));
    for (let index = 0; index < queue.length; index++) {
      const e = queue[index];
      if (!e.parentSpanId) continue;
      const key = spanKey(e.traceId, e.parentSpanId);
      if (visited.has(key)) continue;
      visited.add(key);
      for (const parent of bySpan.get(key) ?? []) {
        chosen.add(parent.eventId);
        queue.push(parent);
      }
    }
    // Source extraction/check stages have no per-vacancy identity yet. Include
    // only those beneath an actual ancestor, never sibling company discovery.
    const sourceActions = new Set([
      'extraction',
      'source_check',
      'sourcecheck',
      'source-check',
      'requirement-review',
      'extraction-repair',
      'normalization',
      'dedup',
      'deduplication',
    ]);
    for (const e of a.events)
      if (
        e.parentSpanId &&
        visited.has(spanKey(e.traceId, e.parentSpanId)) &&
        entityKeys.every((k) => e[k] === undefined || e[k] === null) &&
        sourceActions.has(e.action)
      )
        chosen.add(e.eventId);
    // A packet-save may point to a verified preparation request. Follow only
    // preparation descendants of that exact request trace, never another run.
    const prepSpans = new Set(
      a.events
        .filter((e) => chosen.has(e.eventId) && e.action === 'preparation:request' && e.spanId)
        .map((e) => spanKey(e.traceId, e.spanId)),
    );
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of a.events)
        if (
          e.action.startsWith('preparation:') &&
          e.parentSpanId &&
          prepSpans.has(spanKey(e.traceId, e.parentSpanId))
        ) {
          chosen.add(e.eventId);
          if (e.spanId) {
            const key = spanKey(e.traceId, e.spanId);
            if (!prepSpans.has(key)) {
              prepSpans.add(key);
              changed = true;
            }
          }
        }
    }
  }
  return a.events.filter(
    (e) =>
      chosen.has(e.eventId) &&
      e.sequence > after &&
      (f.actorRole === undefined || e.actor.role === f.actorRole) &&
      (!f.errorsOnly ||
        ['failed', 'rejected', 'cancelled', 'stale', 'interrupted', 'unknown'].includes(e.status)),
  );
}
export function queryAudit(a, f = {}) {
  validateAudit(a);
  const rows = filtered(a, f),
    events = [],
    snapshotRefs = [];
  let cursor = null;
  for (const e of rows) {
    const refs = [
      ...new Set([...snapshotRefs.map((x) => x.digest), ...(e.snapshotRefs ?? [])]),
    ].map((d) => ({
      digest: d,
      kind: a.snapshots[d].kind,
      bytes: bytes(a.snapshots[d]),
      available: true,
    }));
    if (
      events.length >= (f.limit ?? 100) ||
      bytes({ events: [...events, e], snapshotRefs: refs }) > 500 * 1024
    ) {
      cursor = events.at(-1)?.sequence ?? null;
      break;
    }
    events.push(e);
    snapshotRefs.splice(0, snapshotRefs.length, ...refs);
  }
  return {
    events: structuredClone(events),
    snapshotRefs,
    cursor,
    capacity: {
      bytes: bytes(a),
      maxBytes: MAX,
      reservedBytes: RESERVE,
      openSpans: opens(a.events).size,
      full: bytes(a) >= MAX - RESERVE - opens(a.events).size * RESERVATION,
    },
  };
}
export function exportAudit(a, f = {}) {
  validateAudit(a);
  const rows = filtered(a, f),
    refs = new Set(rows.flatMap((e) => e.snapshotRefs ?? []));
  const records = [
    {
      type: 'audit',
      version: 1,
      integrity: 'Corruption detection; not authenticated against administrator changes.',
    },
    ...[...refs].map((d) => ({ type: 'snapshot', digest: d, ...a.snapshots[d] })),
    ...rows.map((e) => ({ type: 'event', ...e })),
  ];
  const output = records.map((x) => JSON.stringify(x)).join('\n') + '\n';
  if (Buffer.byteLength(output) > MAX * 2) failure('export capacity', 507);
  return output;
}
