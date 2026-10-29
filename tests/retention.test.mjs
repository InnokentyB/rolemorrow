import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
// LOCK-RET-003 R1: operator boundary, all paths synthetic, no provider clients.
const cli = new URL('../ops/retention.mjs', import.meta.url);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const day = 86400000;
async function fixture(t, entries = []) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rm-retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const items = [];
  for (const e of entries) {
    const id = randomUUID(),
      file = id + '.copy',
      bytes = 'synthetic-' + id;
    await fs.writeFile(join(root, file), bytes, { mode: 0o600 });
    items.push({
      id,
      file,
      category: 'backup',
      createdAt: new Date(Date.now() - 40 * day).toISOString(),
      sha256: sha(bytes),
      ...e,
    });
  }
  const manifest = { version: 1, entries: items };
  await fs.writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return {
    root,
    items,
    manifest,
    save: () =>
      fs.writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 }),
  };
}
function call(f, more = [], env = {}) {
  const r = spawnSync(process.execPath, [cli.pathname, '--root', f.root, ...more], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
    timeout: 10000,
  });
  return {
    ...r,
    json: (() => {
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    })(),
  };
}
const plan = (f) => {
  const r = call(f);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
};
async function exists(f, i = 0) {
  return !!(await fs.stat(join(f.root, f.items[i].file)).catch(() => null));
}
function exec(f, p, env = { ROLEMORROW_RETENTION_ENABLE: '1' }, extra = []) {
  return call(f, ['--execute', '--now', p.now, '--approve', p.digest, ...extra], env);
}
test('SCN-RET-001 operator preview is read-only and default execute refuses even expired copies', async (t) => {
  const f = await fixture(t, [{}]);
  const before = await fs.readFile(join(f.root, 'manifest.json'));
  const p = plan(f);
  assert.equal(p.entries[0].action, 'delete');
  assert.ok(await exists(f));
  const r = exec(f, p, {});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /disabled/i);
  assert.ok(await exists(f));
  assert.deepEqual(await fs.readFile(join(f.root, 'manifest.json')), before);
});
test('SCN-RET-002 explicit approval deletes only eligible registered copy, replay is idempotent', async (t) => {
  const f = await fixture(t, [{}, { createdAt: new Date().toISOString() }]);
  await fs.writeFile(join(f.root, 'unregistered.copy'), 'untouched', { mode: 0o600 });
  const p = plan(f),
    r = exec(f, p);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.deleted, 1);
  assert.equal(await exists(f), false);
  assert.ok(await exists(f, 1));
  assert.equal(exec(f, p).status, 0);
  assert.equal(await fs.readFile(join(f.root, 'unregistered.copy'), 'utf8'), 'untouched');
});
test('SCN-RET-003 stale content/manifest/approval fail before any deletion', async (t) => {
  for (const kind of ['content', 'manifest', 'approval']) {
    const f = await fixture(t, [{}, {}]);
    const p = plan(f);
    if (kind === 'content') await fs.writeFile(join(f.root, f.items[1].file), 'changed');
    if (kind === 'manifest') {
      f.items[1].category = 'support';
      await f.save();
    }
    if (kind === 'approval') p.digest = '0'.repeat(64);
    assert.notEqual(exec(f, p).status, 0);
    assert.ok(await exists(f));
    assert.ok(await exists(f, 1));
  }
});
test('SCN-RET-004 no traversal, symlink, hardlink, duplicate filename or hostile root', async (t) => {
  for (const kind of ['traversal', 'symlink', 'hardlink', 'duplicate', 'rootlink']) {
    const f = await fixture(t, [{}, {}]);
    if (kind === 'traversal') {
      f.items[1].file = '../outside';
      await f.save();
    }
    if (kind === 'duplicate') {
      f.items[1].file = f.items[0].file;
      await f.save();
    }
    if (kind === 'symlink' || kind === 'hardlink') {
      await fs.unlink(join(f.root, f.items[1].file));
      await fs[kind === 'symlink' ? 'symlink' : 'link'](
        join(f.root, f.items[0].file),
        join(f.root, f.items[1].file),
      );
    }
    if (kind === 'rootlink') {
      const link = f.root + '-link';
      await fs.symlink(f.root, link);
      t.after(() => fs.unlink(link));
      f.root = link;
    }
    assert.notEqual(call(f).status, 0);
  }
});
test('SCN-RET-005 deadlines are exact and calendar years clamp leap day', async (t) => {
  const now = '2027-02-28T12:00:00.000Z';
  const f = await fixture(t, [
    { category: 'backup', createdAt: '2027-01-29T12:00:00.000Z' },
    {
      category: 'operator',
      createdAt: '2027-01-01T00:00:00.000Z',
      closedAt: '2027-02-21T12:00:00.000Z',
    },
    { category: 'metadata', createdAt: '2026-11-30T12:00:00.000Z' },
    {
      category: 'support',
      createdAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-11-30T12:00:00.000Z',
    },
    {
      category: 'rights-attachment',
      createdAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2027-01-29T12:00:00.000Z',
    },
    {
      category: 'minimal-evidence',
      createdAt: '2024-01-01T00:00:00.000Z',
      closedAt: '2024-02-29T12:00:00.000Z',
    },
  ]);
  const r = call(f, ['--now', now]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json.entries.every((x) => x.action === 'delete'));
  assert.equal(r.json.entries[5].dueAt, now);
  const earlier = call(f, ['--now', '2027-02-28T11:59:59.999Z']);
  assert.ok(earlier.json.entries.every((x) => x.action === 'retain'));
});
test('SCN-RET-006 closure/compaction receipt is required; journal max age cannot authorize blind truncation', async (t) => {
  const f = await fixture(t, [
    { category: 'operator' },
    { category: 'support' },
    { category: 'journal' },
    {
      category: 'journal',
      compactedAt: new Date(Date.now() - 8 * day).toISOString(),
      compactionReceipt: 'a'.repeat(64),
    },
  ]);
  const p = plan(f);
  assert.deepEqual(
    p.entries.map((x) => x.action),
    ['blocked', 'blocked', 'blocked', 'blocked'],
  );
});
test('SCN-RET-007 scoped holds block even overdue/expired; invalid or too long hold fails closed', async (t) => {
  const now = Date.now(),
    hold = {
      owner: 'operator',
      reason: 'specific dispute',
      setAt: new Date(now - 50 * day).toISOString(),
      reviewAt: new Date(now - 10 * day).toISOString(),
      expiresAt: new Date(now - 5 * day).toISOString(),
    };
  const f = await fixture(t, [{ hold }, {}]);
  assert.deepEqual(
    plan(f).entries.map((x) => x.action),
    ['held', 'delete'],
  );
  hold.reviewAt = new Date(now + 100 * day).toISOString();
  await f.save();
  assert.notEqual(call(f).status, 0);
  assert.ok(await exists(f));
});
test('SCN-RET-008 unknown type, future/invalid date, malformed hash, permissions and oversize inventory refuse', async (t) => {
  for (const patch of [
    { category: 'active-account' },
    { createdAt: 'not-a-date' },
    { createdAt: '2039-01-01T00:00:00.000Z' },
    { sha256: 'wrong' },
  ]) {
    const f = await fixture(t, [patch]);
    assert.notEqual(call(f).status, 0);
    assert.ok(await exists(f));
  }
  const f = await fixture(t, [{}]);
  await fs.chmod(join(f.root, f.items[0].file), 0o644);
  assert.notEqual(call(f).status, 0);
  const g = await fixture(t, []);
  g.manifest.entries = Array.from({ length: 1001 }, () => ({}));
  await g.save();
  assert.notEqual(call(g).status, 0);
});
test('SCN-RET-009 approval expiry/future and concurrent lock refuse without effects', async (t) => {
  const f = await fixture(t, [{}]);
  const p = plan(f);
  const old = call(f, ['--now', new Date(Date.now() - 16 * 60000).toISOString()]);
  assert.equal(old.status, 0);
  assert.notEqual(exec(f, old.json).status, 0);
  const future = call(f, ['--now', new Date(Date.now() + 60000).toISOString()]);
  assert.equal(future.status, 0);
  assert.notEqual(exec(f, future.json).status, 0);
  await fs.mkdir(join(f.root, '.retention-lock'), { mode: 0o700 });
  assert.notEqual(exec(f, p).status, 0);
  assert.ok(await exists(f));
});
test('SCN-RET-010 source content never appears in preview/error/progress receipts', async (t) => {
  const f = await fixture(t, [{}]);
  const content = 'PRIVATE_CV_SENTINEL';
  await fs.writeFile(join(f.root, f.items[0].file), content);
  f.items[0].sha256 = sha(content);
  await f.save();
  const p = plan(f),
    r = exec(f, p);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!JSON.stringify(p).includes(content));
  assert.ok(!r.stdout.includes(content));
  const progress = await fs.readFile(join(f.root, '.retention-progress.json'), 'utf8');
  assert.ok(!progress.includes(content));
});
test('SCN-RET-011 interrupted deletion retries persisted intent, no silent success or wrong-file deletion', async (t) => {
  const { planRetention, executeRetention } = await import('../app/retention.mjs');
  const f = await fixture(t, [{}, {}]),
    p = planRetention({ root: f.root });
  let once = true;
  assert.throws(
    () =>
      executeRetention({
        root: f.root,
        now: p.now,
        approve: p.digest,
        enabled: true,
        beforeUnlink: () => {
          if (once) {
            once = false;
            throw Error('synthetic interruption');
          }
        },
      }),
    /synthetic interruption/,
  );
  assert.ok(await exists(f));
  assert.ok(await exists(f, 1));
  const progress = JSON.parse(await fs.readFile(join(f.root, '.retention-progress.json'), 'utf8'));
  assert.equal(progress.states[0].state, 'pending');
  const r = executeRetention({ root: f.root, now: p.now, approve: p.digest, enabled: true });
  assert.equal(r.deleted, 2);
  assert.equal(await exists(f), false);
});
test('SCN-RET-012 post-unlink crash is reconciled as missing only with durable matching intent', async (t) => {
  const { planRetention, executeRetention } = await import('../app/retention.mjs');
  const f = await fixture(t, [{}]),
    p = planRetention({ root: f.root });
  assert.throws(() =>
    executeRetention({
      root: f.root,
      now: p.now,
      approve: p.digest,
      enabled: true,
      beforeUnlink: () => {
        throw Error('interrupt');
      },
    }),
  );
  await fs.unlink(join(f.root, f.items[0].file));
  const r = executeRetention({ root: f.root, now: p.now, approve: p.digest, enabled: true });
  assert.equal(r.reconciledMissing, 1);
  const g = await fixture(t, [{}]);
  await fs.unlink(join(g.root, g.items[0].file));
  assert.notEqual(call(g).status, 0);
});
test('SCN-RET-013 file replacement after approval is refused at final boundary', async (t) => {
  const { planRetention, executeRetention } = await import('../app/retention.mjs');
  const f = await fixture(t, [{}]),
    p = planRetention({ root: f.root });
  assert.throws(
    () =>
      executeRetention({
        root: f.root,
        now: p.now,
        approve: p.digest,
        enabled: true,
        beforeUnlink: () => {
          const s = spawnSync(process.execPath, [
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(join(f.root, f.items[0].file))},'replacement')`,
          ]);
          assert.equal(s.status, 0);
        },
      }),
    /changed/,
  );
  assert.equal(await fs.readFile(join(f.root, f.items[0].file), 'utf8'), 'replacement');
});
test('SCN-RET-014 fabricated pending intent cannot excuse a missing retained copy', async (t) => {
  const { planRetention, executeRetention } = await import('../app/retention.mjs');
  const f = await fixture(t, [{}, { createdAt: new Date().toISOString() }]),
    p = planRetention({ root: f.root });
  assert.throws(() =>
    executeRetention({
      root: f.root,
      now: p.now,
      approve: p.digest,
      enabled: true,
      beforeUnlink: () => {
        throw Error('interrupt');
      },
    }),
  );
  const path = join(f.root, '.retention-progress.json'),
    progress = JSON.parse(await fs.readFile(path, 'utf8'));
  progress.states.push({ id: f.items[1].id, state: 'pending' });
  await fs.writeFile(path, JSON.stringify(progress));
  await fs.unlink(join(f.root, f.items[1].file));
  assert.notEqual(exec(f, p).status, 0);
  assert.ok(await exists(f));
});
test('SCN-RET-015 journal expiry requires matching verified compaction receipt, not an arbitrary hash', async (t) => {
  const f = await fixture(t, [
    { category: 'journal', compactedAt: new Date(Date.now() - 8 * day).toISOString() },
  ]);
  const e = f.items[0],
    receipt = {
      version: 1,
      ready: true,
      originalCreatedAt: e.createdAt,
      sourceJournalSha256: e.sha256,
      verifiedAt: e.compactedAt,
    };
  const bytes = JSON.stringify(receipt);
  e.compactionReceiptFile = 'receipt-' + randomUUID() + '.json';
  e.compactionReceipt = sha(bytes);
  await fs.writeFile(join(f.root, e.compactionReceiptFile), bytes, { mode: 0o600 });
  await f.save();
  assert.equal(plan(f).entries[0].action, 'delete');
  const p = plan(f);
  receipt.sourceJournalSha256 = '0'.repeat(64);
  const wrong = JSON.stringify(receipt);
  await fs.writeFile(join(f.root, e.compactionReceiptFile), wrong);
  assert.notEqual(exec(f, p).status, 0);
  assert.ok(await exists(f));
});
test('SCN-RET-016 explicit completed-batch finalization allows future batches without touching retained files', async (t) => {
  const f = await fixture(t, [{}, { createdAt: new Date().toISOString() }]),
    p = plan(f);
  assert.equal(exec(f, p).status, 0);
  const denied = call(f, ['--finalize', '--approve', p.digest]);
  assert.notEqual(denied.status, 0);
  assert.ok(await exists(f, 1));
  const final = call(f, ['--finalize', '--approve', p.digest], {
    ROLEMORROW_RETENTION_ENABLE: '1',
  });
  assert.equal(final.status, 0, final.stderr);
  assert.equal(final.json.remaining, 1);
  const m = JSON.parse(await fs.readFile(join(f.root, 'manifest.json'), 'utf8'));
  m.entries[0].createdAt = new Date(Date.now() - 40 * day).toISOString();
  await fs.writeFile(join(f.root, 'manifest.json'), JSON.stringify(m));
  const next = plan(f);
  assert.equal(exec(f, next).status, 0);
  assert.equal(await exists(f, 1), false);
});
test('SCN-RET-017 interrupted finalization resumes durable metadata intent; pending deletions cannot finalize', async (t) => {
  const { planRetention, executeRetention, finalizeRetention } = await import(
    '../app/retention.mjs'
  );
  const f = await fixture(t, [{}]),
    p = planRetention({ root: f.root });
  assert.throws(() =>
    executeRetention({
      root: f.root,
      now: p.now,
      approve: p.digest,
      enabled: true,
      beforeUnlink: () => {
        throw Error('interrupt');
      },
    }),
  );
  assert.throws(
    () => finalizeRetention({ root: f.root, approve: p.digest, enabled: true }),
    /incomplete/,
  );
  assert.ok(await exists(f));
  executeRetention({ root: f.root, now: p.now, approve: p.digest, enabled: true });
  assert.throws(
    () =>
      finalizeRetention({
        root: f.root,
        approve: p.digest,
        enabled: true,
        beforePublish: () => {
          throw Error('finalize interrupted');
        },
      }),
    /finalize interrupted/,
  );
  assert.equal(
    finalizeRetention({ root: f.root, approve: p.digest, enabled: true }).status,
    'finalized',
  );
  const receipt = JSON.parse(
    await fs.readFile(join(f.root, 'retention-receipt-' + p.digest + '.json'), 'utf8'),
  );
  assert.equal(receipt.digest, p.digest);
  assert.equal(Object.hasOwn(receipt, 'plan'), false);
  assert.equal(plan(f).entries.length, 0);
});
