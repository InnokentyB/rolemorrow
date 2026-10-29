import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

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
async function subprocess(code, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { PATH: process.env.PATH, STORAGE_MODULE: moduleURL.href, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('Synthetic child exceeded 5s'));
    }, 5000);
    child.stdout.on('data', (b) => {
      output += b;
    });
    child.stderr.on('data', (b) => {
      output += b;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
}

test('SCN-PRIVATE-001 acknowledged auth and workspace commits survive close/reopen; CAS conflict preserves state', async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  await store.commit(
    transaction([{ storeId: 'auth', value: auth(1), revision: 1 }], { auth: null }),
  );
  await store.commit(
    transaction([{ storeId: 'workspace:' + accountId, value: workspace(1), revision: 1 }], {
      ['workspace:' + accountId]: null,
    }),
  );
  await assert.rejects(
    store.commit(transaction([{ storeId: 'auth', value: auth(2), revision: 2 }], { auth: 0 })),
  );
  assert.deepEqual(await store.read('auth'), auth(1));
  await store.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.read('auth'), auth(1));
  assert.deepEqual(await reopened.read('workspace:' + accountId), workspace(1));
});

test('SCN-PRIVATE-002 independent process cannot acquire writer while parent holds it; reacquisition works after close', async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  await assert.rejects(f.open());
  const child =
    'const {openPrivateStorage}=await import(process.env.STORAGE_MODULE);try{const s=await openPrivateStorage({directory:process.env.PRIVATE_DIR});await s.close();process.exitCode=0;}catch{process.exitCode=17;}';
  const blocked = await subprocess(child, { PRIVATE_DIR: f.directory });
  assert.equal(blocked.code, 17, blocked.output);
  await store.close();
  const allowed = await subprocess(child, { PRIVATE_DIR: f.directory });
  assert.equal(allowed.code, 0, allowed.output);
});

test('SCN-PRIVATE-003 partial multi-target publication recovers all targets and replay does not advance revisions', async (t) => {
  const f = await fixture(t);
  let armed = false,
    published = 0;
  const store = await f.open({
    fault: async (point) => {
      if (armed && point === 'after-publish' && ++published === 1)
        throw Error('synthetic interruption');
    },
  });
  await store.commit(
    transaction(
      [
        { storeId: 'auth', value: auth(1), revision: 1 },
        { storeId: 'lifecycle', value: lifecycle(1, 0, true), revision: 1 },
      ],
      { auth: null, lifecycle: null },
    ),
  );
  const deletion = transaction(
    [
      { storeId: 'auth', value: auth(2, []), revision: 2 },
      { storeId: 'lifecycle', value: lifecycle(2, 1, false), revision: 2 },
    ],
    { auth: 1, lifecycle: 1 },
  );
  armed = true;
  await assert.rejects(store.commit(deletion));
  await store.close();
  const recovered = await f.open();
  assert.deepEqual(await recovered.read('auth'), auth(2, []));
  assert.deepEqual(await recovered.read('lifecycle'), lifecycle(2, 1, false));
  await recovered.commit(deletion);
  assert.deepEqual(await recovered.read('auth'), auth(2, []));
  await recovered.close();
  const again = await f.open();
  assert.deepEqual(await again.read('lifecycle'), lifecycle(2, 1, false));
});

test('SCN-PRIVATE-004 real process death after durable intent recovers prepared publication', async (t) => {
  const f = await fixture(t);
  const seed = await f.open();
  await seed.commit(
    transaction([{ storeId: 'auth', value: auth(1), revision: 1 }], { auth: null }),
  );
  await seed.close();
  const child =
    "const {openPrivateStorage}=await import(process.env.STORAGE_MODULE);const s=await openPrivateStorage({directory:process.env.PRIVATE_DIR,fault:async point=>{if(point==='after-intent')process.kill(process.pid,'SIGKILL');}});await s.commit(JSON.parse(process.env.TRANSACTION));process.exitCode=19;";
  const next = transaction([{ storeId: 'auth', value: auth(2), revision: 2 }], { auth: 1 });
  const stopped = await subprocess(child, {
    PRIVATE_DIR: f.directory,
    TRANSACTION: JSON.stringify(next),
  });
  assert.equal(stopped.signal, 'SIGKILL', stopped.output);
  const recovered = await f.open();
  assert.deepEqual(await recovered.read('auth'), auth(2));
});

test('SCN-PRIVATE-005 durable deletion generation rejects late workspace write and does not resurrect private state', async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const key = 'workspace:' + accountId;
  await store.commit(
    transaction(
      [
        { storeId: 'auth', value: auth(1), revision: 1 },
        { storeId: 'lifecycle', value: lifecycle(1, 0, true), revision: 1 },
        { storeId: key, value: workspace(1), revision: 1 },
      ],
      { auth: null, lifecycle: null, [key]: null },
    ),
  );
  await store.commit(
    transaction(
      [
        { storeId: 'auth', value: auth(2, []), revision: 2 },
        { storeId: 'lifecycle', value: lifecycle(2, 1, false), revision: 2 },
      ],
      { auth: 1, lifecycle: 1 },
    ),
  );
  await assert.rejects(
    store.commit(
      transaction(
        [{ storeId: key, value: workspace(2), revision: 2 }],
        { [key]: 1 },
        { accountId, generation: 0 },
      ),
    ),
  );
  assert.deepEqual(await store.read(key), workspace(1));
  await store.close();
  const reopened = await f.open();
  await assert.rejects(
    reopened.commit(
      transaction(
        [{ storeId: key, value: workspace(2), revision: 2 }],
        { [key]: 1 },
        { accountId, generation: 0 },
      ),
    ),
  );
  assert.deepEqual(await reopened.read('lifecycle'), lifecycle(2, 1, false));
});

test('SCN-PRIVATE-006 checkpoint preserves aggregate recovery authority across later reopen', async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  await store.commit(
    transaction([{ storeId: 'auth', value: auth(1), revision: 1 }], { auth: null }),
  );
  await store.checkpoint();
  await store.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.read('auth'), auth(1));
  await reopened.commit(
    transaction([{ storeId: 'auth', value: auth(2), revision: 2 }], { auth: 1 }),
  );
  await reopened.close();
  assert.deepEqual(await (await f.open()).read('auth'), auth(2));
});

test('SCN-PRIVATE-007 unsafe store identifiers refuse without escaping protected directory', async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  for (const storeId of [
    '../escape',
    'workspace:../../escape',
    'workspace:not-a-uuid',
    '/tmp/escape',
  ]) {
    await assert.rejects(
      store.commit(transaction([{ storeId, value: auth(1), revision: 1 }], { [storeId]: null })),
    );
  }
  assert.equal(await store.read('auth'), null);
});

test('SCN-PRIVATE-008 torn journal tail retains acknowledged aggregate and allows new durable commits', async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  await store.commit(
    transaction([{ storeId: 'auth', value: auth(1), revision: 1 }], { auth: null }),
  );
  await store.close();
  const path = join(f.directory, 'private.journal');
  const before = await readFile(path);
  assert.ok(before.length > 0);
  await appendFile(path, Buffer.from([0, 0, 0, 64, 123, 34, 116]));
  const recovered = await f.open();
  assert.deepEqual(await recovered.read('auth'), auth(1));
  await recovered.commit(
    transaction([{ storeId: 'auth', value: auth(2), revision: 2 }], { auth: 1 }),
  );
  await recovered.close();
  assert.deepEqual(await (await f.open()).read('auth'), auth(2));
});

test('SCN-PRIVATE-009 account-bound commit cannot mutate another account workspace', async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  const foreignId = '33333333-3333-4333-8333-333333333333';
  const key = 'workspace:' + foreignId;
  await store.commit(
    transaction(
      [
        { storeId: 'auth', value: auth(1), revision: 1 },
        { storeId: 'lifecycle', value: lifecycle(1, 0, true), revision: 1 },
      ],
      { auth: null, lifecycle: null },
    ),
  );
  await assert.rejects(
    store.commit(
      transaction(
        [{ storeId: key, value: workspace(1), revision: 1 }],
        { [key]: null },
        { accountId, generation: 0 },
      ),
    ),
  );
  assert.equal(await store.read(key), null);
  assert.deepEqual(await store.read('lifecycle'), lifecycle(1, 0, true));
});
