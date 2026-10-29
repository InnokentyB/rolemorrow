import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, rename, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openPrivateStorage } from '../app/private-storage.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const user = {
  id,
  email: 'synthetic@example.invalid',
  name: 'Synthetic',
  verified: true,
  mailboxTag: '123456abcdef',
  passwordSalt: 'a'.repeat(64),
  passwordHash: 'b'.repeat(128),
  createdAt: 1720000000000,
};
const auth = (r) => ({
  version: 1,
  commitRevision: r,
  users: [user],
  sessions: [],
  tokens: [],
  quotas: [],
});
const life = (r) => ({
  version: 1,
  commitRevision: r,
  records: {
    [id]: {
      generation: 0,
      active: true,
      deletedAt: null,
      transactionId: '22222222-2222-4222-8222-222222222222',
    },
  },
});
const work = (r) => ({
  revision: r,
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
const key = 'workspace:' + id;
const tx = (storeId, value, expected, extra = {}) => ({
  transactionId: randomUUID(),
  targets: [{ storeId, value, revision: value.revision ?? value.commitRevision }],
  expectedRevisions: { [storeId]: expected },
  ...extra,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rm-security-')),
    directory = join(root, 'private');
  const instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const open = async (options = {}) => {
    const instance = await openPrivateStorage({ directory, ...options });
    instances.push(instance);
    return instance;
  };
  const seed = await open({ bootstrap: true });
  await seed.commit({
    transactionId: randomUUID(),
    targets: [
      { storeId: 'auth', value: auth(1), revision: 1 },
      { storeId: 'lifecycle', value: life(1), revision: 1 },
      { storeId: key, value: work(1), revision: 1 },
    ],
    expectedRevisions: { auth: null, lifecycle: null, [key]: null },
  });
  await seed.close();
  return {
    root,
    directory,
    open,
    workspace: join(directory, 'users', id, 'state.json'),
    auth: join(directory, 'accounts.json'),
    lifecycle: join(directory, 'lifecycle.json'),
  };
}
test('SCN-PRIVATE-SEC-001 normal workspace commits require explicit owner and generation; omission cannot mutate durable state', async (t) => {
  const f = await fixture(t),
    before = await readFile(f.workspace),
    journal = await readFile(join(f.directory, 'private.journal'));
  const s = await f.open();
  await assert.rejects(s.commit(tx(key, work(2), 1)));
  assert.deepEqual(await readFile(f.workspace), before);
  assert.deepEqual(await readFile(join(f.directory, 'private.journal')), journal);
});
test('SCN-PRIVATE-SEC-002 intermediate workspace symlink refuses access without touching outside canary', async (t) => {
  const f = await fixture(t),
    outside = join(f.root, 'outside');
  await rename(join(f.directory, 'users', id), outside);
  const before = await readFile(join(outside, 'state.json'));
  await symlink(outside, join(f.directory, 'users', id));
  let s, openError;
  try {
    s = await f.open();
  } catch (error) {
    openError = error;
  }
  if (s) {
    try {
      await assert.rejects(s.read(key));
    } finally {
      await s.close();
    }
  } else assert.ok(openError instanceof Error);
  assert.deepEqual(await readFile(join(outside, 'state.json')), before);
});
test('SCN-PRIVATE-SEC-003 changed committed aggregate fails startup before readiness and is not silently repaired', async (t) => {
  const f = await fixture(t),
    changed = auth(1);
  changed.users[0] = { ...user, name: 'Changed without committed transaction' };
  const bytes = JSON.stringify(changed);
  await writeFile(f.auth, bytes, { mode: 0o600 });
  await assert.rejects(f.open());
  assert.equal(await readFile(f.auth, 'utf8'), bytes);
});
test('SCN-PRIVATE-SEC-004 missing acknowledged aggregate fails startup and is not treated as a new empty store', async (t) => {
  const f = await fixture(t);
  await rm(f.workspace);
  await assert.rejects(f.open());
  await assert.rejects(stat(f.workspace), { code: 'ENOENT' });
});
test('SCN-PRIVATE-SEC-005 checkpoint after reopen covers the same complete authoritative stores without prior reads', async (t) => {
  const f = await fixture(t),
    first = await f.open();
  await first.read('auth');
  await first.read('lifecycle');
  await first.read(key);
  const a = await first.checkpoint();
  await first.close();
  const second = await f.open();
  const b = await second.checkpoint();
  assert.equal(b.manifestHash, a.manifestHash);
  await second.close();
  await rm(f.lifecycle);
  await assert.rejects(f.open());
  await assert.rejects(stat(f.lifecycle), { code: 'ENOENT' });
});
test('SCN-PRIVATE-SEC-006 typed auth rejects unknown fields and invalid identities without durable changes', async (t) => {
  const f = await fixture(t),
    s = await f.open({ bootstrap: true }),
    before = await readFile(f.auth),
    journal = await readFile(join(f.directory, 'private.journal'));
  const unknown = { ...auth(2), unexpectedPrivateBlob: 'refuse' };
  await assert.rejects(s.commit(tx('auth', unknown, 1)));
  const invalid = auth(2);
  invalid.users = [{ ...user, id: 'not-a-uuid' }];
  await assert.rejects(s.commit(tx('auth', invalid, 1)));
  assert.deepEqual(await readFile(f.auth), before);
  assert.deepEqual(await readFile(join(f.directory, 'private.journal')), journal);
});
test('SCN-PRIVATE-SEC-007 typed lifecycle and workspace reject malformed fields before publication', async (t) => {
  const f = await fixture(t),
    s = await f.open({ bootstrap: true }),
    beforeLife = await readFile(f.lifecycle),
    beforeWork = await readFile(f.workspace);
  const invalid = life(2);
  invalid.records[id].active = 'yes';
  await assert.rejects(s.commit(tx('lifecycle', invalid, 1)));
  const missing = work(2);
  delete missing.notifications;
  await assert.rejects(s.commit(tx(key, missing, 1, { accountId: id, generation: 0 })));
  assert.deepEqual(await readFile(f.lifecycle), beforeLife);
  assert.deepEqual(await readFile(f.workspace), beforeWork);
});
test('SCN-PRIVATE-SEC-008 existing world-readable auth aggregate is refused without weakening permissions', async (t) => {
  const f = await fixture(t),
    before = await readFile(f.auth);
  await chmod(f.auth, 0o644);
  await assert.rejects(f.open());
  assert.deepEqual(await readFile(f.auth), before);
  assert.equal((await stat(f.auth)).mode & 0o777, 0o644);
});
test('SCN-PRIVATE-SEC-009 existing searchable private directory is refused without changing protected content', async (t) => {
  const f = await fixture(t),
    before = await readFile(f.auth);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.open());
  assert.deepEqual(await readFile(f.auth), before);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o755);
});
test('SCN-PRIVATE-SEC-010 removing auth identity while active lifecycle and workspace remain refuses before durable publication', async (t) => {
  const f = await fixture(t),
    s = await f.open({ bootstrap: true }),
    before = await readFile(f.auth),
    journal = await readFile(join(f.directory, 'private.journal'));
  const orphan = auth(2);
  orphan.users = [];
  await assert.rejects(s.commit(tx('auth', orphan, 1)));
  assert.deepEqual(await readFile(f.auth), before);
  assert.deepEqual(await readFile(join(f.directory, 'private.journal')), journal);
});
test('SCN-PRIVATE-SEC-011 tombstoned retained workspace survives restart while late work cannot resurrect deleted identity', async (t) => {
  const f = await fixture(t),
    s = await f.open({ bootstrap: true }),
    deletedAuth = auth(2);
  deletedAuth.users = [];
  const tombstone = life(2);
  tombstone.records[id] = {
    generation: 1,
    active: false,
    deletedAt: 1720000000001,
    transactionId: randomUUID(),
  };
  await s.commit({
    transactionId: randomUUID(),
    targets: [
      { storeId: 'auth', value: deletedAuth, revision: 2 },
      { storeId: 'lifecycle', value: tombstone, revision: 2 },
    ],
    expectedRevisions: { auth: 1, lifecycle: 1 },
  });
  await s.close();
  const normal = await f.open();
  const before = await readFile(f.workspace),
    journal = await readFile(join(f.directory, 'private.journal'));
  await assert.rejects(normal.commit(tx(key, work(2), 1, { accountId: id, generation: 0 })));
  await assert.rejects(normal.commit(tx(key, work(2), 1, { accountId: id, generation: 1 })));
  assert.deepEqual(await readFile(f.workspace), before);
  assert.deepEqual(await readFile(join(f.directory, 'private.journal')), journal);
  assert.deepEqual(await normal.read('auth'), deletedAuth);
});
test('SCN-PRIVATE-SEC-012 active account cannot invoke deletion purge or change protected state', async (t) => {
  const f = await fixture(t),
    normal = await f.open(),
    before = await readFile(f.workspace),
    journal = await readFile(join(f.directory, 'private.journal'));
  assert.equal(typeof normal.purgeDeletedWorkspace, 'function');
  await assert.rejects(normal.purgeDeletedWorkspace(id));
  assert.deepEqual(await readFile(f.workspace), before);
  assert.deepEqual(await readFile(join(f.directory, 'private.journal')), journal);
});
test('SCN-PRIVATE-SEC-013 deleted workspace purge removes private payload through durable authority and survives restart', async (t) => {
  const f = await fixture(t),
    seed = await f.open({ bootstrap: true }),
    privateState = work(2);
  privateState.messages = [{ id: 'synthetic-message', text: 'PRIVATE-PURGE-CANARY-913' }];
  await seed.commit(tx(key, privateState, 1, { accountId: id, generation: 0 }));
  const deletedAuth = auth(2);
  deletedAuth.users = [];
  const tombstone = life(2);
  tombstone.records[id] = {
    generation: 1,
    active: false,
    deletedAt: 1720000000001,
    transactionId: randomUUID(),
  };
  await seed.commit({
    transactionId: randomUUID(),
    targets: [
      { storeId: 'auth', value: deletedAuth, revision: 2 },
      { storeId: 'lifecycle', value: tombstone, revision: 2 },
    ],
    expectedRevisions: { auth: 1, lifecycle: 1 },
  });
  await seed.close();
  const normal = await f.open();
  assert.equal(typeof normal.purgeDeletedWorkspace, 'function');
  await normal.purgeDeletedWorkspace(id);
  const purged = await normal.read(key);
  assert.equal(purged.revision, 3);
  assert.equal(purged.profile, null);
  assert.equal(purged.run, null);
  for (const field of [
    'companies',
    'history',
    'opportunities',
    'applications',
    'messages',
    'replyDrafts',
    'mailDispatches',
    'mailEvents',
    'notifications',
    'webhookReceipts',
  ])
    assert.deepEqual(purged[field], [], field);
  assert.equal((await readFile(f.workspace, 'utf8')).includes('PRIVATE-PURGE-CANARY-913'), false);
  await normal.close();
  const restarted = await f.open();
  assert.deepEqual(await restarted.read(key), purged);
  const before = await readFile(f.workspace),
    journal = await readFile(join(f.directory, 'private.journal'));
  await assert.rejects(restarted.commit(tx(key, work(4), 3, { accountId: id, generation: 1 })));
  assert.deepEqual(await readFile(f.workspace), before);
  assert.deepEqual(await readFile(join(f.directory, 'private.journal')), journal);
});
