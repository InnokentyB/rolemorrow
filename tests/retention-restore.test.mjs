import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { openPrivateStorage } from '../app/private-storage.mjs';

// LOCK-RET-003 RULE5/6. All files synthetic, no host personal data mounts.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const now = Date.UTC(2026, 9, 25);
const iso = (ms) => new Date(ms).toISOString();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const user = (id, name) => ({
  id,
  name,
  email: name + '@example.test',
  verified: true,
  mailboxTag: id.slice(0, 8) + 'abcd',
  passwordSalt: 'a'.repeat(64),
  passwordHash: 'b'.repeat(128),
  createdAt: 1720000000000,
});
const auth = {
  version: 1,
  commitRevision: 1,
  users: [user(A, 'deleted-person'), user(B, 'survivor')],
  sessions: [],
  tokens: [],
  quotas: [],
};
const workspace = {
  revision: 1,
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
};
async function tree(path) {
  const result = {};
  for (const name of (await fs.readdir(path)).sort()) {
    if (name === '.writer.lock') continue;
    const p = join(path, name);
    const st = await fs.lstat(p);
    result[name] = st.isDirectory() ? await tree(p) : await fs.readFile(p, 'utf8');
  }
  return result;
}
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rm-retention-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await fs.mkdir(source, { mode: 0o700 });
  const store = await openPrivateStorage({
    directory: source,
    bootstrap: true,
  });
  await store.commit({
    transactionId: randomUUID(),
    expectedRevisions: { auth: null },
    targets: [{ storeId: 'auth', value: auth, revision: 1 }],
  });
  for (const id of [A, B])
    await store.commit({
      transactionId: randomUUID(),
      expectedRevisions: { ['workspace:' + id]: null },
      targets: [{ storeId: 'workspace:' + id, value: workspace, revision: 1 }],
    });
  await store.checkpoint();
  await store.close();
  const ledgerPath = join(root, 'deletion-ledger.json');
  const ledger = {
    version: 1,
    asOf: iso(now),
    records: [{ accountId: A, generation: 2, deletedAt: iso(now - 3600000) }],
  };
  async function saveLedger(value = ledger) {
    const bytes = JSON.stringify(value);
    await fs.writeFile(ledgerPath, bytes, { mode: 0o600 });
    return hash(bytes);
  }
  const ledgerDigest = await saveLedger();
  return {
    currentSnapshot: true,
    root,
    source,
    ledgerPath,
    ledgerDigest,
    saveLedger,
    ledger,
    destination: join(root, 'copy'),
    now,
    originalCreatedAt: iso(now - 86400000),
  };
}
async function mod() {
  return import('../app/retention-restore.mjs');
}

test('SCN-RET-RESTORE-01 pinned fresh independent ledger removes deleted UUID and preserves survivor; source byte-identical', async (t) => {
  const f = await fixture(t),
    before = await tree(f.source);
  const { createVerifiedRetentionCopy } = await mod();
  const receipt = await createVerifiedRetentionCopy(f);
  assert.equal(receipt.ready, true);
  assert.equal(receipt.originalCreatedAt, f.originalCreatedAt);
  assert.deepEqual(await tree(f.source), before);
  const copy = await openPrivateStorage({ directory: f.destination });
  assert.deepEqual((await copy.read('auth')).users, [auth.users[1]]);
  assert.equal(await copy.read('workspace:' + A), null);
  assert.deepEqual(await copy.read('workspace:' + B), workspace);
  assert.equal((await copy.read('lifecycle')).records[A].active, false);
  assert.equal((await copy.read('lifecycle')).records[A].generation, 2);
  await assert.rejects(
    copy.commit({
      transactionId: randomUUID(),
      accountId: A,
      generation: 0,
      expectedRevisions: { ['workspace:' + A]: null },
      targets: [{ storeId: 'workspace:' + A, value: workspace, revision: 1 }],
    }),
    /inactive|generation/,
  );
  await copy.close();
  assert.ok(!JSON.stringify(await tree(f.destination)).includes('deleted-person'));
});

test('SCN-RET-RESTORE-02 missing, stale, future or unpinned ledger refuses before output exists', async (t) => {
  for (const kind of ['missing', 'stale', 'future', 'unpinned']) {
    const f = await fixture(t),
      before = await tree(f.source);
    const { createVerifiedRetentionCopy } = await mod();
    if (kind === 'missing') await fs.unlink(f.ledgerPath);
    if (kind === 'stale' || kind === 'future')
      f.ledgerDigest = await f.saveLedger({
        ...f.ledger,
        asOf: iso(now + (kind === 'stale' ? -86400001 : 1)),
      });
    if (kind === 'unpinned') delete f.ledgerDigest;
    await assert.rejects(createVerifiedRetentionCopy(f), /ledger/i);
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
    assert.deepEqual(await tree(f.source), before);
  }
});

test('SCN-RET-RESTORE-03 malformed/duplicate ledger and tamper refuse without source mutation', async (t) => {
  for (const records of [
    [{ accountId: '../x', generation: 1, deletedAt: iso(now) }],
    [...Array(2)].map(() => ({
      accountId: A,
      generation: 2,
      deletedAt: iso(now),
    })),
    [{ accountId: A, generation: 0, deletedAt: iso(now) }],
    [
      {
        accountId: A,
        generation: 1,
        deletedAt: iso(now),
        email: 'extra@example.test',
      },
    ],
  ]) {
    const f = await fixture(t);
    f.ledgerDigest = await f.saveLedger({ ...f.ledger, records });
    const { createVerifiedRetentionCopy } = await mod();
    await assert.rejects(createVerifiedRetentionCopy(f), /ledger/i);
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  }
  const f = await fixture(t);
  await fs.appendFile(f.ledgerPath, ' ');
  const { createVerifiedRetentionCopy } = await mod();
  await assert.rejects(createVerifiedRetentionCopy(f), /ledger/i);
});

test('SCN-RET-RESTORE-04 nested/existing destination and symlink ledger refused; no ready marker', async (t) => {
  const { createVerifiedRetentionCopy } = await mod();
  for (const kind of ['nested', 'existing', 'ledger-inside', 'symlink']) {
    const f = await fixture(t),
      before = await tree(f.source);
    if (kind === 'nested') f.destination = join(f.source, 'nested');
    if (kind === 'existing') await fs.mkdir(f.destination, { mode: 0o700 });
    if (kind === 'ledger-inside') {
      await fs.copyFile(f.ledgerPath, join(f.source, 'ledger.json'));
      f.ledgerPath = join(f.source, 'ledger.json');
    }
    if (kind === 'symlink') {
      const old = f.ledgerPath;
      f.ledgerPath = join(f.root, 'linked.json');
      await fs.symlink(old, f.ledgerPath);
    }
    await assert.rejects(createVerifiedRetentionCopy(f));
    await assert.rejects(fs.stat(join(f.destination, 'retention-ready.json')), {
      code: 'ENOENT',
    });
    if (kind !== 'ledger-inside') assert.deepEqual(await tree(f.source), before);
  }
});

test('SCN-RET-COMPACT-01 current-only verified export keeps authoritative bytes/revisions and excludes orphan stage history', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.source, '.staging', 'orphan-history.json'), 'OLD PRIVATE HISTORY', {
    mode: 0o600,
  });
  const before = await tree(f.source),
    store = await openPrivateStorage({ directory: f.source });
  assert.equal(typeof store.exportCurrentCopy, 'function');
  const receipt = await store.exportCurrentCopy({
    destination: f.destination,
    originalCreatedAt: f.originalCreatedAt,
    now,
  });
  assert.equal(receipt.ready, true);
  assert.deepEqual(await tree(f.source), before);
  await store.close();
  const copy = await openPrivateStorage({ directory: f.destination });
  assert.deepEqual(await copy.read('auth'), auth);
  assert.deepEqual(await copy.read('workspace:' + A), workspace);
  await copy.close();
  assert.ok(!JSON.stringify(await tree(f.destination)).includes('OLD PRIVATE HISTORY'));
});

test('SCN-RET-COMPACT-02 source corruption refuses export; destination never ready', async (t) => {
  const f = await fixture(t);
  const store = await openPrivateStorage({ directory: f.source });
  await fs.appendFile(join(f.source, 'accounts.json'), ' ');
  await assert.rejects(
    store.exportCurrentCopy({
      destination: f.destination,
      originalCreatedAt: f.originalCreatedAt,
      now,
    }),
  );
  await assert.rejects(fs.stat(join(f.destination, 'retention-ready.json')), {
    code: 'ENOENT',
  });
  await store.close();
});

test('SCN-RET-RESTORE-05 recovery of interrupted source happens only on snapshot, original unchanged', async (t) => {
  const f = await fixture(t);
  const store = await openPrivateStorage({
    directory: f.source,
    fault: async (point) => {
      if (point === 'after-intent') throw Error('synthetic interruption');
    },
  });
  const next = {
    ...auth,
    commitRevision: 2,
    users: [auth.users[0], { ...auth.users[1], name: 'survivor-after-interruption' }],
  };
  await assert.rejects(
    store.commit({
      transactionId: randomUUID(),
      expectedRevisions: { auth: 1 },
      targets: [{ storeId: 'auth', value: next, revision: 2 }],
    }),
    /interruption/,
  );
  await store.close();
  const before = await tree(f.source),
    { createVerifiedRetentionCopy } = await mod();
  await createVerifiedRetentionCopy(f);
  assert.deepEqual(await tree(f.source), before);
  const restored = await openPrivateStorage({ directory: f.destination });
  assert.equal((await restored.read('auth')).users[0].name, 'survivor-after-interruption');
  await restored.close();
});

test('SCN-RET-RESTORE-06 all auth and MCP credentials revoked, deleted audit snapshots absent, surviving audit preserved', async (t) => {
  const f = await fixture(t);
  const { createAudit, appendAudit } = await import('../app/agent-audit.mjs');
  const store = await openPrivateStorage({
    directory: f.source,
    bootstrap: true,
  });
  const next = {
    ...auth,
    commitRevision: 2,
    sessions: [
      {
        hash: 'c'.repeat(64),
        userId: B,
        createdAt: 1,
        expiresAt: now + 86400000,
      },
    ],
    tokens: [
      {
        hash: 'd'.repeat(64),
        userId: B,
        kind: 'reset',
        expiresAt: now + 86400000,
      },
    ],
  };
  await store.commit({
    transactionId: randomUUID(),
    expectedRevisions: { auth: 1 },
    targets: [{ storeId: 'auth', value: next, revision: 2 }],
  });
  const grant = {
    id: randomUUID(),
    generation: 0,
    clientId: 'fixture',
    resource: 'https://fixture.test/mcp',
    scopes: ['mcp:read'],
    redirectUri: 'https://fixture.test/cb',
    createdAt: 1,
    expiresAt: now + 86400000,
    revokedAt: null,
    codeHash: 'e'.repeat(64),
    codeExpiresAt: now + 86400000,
    codeChallenge: 'a'.repeat(43),
    codeUsed: false,
    accessHash: 'f'.repeat(64),
    accessExpiresAt: now + 86400000,
    refreshHash: '1'.repeat(64),
    usedRefreshHashes: [],
  };
  const connection = {
    version: 1,
    commitRevision: 1,
    grants: [grant],
    historyEpoch: randomUUID(),
    historyAnchor: null,
    cursorKey: '2'.repeat(64),
  };
  const audits = {};
  for (const id of [A, B]) {
    const audit = appendAudit(
      createAudit(),
      {
        traceId: 'restore-fixture',
        actor: { type: 'user', role: 'candidate', mode: 'manual' },
        action: 'save',
        status: 'accepted',
        reasonCode: 'SYNTHETIC',
        reason: 'Synthetic fixture',
        at: iso(now),
      },
      {
        snapshots: [
          {
            kind: 'job',
            data: {
              text: id === A ? 'DELETED AUDIT SECRET' : 'surviving audit',
            },
          },
        ],
      },
    );
    audits[id] = audit;
    await store.commit({
      transactionId: randomUUID(),
      expectedRevisions: { ['audit:' + id]: null, ['connections:' + id]: null },
      targets: [
        {
          storeId: 'audit:' + id,
          value: audit,
          revision: audit.commitRevision,
        },
        { storeId: 'connections:' + id, value: connection, revision: 1 },
      ],
    });
  }
  await store.close();
  const { createVerifiedRetentionCopy } = await mod();
  await createVerifiedRetentionCopy(f);
  const restored = await openPrivateStorage({ directory: f.destination });
  const recoveredAuth = await restored.read('auth');
  assert.deepEqual(recoveredAuth.sessions, []);
  assert.deepEqual(recoveredAuth.tokens, []);
  assert.equal(await restored.read('audit:' + A), null);
  assert.equal(await restored.read('connections:' + A), null);
  assert.deepEqual(await restored.read('audit:' + B), audits[B]);
  const recoveredConnection = await restored.read('connections:' + B);
  assert.deepEqual(recoveredConnection.grants, []);
  assert.notEqual(recoveredConnection.cursorKey, connection.cursorKey);
  assert.notEqual(recoveredConnection.historyEpoch, connection.historyEpoch);
  await restored.close();
  assert.ok(!JSON.stringify(await tree(f.destination)).includes('DELETED AUDIT SECRET'));
});

test('SCN-RET-RESTORE-07 attestation absent, linked ledger or ledger content changed refuses before output', async (t) => {
  const { createVerifiedRetentionCopy } = await mod();
  for (const kind of ['attestation', 'hardlink', 'changed']) {
    const f = await fixture(t);
    if (kind === 'attestation') delete f.currentSnapshot;
    if (kind === 'hardlink') await fs.link(f.ledgerPath, join(f.root, 'ledger-hardlink'));
    if (kind === 'changed') await fs.appendFile(f.ledgerPath, ' ');
    await assert.rejects(createVerifiedRetentionCopy(f));
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  }
});

test('SCN-RET-RESTORE-08 operator CLI requires attestation and publishes only verified separate copy', async (t) => {
  const f = await fixture(t);
  const { spawnSync } = await import('node:child_process');
  const actual = Date.now();
  f.ledgerDigest = await f.saveLedger({
    ...f.ledger,
    asOf: iso(actual),
    records: [{ accountId: A, generation: 2, deletedAt: iso(actual - 1000) }],
  });
  const args = [
    'ops/retention-copy.mjs',
    '--source',
    f.source,
    '--destination',
    f.destination,
    '--ledger',
    f.ledgerPath,
    '--ledger-digest',
    f.ledgerDigest,
    '--original-created-at',
    iso(actual - 86400000),
  ];
  const refused = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(refused.status, 1);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  const before = await tree(f.source),
    result = spawnSync(process.execPath, [...args, '--attest-current-ledger'], {
      encoding: 'utf8',
      timeout: 5000,
    });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ready, true);
  assert.equal(
    receipt.sourceJournalSha256,
    hash(await fs.readFile(join(f.source, 'private.journal'))),
  );
  assert.deepEqual(await tree(f.source), before);
});

test('SCN-RET-RESTORE-09 ledger change during isolated restore refuses final readiness', async (t) => {
  const f = await fixture(t),
    before = await tree(f.source),
    { createVerifiedRetentionCopy } = await mod();
  const pending = createVerifiedRetentionCopy(f);
  const refused = assert.rejects(pending, /ledger/i);
  await f.saveLedger({
    ...f.ledger,
    records: [...f.ledger.records, { accountId: B, generation: 3, deletedAt: iso(now) }],
  });
  await refused;
  await assert.rejects(fs.stat(join(f.destination, 'retention-ready.json')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await tree(f.source), before);
});

test('SCN-RET-RESTORE-10 noncanonical uppercase UUID ledger refuses instead of missing deletion identity', async (t) => {
  const f = await fixture(t);
  f.ledgerDigest = await f.saveLedger({
    ...f.ledger,
    records: [
      {
        accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
        generation: 1,
        deletedAt: iso(now),
      },
    ],
  });
  const { createVerifiedRetentionCopy } = await mod();
  await assert.rejects(createVerifiedRetentionCopy(f));
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});
