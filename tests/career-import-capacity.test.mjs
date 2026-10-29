import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openPrivateStorage } from '../app/private-storage.mjs';
import { createAudit, appendAudit } from '../app/agent-audit.mjs';
import { createServer } from '../app/server.mjs';
import { bundle, vacancy } from './import-fixtures.mjs';
test('IR02 a full real audit refuses the whole imported item without workspace, receipt or notification changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'import-full-audit-')),
    storage = await openPrivateStorage({ directory, bootstrap: true }),
    accountId = randomUUID(),
    email = 'import-capacity@example.test';
  t.after(async () => {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = {
    id: accountId,
    email,
    name: 'Capacity candidate',
    verified: true,
    mailboxTag: 'abcdef123456',
    passwordSalt: 'a'.repeat(64),
    passwordHash: 'b'.repeat(128),
    createdAt: 1720000000000,
  };
  storage.commitSync({
    transactionId: randomUUID(),
    expectedRevisions: { auth: null },
    targets: [
      {
        storeId: 'auth',
        revision: 1,
        value: {
          version: 1,
          commitRevision: 1,
          users: [user],
          sessions: [],
          tokens: [],
          quotas: [],
        },
      },
    ],
  });
  const event = (i) => ({
    eventId: randomUUID(),
    traceId: 'capacity-' + i,
    spanId: 'span-' + i,
    actor: { type: 'system', role: 'capacity-fixture', mode: 'fixture' },
    action: 'capacity-fixture',
    status: 'observed',
    reasonCode: 'TEST',
    reason: 'Synthetic bounded history fixture.',
  });
  let audit = createAudit();
  for (let i = 0; i < 40; i++) {
    try {
      audit = appendAudit(audit, event(i), {
        snapshots: [{ kind: 'job', data: { text: String(i) + 'x'.repeat(480000) } }],
      });
    } catch (e) {
      assert.equal(e.status, 507);
      break;
    }
  }
  const remaining = 16 * 1024 * 1024 - 64 * 1024 - Buffer.byteLength(JSON.stringify(audit)) - 2048;
  assert.ok(remaining > 0 && remaining < 512 * 1024);
  audit = appendAudit(audit, event('tail'), {
    snapshots: [{ kind: 'job', data: { text: 'q'.repeat(remaining) } }],
  });
  for (let i = 0; i < 100; i++) {
    try {
      audit = appendAudit(audit, event('exhaust-' + i));
    } catch (e) {
      assert.equal(e.status, 507);
      break;
    }
  }
  audit.commitRevision = 1;
  storage.commitSync({
    transactionId: randomUUID(),
    accountId,
    generation: 0,
    expectedRevisions: { ['audit:' + accountId]: null },
    targets: [{ storeId: 'audit:' + accountId, revision: 1, value: audit }],
  });
  const server = createServer({
    storage,
    accountId,
    accountGeneration: 0,
    env: { PUBLIC_SERVICE: '1' },
    mailProvider: {
      send: async () => {
        throw Error('Must not send');
      },
      receive: async () => {
        throw Error('Must not receive');
      },
    },
  });
  t.after(() => {
    server.emit('close');
  });
  const owner = { accountId, generation: 0, principalId: 'web:synthetic-capacity-session', email },
    call = (action, body) => server.importAction(owner, action, body, { assertActive() {} }),
    b = bundle({ user: { email } }, [vacancy()]);
  await call('begin', { batchId: b.batchId, sourceAccount: email, items: b.items });
  const item = b.records[0];
  await call('chunk', {
    batchId: b.batchId,
    itemId: item.itemId,
    index: 0,
    data: item.payload.toString('base64'),
  });
  const preview = await call('preview', { batchId: b.batchId }),
    beforeW = storage.readSync('workspace:' + accountId),
    beforeA = storage.readSync('audit:' + accountId);
  const result = await call('commit', {
    batchId: b.batchId,
    previewHash: preview.previewHash,
    itemIds: [item.itemId],
  });
  assert.ok(result.items.every((i) => i.status !== 'committed'));
  assert.deepEqual(storage.readSync('workspace:' + accountId), beforeW);
  assert.deepEqual(storage.readSync('audit:' + accountId), beforeA);
});
