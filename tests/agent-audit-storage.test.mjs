import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// LOCK-RM-014-001: final private-boundary scenarios; synthetic files only.
const moduleURL = new URL('../app/private-storage.mjs', import.meta.url);
const accountId = '11111111-1111-4111-8111-111111111111';
const validUser = {
  id: accountId,
  email: 'private-fixture@example.test',
  name: 'Synthetic candidate',
  verified: true,
  mailboxTag: 'abcdef123456',
  passwordSalt: 'a'.repeat(64),
  passwordHash: 'b'.repeat(128),
  createdAt: 1720000000000,
};
const auth = (revision, users = [validUser]) => ({
  version: 1,
  commitRevision: revision,
  users,
  sessions: [],
  tokens: [],
  quotas: [],
});
const lifecycle = (revision, generation, active) => ({
  version: 1,
  commitRevision: revision,
  records: {
    [accountId]: {
      generation,
      active,
      deletedAt: active ? null : 1720000000000,
      transactionId: '22222222-2222-4222-8222-222222222222',
    },
  },
});
const workspace = (revision) => ({
  revision,
  mailSchema: 1,
  profile: null,
  companies: [],
  run: null,
  history: [],
  opportunities: [],
  applications: [],
  messages: [],
  replyDrafts: [],
  mailDispatches: [],
  mailEvents: [],
  notifications: [],
  webhookReceipts: [],
  mailReceivingPaused: false,
});
const transaction = (targets, expectedRevisions, extra = {}) => ({
  transactionId: randomUUID(),
  targets,
  expectedRevisions,
  ...extra,
});
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rm-private-red-'));
  const instances = [];
  t.after(async () => {
    for (const item of instances) await item.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const { openPrivateStorage } = await import(moduleURL);
  const open = async (extra) => {
    const store = await openPrivateStorage({ directory, bootstrap: true, ...options, ...extra });
    instances.push(store);
    return store;
  };
  return { directory, open };
}
const auditModule = () => import('../app/agent-audit.mjs');
const ae = (extra = {}) => ({
  eventId: randomUUID(),
  traceId: 'storage-trace',
  spanId: 'storage-span',
  actor: { type: 'system', role: 'validator', mode: 'fixture' },
  action: 'validation',
  status: 'accepted',
  reasonCode: 'VALIDATED',
  reason: 'Validated fixture.',
  at: '2026-10-22T10:00:00.123Z',
  ...extra,
});
async function seed(store) {
  store.commitSync(transaction([{ storeId: 'auth', value: auth(1), revision: 1 }], { auth: null }));
}
test('AS01 audit-only commit persists across restart without incrementing workspace revision', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  const wk = 'workspace:' + accountId,
    ak = 'audit:' + accountId;
  store.commitSync(
    transaction([{ storeId: wk, value: workspace(1), revision: 1 }], { [wk]: null }),
  );
  const log = a.appendAudit(a.createAudit(), ae());
  store.commitSync(
    transaction(
      [{ storeId: ak, value: log, revision: log.commitRevision }],
      { [ak]: null },
      { accountId, generation: 0 },
    ),
  );
  assert.equal(store.readSync(wk).revision, 1);
  await store.close();
  const next = await f.open();
  assert.deepEqual(next.readSync(ak), log);
  assert.equal(next.readSync(wk).revision, 1);
});
test('AS02 workspace and audit recover atomically after interrupted publish', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  const wk = 'workspace:' + accountId,
    ak = 'audit:' + accountId;
  await store.close();
  let injected = false;
  const faulted = await f.open({
    fault: (point) => {
      if (point === 'after-publish' && !injected) {
        injected = true;
        throw Error('Injected publish interruption');
      }
    },
  });
  const log = a.appendAudit(a.createAudit(), ae());
  await assert.rejects(
    faulted.commit(
      transaction(
        [
          { storeId: wk, value: workspace(1), revision: 1 },
          { storeId: ak, value: log, revision: log.commitRevision },
        ],
        { [wk]: null, [ak]: null },
        { accountId, generation: 0 },
      ),
    ),
  );
  await faulted.recover();
  assert.equal(faulted.readSync(wk).revision, 1);
  assert.deepEqual(faulted.readSync(ak), log);
});
test('AS03 foreign audit targets and inactive account generations refuse without changes', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  const ak = 'audit:' + accountId,
    foreign = 'audit:33333333-3333-4333-8333-333333333333',
    log = a.appendAudit(a.createAudit(), ae());
  assert.throws(() =>
    store.commitSync(
      transaction(
        [{ storeId: foreign, value: log, revision: 1 }],
        { [foreign]: null },
        { accountId, generation: 0 },
      ),
    ),
  );
  assert.throws(() =>
    store.commitSync(
      transaction(
        [{ storeId: ak, value: log, revision: 1 }],
        { [ak]: null },
        { accountId, generation: 1 },
      ),
    ),
  );
  assert.equal(store.readSync(ak), null);
});
test('AS04 deletion capability purges audit and workspace including audit-only account', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  const ak = 'audit:' + accountId,
    log = a.appendAudit(a.createAudit(), ae());
  store.commitSync(
    transaction(
      [{ storeId: ak, value: log, revision: 1 }],
      { [ak]: null },
      { accountId, generation: 0 },
    ),
  );
  store.commitSync(
    transaction(
      [
        { storeId: 'auth', value: auth(2, []), revision: 2 },
        { storeId: 'lifecycle', value: lifecycle(1, 1, false), revision: 1 },
      ],
      { auth: 1, lifecycle: null },
    ),
  );
  store.purgeDeletedWorkspaceSync(accountId);
  assert.equal(store.readSync(ak).events.length, 0);
  assert.ok(store.readSync(ak).commitRevision > 1);
  assert.throws(() =>
    store.commitSync(
      transaction(
        [{ storeId: ak, value: log, revision: 1 }],
        { [ak]: null },
        { accountId, generation: 0 },
      ),
    ),
  );
});

import { createServer } from '../app/server.mjs';
import { profile, companies, providers } from './fixtures.mjs';
async function inner(t, prepare, { timeout = 60000, preparationQuota } = {}) {
  const a = await auditModule(),
    f = await fixture(t),
    storage = await f.open();
  await seed(storage);
  let calls = 0;
  const server = createServer({
    storage,
    accountId,
    accountGeneration: 0,
    env: { PUBLIC_SERVICE: '1', CONTROLLED_LOCAL_MODE: '1' },
    preparationTimeoutMs: timeout,
    preparationQuota,
    providers: providers({
      prepareApplication: async (...args) => {
        calls++;
        return prepare(...args);
      },
    }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise((r) => server.close(r)));
  const call = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(origin + path, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json', Connection: 'close' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  await call('/api/profile', profile);
  await call('/api/companies', { companies });
  await call('/api/scans', { mode: 'fixture' });
  let state;
  for (let i = 0; i < 200; i++) {
    state = (await call('/api/state')).data;
    if (state.run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  state = (
    await call('/api/opportunities', {
      resultKey: state.run.results[0].key,
      baseRevision: state.revision,
    })
  ).data;
  const o = state.opportunities[0],
    body = {
      baseRevision: state.revision,
      revision: 0,
      profileVersion: state.profile.version,
      questions: [],
      consent: true,
      requestId: randomUUID(),
    };
  return { a, storage, server, call, o, body, calls: () => calls };
}
test('AS05 audit targets without account context refuse outside bootstrap', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  await store.close();
  const normal = await f.open({ bootstrap: false });
  const ak = 'audit:' + accountId,
    log = a.appendAudit(a.createAudit(), ae());
  assert.throws(() =>
    normal.commitSync(transaction([{ storeId: ak, value: log, revision: 1 }], { [ak]: null })),
  );
  assert.equal(normal.readSync(ak), null);
});
test('AS06 provider failure is retained with terminal reason while packet and revision remain unchanged', async (t) => {
  const h = await inner(t, async () => {
    throw Error('Synthetic upstream failure');
  });
  const before = h.storage.readSync('workspace:' + accountId),
    r = await h.call('/api/applications/' + h.o.id + '/prepare', h.body);
  assert.equal(r.status, 502);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.storage.readSync('workspace:' + accountId), before);
  const log = (await h.call('/api/audit?opportunityId=' + h.o.id)).data;
  assert.ok(log.events.some((e) => e.status === 'failed' && e.action.startsWith('preparation:')));
});
test('AS07 explicit cancellation records cancellation and late output cannot alter packet or append accepted verdict', async (t) => {
  let release, entered;
  const ready = new Promise((r) => (entered = r)),
    hold = new Promise((r) => (release = r));
  const h = await inner(t, async () => {
    entered();
    await hold;
    throw Error('Late synthetic output');
  });
  const before = h.storage.readSync('workspace:' + accountId),
    pending = h.call('/api/applications/' + h.o.id + '/prepare', h.body);
  await ready;
  const cancel = await h.call('/api/applications/' + h.o.id + '/prepare/cancel', {
    requestId: h.body.requestId,
  });
  assert.equal(cancel.status, 200);
  const response = await pending;
  assert.equal(response.status, 409);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.storage.readSync('workspace:' + accountId), before);
  const log = (await h.call('/api/audit?opportunityId=' + h.o.id)).data;
  assert.ok(log.events.some((e) => e.status === 'cancelled'));
  assert.ok(
    !log.events.some((e) => e.action.startsWith('preparation:') && e.status === 'accepted'),
  );
});
test('AS08 timeout records failed outcome without fabricating model output or usage', async (t) => {
  const h = await inner(
    t,
    async () => {
      await new Promise((r) => setTimeout(r, 80));
      throw Error('Late failure');
    },
    { timeout: 30 },
  );
  const before = h.storage.readSync('workspace:' + accountId),
    response = await h.call('/api/applications/' + h.o.id + '/prepare', h.body);
  assert.equal(response.status, 504);
  assert.deepEqual(h.storage.readSync('workspace:' + accountId), before);
  const log = (await h.call('/api/audit?opportunityId=' + h.o.id)).data;
  assert.ok(
    log.events.some(
      (e) =>
        ['failed', 'cancelled'].includes(e.status) &&
        /timeout|timed/i.test(e.reason + ' ' + e.reasonCode),
    ),
  );
  await new Promise((r) => setTimeout(r, 90));
});
test('AS09 capacity stops new provider action with zero calls and retains readable history', async (t) => {
  let quotaCalls = 0;
  const h = await inner(
      t,
      async () => {
        throw Error('Must never call');
      },
      {
        preparationQuota: async () => {
          quotaCalls++;
        },
      },
    ),
    ak = 'audit:' + accountId;
  let log = h.storage.readSync(ak),
    full = false;
  for (let i = 0; i < 40; i++) {
    try {
      log = h.a.appendAudit(log, ae({ traceId: 'fill' + i }), {
        snapshots: [{ kind: 'job', data: { text: String(i) + ' ' + 'z'.repeat(480000) } }],
      });
    } catch (e) {
      assert.equal(e.status, 507);
      full = true;
      break;
    }
  }
  assert.ok(full);
  const remaining = 16 * 1024 * 1024 - 64 * 1024 - Buffer.byteLength(JSON.stringify(log)) - 2048;
  assert.ok(remaining > 0 && remaining < 512 * 1024);
  log = h.a.appendAudit(log, ae({ traceId: 'tailfill' }), {
    snapshots: [{ kind: 'job', data: { text: 'q'.repeat(remaining) } }],
  });
  const current = h.storage.readSync(ak);
  h.storage.commitSync(
    transaction(
      [
        {
          storeId: ak,
          value: { ...log, commitRevision: current.commitRevision + 1 },
          revision: current.commitRevision + 1,
        },
      ],
      { [ak]: current.commitRevision },
      { accountId, generation: 0 },
    ),
  );
  const before = h.storage.readSync('workspace:' + accountId),
    result = await h.call('/api/applications/' + h.o.id + '/prepare', h.body);
  assert.equal(result.status, 507);
  assert.equal(h.calls(), 0);
  assert.equal(quotaCalls, 0, 'Full audit refuses before consuming preparation quota');
  assert.deepEqual(h.storage.readSync('workspace:' + accountId), before);
  assert.equal((await h.call('/api/audit')).status, 200);
});

test('AS10 clear workspace atomically clears audit with monotonically increasing physical revisions', async (t) => {
  const h = await inner(t, async () => {
      throw Error('Unused');
    }),
    wk = 'workspace:' + accountId,
    ak = 'audit:' + accountId,
    beforeW = h.storage.readSync(wk),
    beforeA = h.storage.readSync(ak);
  const response = await h.call('/api/data', undefined, 'DELETE');
  assert.equal(response.status, 200);
  const afterW = h.storage.readSync(wk),
    afterA = h.storage.readSync(ak);
  assert.equal(afterW.profile, null);
  assert.equal(afterW.opportunities.length, 0);
  assert.equal(afterA.events.length, 0);
  assert.deepEqual(afterA.snapshots, {});
  assert.ok(afterW.revision > beforeW.revision);
  assert.ok(afterA.commitRevision > beforeA.commitRevision);
});
test('AS11 deleted account with pending provider cannot resurrect audit or workspace on late result', async (t) => {
  let release, entered;
  const ready = new Promise((r) => (entered = r)),
    hold = new Promise((r) => (release = r));
  const h = await inner(t, async () => {
    entered();
    await hold;
    throw Error('Late provider failure');
  });
  const pending = h.call('/api/applications/' + h.o.id + '/prepare', h.body);
  await ready;
  h.storage.commitSync(
    transaction(
      [
        { storeId: 'auth', value: auth(2, []), revision: 2 },
        { storeId: 'lifecycle', value: lifecycle(1, 1, false), revision: 1 },
      ],
      { auth: 1, lifecycle: null },
    ),
  );
  h.storage.purgeDeletedWorkspaceSync(accountId);
  const beforeW = h.storage.readSync('workspace:' + accountId),
    beforeA = h.storage.readSync('audit:' + accountId);
  release();
  assert.ok([404, 409].includes((await pending).status));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.storage.readSync('workspace:' + accountId), beforeW);
  assert.deepEqual(h.storage.readSync('audit:' + accountId), beforeA);
  assert.equal(beforeA.events.length, 0);
});
test('AS12 restart reconciles durably deleted audit-only account even with fault hook configured', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  const ak = 'audit:' + accountId,
    log = a.appendAudit(a.createAudit(), ae());
  store.commitSync(
    transaction(
      [{ storeId: ak, value: log, revision: 1 }],
      { [ak]: null },
      { accountId, generation: 0 },
    ),
  );
  store.commitSync(
    transaction(
      [
        { storeId: 'auth', value: auth(2, []), revision: 2 },
        { storeId: 'lifecycle', value: lifecycle(1, 1, false), revision: 1 },
      ],
      { auth: 1, lifecycle: null },
    ),
  );
  await store.close();
  const next = await f.open({ fault: () => {} });
  assert.equal(next.readSync(ak).events.length, 0);
  assert.ok(next.readSync(ak).commitRevision > 1);
});

test('AS13 near-cap output capture failure consumes reserved terminal slot and publishes no accepted draft', async (t) => {
  const h = await inner(t, async (_job, _profile, _questions, { onAudit }) => {
      await onAudit({
        stage: 'generation',
        status: 'start',
        model: 'fixture',
        promptHash: 'a'.repeat(64),
      });
      await onAudit({
        stage: 'generation',
        status: 'observed',
        model: 'fixture',
        promptHash: 'a'.repeat(64),
        snapshot: {
          kind: 'proposal',
          data: { stage: 'generation', document: { text: 'x'.repeat(40000) } },
        },
      });
      throw Error('Must refuse capture before returning');
    }),
    ak = 'audit:' + accountId;
  let log = h.storage.readSync(ak);
  for (let i = 0; i < 40; i++) {
    try {
      log = h.a.appendAudit(log, ae({ traceId: 'fill' + i }), {
        snapshots: [{ kind: 'job', data: { text: i + ' ' + 'z'.repeat(480000) } }],
      });
    } catch (e) {
      assert.equal(e.status, 507);
      break;
    }
  }
  const remaining = 16 * 1024 * 1024 - 64 * 1024 - Buffer.byteLength(JSON.stringify(log)) - 34000;
  assert.ok(remaining > 0 && remaining < 512 * 1024);
  log = h.a.appendAudit(log, ae({ traceId: 'lastfill' }), {
    snapshots: [{ kind: 'job', data: { text: 'q'.repeat(remaining) } }],
  });
  const current = h.storage.readSync(ak);
  h.storage.commitSync(
    transaction(
      [
        {
          storeId: ak,
          value: { ...log, commitRevision: current.commitRevision + 1 },
          revision: current.commitRevision + 1,
        },
      ],
      { [ak]: current.commitRevision },
      { accountId, generation: 0 },
    ),
  );
  const before = h.storage.readSync('workspace:' + accountId),
    response = await h.call('/api/applications/' + h.o.id + '/prepare', h.body);
  assert.equal(response.status, 507, JSON.stringify(response.data));
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.storage.readSync('workspace:' + accountId), before);
  const after = h.storage.readSync(ak),
    events = after.events.filter((e) => e.traceId === h.body.requestId);
  assert.ok(
    events.some((e) => e.status === 'failed' && /capacity/i.test(e.reasonCode + ' ' + e.reason)),
  );
  assert.ok(!events.some((e) => e.status === 'accepted'));
  assert.equal(h.a.queryAudit(after).capacity.openSpans, 0);
});

import {
  cp,
  readFile as readAuditFile,
  writeFile as writeAuditFile,
  symlink,
  unlink,
} from 'node:fs/promises';
import { fixturePreparation } from '../app/application-preparation.mjs';
test('AS14 checkpoint backup/reopen discovers audit-only aggregate and allows isolated next append', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  const ak = 'audit:' + accountId,
    log = a.appendAudit(a.createAudit(), ae());
  store.commitSync(
    transaction(
      [{ storeId: ak, value: log, revision: 1 }],
      { [ak]: null },
      { accountId, generation: 0 },
    ),
  );
  await store.checkpoint();
  await store.close();
  const backup = await mkdtemp(join(tmpdir(), 'audit-backup-'));
  t.after(() => rm(backup, { recursive: true, force: true }));
  await cp(f.directory, backup, { recursive: true, preserveTimestamps: true });
  const { openPrivateStorage } = await import(moduleURL),
    restored = await openPrivateStorage({ directory: backup, bootstrap: true });
  try {
    assert.deepEqual(restored.readSync(ak), log);
    const next = a.appendAudit(log, ae({ traceId: 'after-restore' }));
    restored.commitSync(
      transaction(
        [{ storeId: ak, value: next, revision: 2 }],
        { [ak]: 1 },
        { accountId, generation: 0 },
      ),
    );
    assert.equal(restored.readSync(ak).events.length, 2);
  } finally {
    await restored.close();
  }
  const original = await f.open();
  assert.equal(original.readSync(ak).events.length, 1);
});
test('AS15 audit symlink refuses recovery without reading or altering outside canary', async (t) => {
  const a = await auditModule(),
    f = await fixture(t),
    store = await f.open();
  await seed(store);
  const ak = 'audit:' + accountId,
    log = a.appendAudit(a.createAudit(), ae());
  store.commitSync(
    transaction(
      [{ storeId: ak, value: log, revision: 1 }],
      { [ak]: null },
      { accountId, generation: 0 },
    ),
  );
  await store.close();
  const outside = await mkdtemp(join(tmpdir(), 'audit-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const canary = join(outside, 'canary.json');
  await writeAuditFile(canary, JSON.stringify(log), { mode: 0o600 });
  const file = join(f.directory, 'users', accountId, 'audit.json');
  await unlink(file);
  await symlink(canary, file);
  const before = await readAuditFile(canary);
  await assert.rejects(f.open());
  assert.deepEqual(await readAuditFile(canary), before);
});
test('AS16 durable audit prevents same logical preparation from rerunning after process restart', async (t) => {
  for (const firstResult of ['accepted', 'failed'])
    await t.test(firstResult, async (t) => {
      const h = await inner(t, async (job, profile, questions) => {
        if (firstResult === 'failed') throw Error('Synthetic failure');
        return fixturePreparation(job, profile, questions);
      });
      const first = await h.call('/api/applications/' + h.o.id + '/prepare', h.body);
      assert.equal(first.status, firstResult === 'accepted' ? 200 : 502);
      await new Promise((r) => h.server.close(r));
      let calls = 0;
      const next = createServer({
        storage: h.storage,
        accountId,
        accountGeneration: 0,
        env: { PUBLIC_SERVICE: '1', CONTROLLED_LOCAL_MODE: '1' },
        providers: providers({
          prepareApplication: async () => {
            calls++;
            throw Error('Forbidden duplicate model call');
          },
        }),
      });
      await new Promise((r) => next.listen(0, '127.0.0.1', r));
      t.after(() => new Promise((r) => next.close(r)));
      const url =
        'http://127.0.0.1:' + next.address().port + '/api/applications/' + h.o.id + '/prepare';
      const post = (body) =>
        fetch(url, {
          method: 'POST',
          headers: {
            Origin: new URL(url).origin,
            'Content-Type': 'application/json',
            Connection: 'close',
          },
          body: JSON.stringify(body),
        });
      assert.equal((await post(h.body)).status, 410);
      assert.equal(
        (await post({ ...h.body, questions: ['Different immutable input'] })).status,
        409,
      );
      assert.equal(calls, 0);
    });
});
