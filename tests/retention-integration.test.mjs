import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { openPrivateStorage } from '../app/private-storage.mjs';
import { planRetention, executeRetention } from '../app/retention.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const day = 86400000;

test('SCN-RET-INTEGRATION-01 generated verified generation authorizes only matching old journal copy', async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), 'retention-integration-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, 'source'),
    output = join(base, 'verified'),
    root = join(base, 'managed');
  await fs.mkdir(source, { mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 });
  const createdAt = new Date(Date.now() - 40 * day).toISOString();
  const store = await openPrivateStorage({ directory: source, bootstrap: true });
  t.after(() => store.close());
  await store.checkpoint();
  const original = await fs.readFile(join(source, 'private.journal'));
  const ready = await store.exportCurrentCopy({
    destination: output,
    originalCreatedAt: createdAt,
    now: Date.now() - 8 * day,
  });
  const proof = await fs.readFile(join(output, 'retention-ready.json'));
  const id = randomUUID(),
    file = id + '.journal',
    compactionReceiptFile = 'receipt-' + randomUUID() + '.json';
  await fs.writeFile(join(root, file), original, { mode: 0o600 });
  await fs.writeFile(join(root, compactionReceiptFile), proof, { mode: 0o600 });
  await fs.writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id,
          file,
          category: 'journal',
          createdAt,
          sha256: sha(original),
          compactedAt: ready.verifiedAt,
          compactionReceipt: sha(proof),
          compactionReceiptFile,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const plan = planRetention({ root });
  assert.equal(plan.entries[0].action, 'delete');
  assert.equal(
    executeRetention({ root, now: plan.now, approve: plan.digest, enabled: true }).deleted,
    1,
  );
  assert.deepEqual(await fs.readFile(join(source, 'private.journal')), original);
  assert.equal(JSON.parse(await fs.readFile(join(output, 'retention-ready.json'))).ready, true);
  const check = await openPrivateStorage({ directory: output });
  await check.close();
});

test('SCN-RET-INTEGRATION-02 failed durable deletion intent preserves managed copy', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'retention-fsync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = randomUUID(),
    file = id + '.copy',
    content = 'synthetic only';
  await fs.writeFile(join(root, file), content, { mode: 0o600 });
  await fs.writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id,
          file,
          category: 'backup',
          createdAt: new Date(Date.now() - 40 * day).toISOString(),
          sha256: sha(content),
        },
      ],
    }),
    { mode: 0o600 },
  );
  const p = planRetention({ root }),
    original = nativeFs.fsyncSync;
  try {
    nativeFs.fsyncSync = () => {
      throw Error('synthetic fsync failure');
    };
    syncBuiltinESMExports();
    assert.throws(
      () => executeRetention({ root, now: p.now, approve: p.digest, enabled: true }),
      /synthetic fsync failure/,
    );
  } finally {
    nativeFs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(await fs.readFile(join(root, file), 'utf8'), content);
});
