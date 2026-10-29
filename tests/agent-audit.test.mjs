// Fully fictional public-release fixture; no personal career record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const auditURL = new URL('../app/agent-audit.mjs', import.meta.url);
const mod = () => import(auditURL);
const actor = {
  type: 'agent',
  role: 'assessor',
  id: 'fixture-assessor',
  codeRevision: 'a'.repeat(64),
  promptHash: 'b'.repeat(64),
  provider: 'fixture',
  model: 'fixture',
  mode: 'fixture',
};
const event = (extra = {}) => ({
  eventId: randomUUID(),
  traceId: 'trace-one',
  spanId: 'span-one',
  vacancyKey: 'vacancy-one',
  actor,
  action: 'assessment',
  status: 'rejected',
  reasonCode: 'EVIDENCE_UNSUPPORTED',
  reason: 'Candidate evidence does not support the requirement.',
  at: '2026-10-22T10:00:00.123Z',
  ...extra,
});
const status = (n) => (e) => e.status === n;
test('AU01 rejected unsaved vacancy retains typed actor timestamp evidence and immutable ordered sequence', async () => {
  const a = await mod(),
    blank = a.createAudit();
  const one = a.appendAudit(
    blank,
    event({ evidenceRefs: [{ factId: 'f1', quote: 'Led platform delivery.' }] }),
  );
  const two = a.appendAudit(
    one,
    event({ traceId: 'trace-two', reason: 'Reviewed another requirement.' }),
  );
  assert.equal(blank.events.length, 0);
  assert.equal(two.events.length, 2);
  assert.equal(two.events[0].vacancyKey, 'vacancy-one');
  assert.equal(two.events[0].actor.model, 'fixture');
  assert.equal(two.events[0].at, '2026-10-22T10:00:00.123Z');
  assert.ok(two.events[1].sequence > two.events[0].sequence);
  assert.equal(two.commitRevision, 2);
  a.validateAudit(two);
});
test('AU02 event replay is idempotent while identity reuse with altered decision refuses', async () => {
  const a = await mod(),
    e = event(),
    one = a.appendAudit(a.createAudit(), e);
  assert.deepEqual(a.appendAudit(one, e), one);
  assert.throws(() => a.appendAudit(one, { ...e, reason: 'Changed grounds.' }), status(409));
});
test('AU03 snapshots deduplicate and export contains exact evidence while reads never mutate history', async () => {
  const a = await mod(),
    data = { facts: [{ id: 'f1', text: 'Led platform delivery with 37% improvement.' }] },
    snapshot = { kind: 'profile', data };
  let log = a.appendAudit(a.createAudit(), event(), { snapshots: [snapshot] });
  log = a.appendAudit(log, event({ traceId: 'two' }), { snapshots: [snapshot] });
  assert.equal(Object.keys(log.snapshots).length, 1);
  const before = JSON.stringify(log),
    page = a.queryAudit(log, { vacancyKey: 'vacancy-one', limit: 1 });
  assert.equal(page.events.length, 1);
  assert.ok(page.cursor);
  const next = a.queryAudit(log, { after: page.cursor, limit: 1 });
  assert.equal(next.events.length, 1);
  assert.notEqual(next.events[0].eventId, page.events[0].eventId);
  const lines = a
    .exportAudit(log)
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
  assert.ok(lines.some((x) => JSON.stringify(x).includes('37% improvement')));
  assert.equal(JSON.stringify(log), before);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024);
});
test('AU04 corruption unknown schema secret fields and oversized UTF8 events are refused', async () => {
  const a = await mod(),
    one = a.appendAudit(a.createAudit(), event());
  const bad = structuredClone(one);
  bad.events[0].reason = 'Tampered reason';
  assert.throws(() => a.validateAudit(bad));
  for (const e of [
    event({ apiKey: 'secret' }),
    event({ actor: { ...actor, authorization: 'secret' } }),
    event({ reason: '漢'.repeat(5000) }),
  ])
    assert.throws(() => a.appendAudit(a.createAudit(), e));
});
test('AU05 interrupted recovery retains start and records recovery time without fabricated provider finish', async () => {
  const a = await mod(),
    one = a.appendAudit(
      a.createAudit(),
      event({ status: 'start', reasonCode: 'STARTED', reason: 'Assessment started.' }),
    );
  const recovered = a.recoverAudit(one, { now: '2026-10-22T11:00:00.000Z' });
  assert.equal(recovered.events.length, 2);
  const last = recovered.events.at(-1);
  assert.equal(last.status, 'interrupted');
  assert.equal(last.recoveryAt, '2026-10-22T11:00:00.000Z');
  assert.equal(last.finishedAt ?? null, null);
  assert.deepEqual(a.recoverAudit(recovered, { now: '2026-10-22T12:00:00.000Z' }), recovered);
});
test('AU06 at most four open spans reserve terminal slots before further work', async () => {
  const a = await mod();
  let log = a.createAudit();
  for (let i = 0; i < 4; i++)
    log = a.appendAudit(
      log,
      event({ spanId: 's' + i, status: 'start', reasonCode: 'STARTED', reason: 'Stage started.' }),
    );
  assert.throws(() => a.appendAudit(log, event({ spanId: 's4', status: 'start' })), status(507));
  log = a.appendAudit(
    log,
    event({
      spanId: 's0',
      status: 'failed',
      reasonCode: 'PROVIDER_FAILED',
      reason: 'Provider failed.',
    }),
  );
  assert.doesNotThrow(() => a.appendAudit(log, event({ spanId: 's4', status: 'start' })));
});
test('AU07 byte capacity refuses without mutating retained history and keeps export readable', async () => {
  const a = await mod();
  let log = a.createAudit(),
    refused = false;
  for (let i = 0; i < 40; i++) {
    const previous = JSON.stringify(log);
    try {
      log = a.appendAudit(log, event({ traceId: 'large' + i }), {
        snapshots: [{ kind: 'job', data: { text: String(i) + ' ' + 'x'.repeat(480000) } }],
      });
    } catch (e) {
      assert.equal(e.status, 507);
      assert.equal(JSON.stringify(log), previous);
      refused = true;
      break;
    }
  }
  assert.ok(refused);
  assert.ok(Buffer.byteLength(JSON.stringify(log)) <= 16 * 1024 * 1024);
  assert.ok(a.exportAudit(log).length > 0);
});
test('AU08 filters do not blend application attempts or erase prior human overrides', async () => {
  const a = await mod();
  let log = a.createAudit();
  for (const attempt of ['attempt1', 'attempt2'])
    log = a.appendAudit(log, event({ applicationAttemptId: attempt, opportunityId: 'saved1' }));
  log = a.appendAudit(
    log,
    event({
      applicationAttemptId: 'attempt1',
      actor: { type: 'user', role: 'candidate', mode: 'manual' },
      status: 'accepted',
      reasonCode: 'HUMAN_OVERRIDE',
      reason: 'Candidate chose to continue.',
    }),
  );
  const p = a.queryAudit(log, { applicationAttemptId: 'attempt1' });
  assert.equal(p.events.length, 2);
  assert.equal(p.events[0].actor.type, 'agent');
  assert.equal(p.events[1].actor.type, 'user');
  assert.equal(a.queryAudit(log, { applicationAttemptId: 'attempt2' }).events.length, 1);
});

import { createHash } from 'node:crypto';
// Independent literal wire builder avoids quadratic application append calls for large-bound tests.
function largeWire(count, targetBytes) {
  const canonical = (v) =>
    Array.isArray(v)
      ? '[' + v.map(canonical).join(',') + ']'
      : v && typeof v === 'object'
        ? '{' +
          Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
            .join(',') +
          '}'
        : JSON.stringify(v);
  const log = {
    version: 1,
    commitRevision: 1,
    nextSequence: count + 1,
    headHash: '0'.repeat(64),
    events: [],
    snapshots: {},
  };
  const base = {
    ...event(),
    sequence: count,
    previousHash: '0'.repeat(64),
    hash: '0'.repeat(64),
    reason: 'x',
  };
  const length = Math.max(
    1,
    Math.floor((targetBytes - 1000) / count) - Buffer.byteLength(JSON.stringify(base)) - 1,
  );
  for (let i = 1; i <= count; i++) {
    const row = {
      ...event({ reason: 'x'.repeat(length) }),
      sequence: i,
      previousHash: log.headHash,
    };
    row.hash = createHash('sha256').update(canonical(row)).digest('hex');
    log.events.push(row);
    log.headHash = row.hash;
  }
  return log;
}
test('AU09 more than ten thousand small events remain valid below byte cap without hidden count eviction', async () => {
  const a = await mod(),
    log = largeWire(10001, 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(log)) < 16 * 1024 * 1024);
  assert.doesNotThrow(() => a.validateAudit(log));
  assert.equal(a.queryAudit(log, { after: 10000 }).events.length, 1);
});
test('AU10 a valid near-cap history still exports every event despite JSONL framing overhead', async () => {
  const a = await mod(),
    log = largeWire(12001, 16 * 1024 * 1024 - 6000);
  assert.ok(Buffer.byteLength(JSON.stringify(log)) < 16 * 1024 * 1024);
  a.validateAudit(log);
  const output = a.exportAudit(log),
    events = output
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x))
      .filter((x) => x.type === 'event');
  assert.equal(events.length, 12001);
  assert.ok(Buffer.byteLength(output) <= 32 * 1024 * 1024);
});

test('AU11 vacancy history includes its source ancestors without unrelated employer trace', async () => {
  const a = await mod();
  let log = a.createAudit();
  for (const company of ['source-A', 'source-B']) {
    log = a.appendAudit(
      log,
      event({
        spanId: company,
        vacancyKey: null,
        status: 'start',
        action: 'discovery',
        reasonCode: 'STARTED',
      }),
    );
    log = a.appendAudit(
      log,
      event({
        spanId: company,
        vacancyKey: null,
        status: 'observed',
        action: 'discovery',
        reasonCode: 'SOURCE_OBSERVED',
      }),
    );
  }
  for (const action of ['requirement-review', 'extraction-repair', 'source-check'])
    log = a.appendAudit(
      log,
      event({
        spanId: action,
        parentSpanId: 'source-A',
        vacancyKey: null,
        status: 'observed',
        action,
      }),
    );
  log = a.appendAudit(
    log,
    event({
      spanId: 'assess-A',
      parentSpanId: 'source-A',
      vacancyKey: 'vacancy-A',
      status: 'rejected',
    }),
  );
  const page = a.queryAudit(log, { vacancyKey: 'vacancy-A' });
  assert.ok(page.events.some((e) => e.spanId === 'source-A'));
  assert.ok(!page.events.some((e) => e.spanId === 'source-B'));
  assert.ok(page.events.some((e) => e.vacancyKey === 'vacancy-A'));
  for (const action of ['requirement-review', 'extraction-repair', 'source-check'])
    assert.ok(
      page.events.some((e) => e.action === action),
      'missing source agent stage ' + action,
    );
});
