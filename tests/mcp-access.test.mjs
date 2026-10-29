import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openPrivateStorage } from '../app/private-storage.mjs';
import { createMcpAccess } from '../app/mcp-access.mjs';
const accountId = '11111111-1111-4111-8111-111111111111',
  otherId = '22222222-2222-4222-8222-222222222222',
  origin = 'https://mcp.example.test';
const user = (id) => ({
  id,
  email: id === accountId ? 'mcp-a@example.test' : 'mcp-b@example.test',
  name: 'Synthetic Candidate',
  verified: true,
  mailboxTag: id === accountId ? 'abcdef123456' : 'abcdef654321',
  passwordSalt: 'a'.repeat(64),
  passwordHash: 'b'.repeat(128),
  createdAt: 1720000000000,
});
const verifier = 'a'.repeat(43),
  challenge = createHash('sha256').update(verifier).digest('base64url');
const params = (extra = {}) => ({
  response_type: 'code',
  client_id: 'rolemorrow-codex',
  redirect_uri: 'http://127.0.0.1:43219/callback',
  resource: origin + '/mcp',
  scope: 'mcp:read mcp:write mcp:prepare',
  state: 'synthetic-state',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  ...extra,
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-access-'));
  let storage = await openPrivateStorage({ directory, bootstrap: true });
  const users = [user(accountId), user(otherId)];
  storage.commitSync({
    transactionId: randomUUID(),
    expectedRevisions: { auth: null },
    targets: [
      {
        storeId: 'auth',
        revision: 1,
        value: { version: 1, commitRevision: 1, users, sessions: [], tokens: [], quotas: [] },
      },
    ],
  });
  let clock = Date.now();
  let access = createMcpAccess({ storage, origin, now: () => clock });
  t.after(async () => {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get storage() {
      return storage;
    },
    get access() {
      return access;
    },
    advance(ms) {
      clock += ms;
    },
    async reopen() {
      await storage.close();
      storage = await openPrivateStorage({ directory });
      access = createMcpAccess({ storage, origin, now: () => clock });
    },
  };
}
async function issue(h, id = accountId, extra = {}) {
  const p = params(extra),
    a = await h.access.authorize(user(id), p);
  const url = new URL(a.redirectTo);
  assert.equal(url.searchParams.get('state'), 'synthetic-state');
  const code = url.searchParams.get('code');
  assert.ok(code);
  const body = {
    grant_type: 'authorization_code',
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    resource: p.resource,
    code,
    code_verifier: verifier,
  };
  const token = await h.access.token(body, {});
  assert.ok(token.access_token);
  assert.ok(token.refresh_token);
  return { a, p, body, token };
}
const deny = async (fn, status) => assert.rejects(fn, (e) => e.status === status);
test('MA01 actual OAuth code exchange binds owned scope, PKCE and audience; secrets hashed at rest', async (t) => {
  const h = await fixture(t),
    x = await issue(h);
  const context = await h.access.authenticate(x.token.access_token, ['mcp:read']);
  assert.equal(context.accountId, accountId);
  assert.equal(context.clientId, 'rolemorrow-codex');
  assert.ok(context.scopes.includes('mcp:prepare'));
  await deny(() => h.access.authenticate('forged'), 401);
  const record = JSON.stringify(h.storage.readSync('connections:' + accountId));
  for (const raw of [x.token.access_token, x.token.refresh_token, x.body.code])
    assert.ok(!record.includes(raw), 'no raw bearer/refresh/code at rest');
  assert.ok((await h.access.list(accountId)).length);
  assert.ok(!JSON.stringify(await h.access.list(accountId)).includes(x.token.access_token));
});
test('MA02 S256 required, malicious redirect/resource/client/scopes refused without creating a grant', async (t) => {
  const h = await fixture(t);
  for (const input of [
    { code_challenge_method: 'plain' },
    { code_challenge: undefined },
    { redirect_uri: 'https://evil.example/callback' },
    { redirect_uri: 'http://127.0.0.1:123/callback/evil' },
    { redirect_uri: 'http://127.0.0.1:123/callback?exfil=1' },
    { resource: 'https://evil.example/mcp' },
    { client_id: 'other-client' },
    { scope: 'mcp:read mcp:send' },
  ])
    await assert.rejects(() => h.access.authorize(user(accountId), params(input)));
  assert.equal((await h.access.list(accountId)).length, 0);
});
test('MA03 wrong verifier never mints token, successful code is one-use including parallel exchange', async (t) => {
  const h = await fixture(t),
    a = await h.access.authorize(user(accountId), params());
  const code = new URL(a.redirectTo).searchParams.get('code');
  const body = {
    grant_type: 'authorization_code',
    client_id: 'rolemorrow-codex',
    redirect_uri: params().redirect_uri,
    resource: origin + '/mcp',
    code,
    code_verifier: 'b'.repeat(43),
  };
  await assert.rejects(() => h.access.token(body, {}));
  const x = await h.access.authorize(user(accountId), params());
  body.code = new URL(x.redirectTo).searchParams.get('code');
  body.code_verifier = verifier;
  const results = await Promise.allSettled([h.access.token(body, {}), h.access.token(body, {})]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(() => h.access.token(body, {}));
});
test('MA04 refresh rotates atomically; replay revokes the whole token family and cannot expand scope', async (t) => {
  const h = await fixture(t),
    x = await issue(h);
  const b = {
    grant_type: 'refresh_token',
    client_id: 'rolemorrow-codex',
    refresh_token: x.token.refresh_token,
    resource: origin + '/mcp',
  };
  const next = await h.access.token(b, {});
  assert.notEqual(next.refresh_token, x.token.refresh_token);
  await assert.rejects(() => h.access.token(b, {}));
  await deny(() => h.access.authenticate(next.access_token), 401);
  const y = await issue(h);
  await assert.rejects(() =>
    h.access.token({ ...b, refresh_token: y.token.refresh_token, scope: 'mcp:read mcp:send' }, {}),
  );
});
test('MA05 access expiry, connection revoke and restart never resurrect authority', async (t) => {
  const h = await fixture(t),
    x = await issue(h);
  h.advance(600001);
  await deny(() => h.access.authenticate(x.token.access_token), 401);
  const n = await h.access.token(
    {
      grant_type: 'refresh_token',
      client_id: 'rolemorrow-codex',
      refresh_token: x.token.refresh_token,
      resource: origin + '/mcp',
    },
    {},
  );
  await h.reopen();
  const c = await h.access.authenticate(n.access_token);
  await h.access.revoke(accountId, c.grantId);
  await h.reopen();
  await deny(() => h.access.authenticate(n.access_token), 401);
  await assert.rejects(() =>
    h.access.token(
      {
        grant_type: 'refresh_token',
        client_id: 'rolemorrow-codex',
        refresh_token: n.refresh_token,
        resource: origin + '/mcp',
      },
      {},
    ),
  );
});
test('MA06 foreign grant revocation denied and scope separation enforced', async (t) => {
  const h = await fixture(t),
    x = await issue(h, accountId, { scope: 'mcp:read' });
  const c = await h.access.authenticate(x.token.access_token);
  await deny(() => h.access.revoke(otherId, c.grantId), 404);
  await deny(() => h.access.authenticate(x.token.access_token, ['mcp:prepare']), 403);
  assert.equal((await h.access.authenticate(x.token.access_token)).accountId, accountId);
});
test('MA07 grant capacity explicit and physical coordinator context/foreign guards retained', async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < 8; i++) await issue(h);
  await assert.rejects(
    () => issue(h),
    (e) => [409, 429, 503, 507].includes(e.status),
  );
  const value = h.storage.readSync('connections:' + accountId);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024);
  assert.throws(
    () =>
      h.storage.commitSync({
        transactionId: randomUUID(),
        expectedRevisions: { ['connections:' + otherId]: null },
        targets: [{ storeId: 'connections:' + otherId, value, revision: value.commitRevision }],
        accountId,
        generation: 0,
      }),
    /foreign|account/i,
  );
});
test('MA08 durable deletion fences connection-only accounts before purge and restart', async (t) => {
  const h = await fixture(t),
    x = await issue(h),
    auth = h.storage.readSync('auth');
  const lifecycle = {
    version: 1,
    commitRevision: 1,
    records: {
      [accountId]: {
        generation: 1,
        active: false,
        deletedAt: Date.now(),
        transactionId: randomUUID(),
      },
    },
  };
  h.storage.commitSync({
    transactionId: randomUUID(),
    expectedRevisions: { auth: auth.commitRevision, lifecycle: null },
    targets: [
      {
        storeId: 'auth',
        value: {
          ...auth,
          commitRevision: auth.commitRevision + 1,
          users: auth.users.filter((u) => u.id !== accountId),
        },
        revision: auth.commitRevision + 1,
      },
      { storeId: 'lifecycle', value: lifecycle, revision: 1 },
    ],
  });
  await deny(() => h.access.authenticate(x.token.access_token), 401);
  await h.reopen();
  await deny(() => h.access.authenticate(x.token.access_token), 401);
  const record = h.storage.readSync('connections:' + accountId);
  assert.ok(
    !record || !record.tokens?.length,
    'deleted connection-only account must not keep token authority',
  );
});
test('MA09 revocation succeeds even when business audit cannot record another event', async (t) => {
  const h = await fixture(t),
    x = await issue(h),
    ctx = await h.access.authenticate(x.token.access_token);
  const { createAudit, appendAudit } = await import('../app/agent-audit.mjs');
  let audit = createAudit();
  let full = false;
  for (let i = 0; i < 40; i++) {
    try {
      audit = appendAudit(
        audit,
        {
          traceId: 'fill' + i,
          actor: { type: 'system', role: 'capacity', mode: 'fixture' },
          action: 'capacity-fixture',
          status: 'observed',
          reasonCode: 'FIXTURE',
          reason: 'Synthetic capacity observation.',
        },
        { snapshots: [{ kind: 'job', data: { text: i + ' ' + 'z'.repeat(480000) } }] },
      );
    } catch (e) {
      assert.equal(e.status, 507);
      full = true;
      break;
    }
  }
  assert.ok(full);
  const remaining = 16 * 1024 * 1024 - 64 * 1024 - Buffer.byteLength(JSON.stringify(audit)) - 2048;
  assert.ok(remaining > 0 && remaining < 512 * 1024);
  audit = appendAudit(
    audit,
    {
      traceId: 'fill-tail',
      actor: { type: 'system', role: 'capacity', mode: 'fixture' },
      action: 'capacity-fixture',
      status: 'observed',
      reasonCode: 'FIXTURE',
      reason: 'Synthetic tail.',
    },
    { snapshots: [{ kind: 'job', data: { text: 'q'.repeat(remaining) } }] },
  );
  h.storage.commitSync({
    transactionId: randomUUID(),
    accountId,
    generation: 0,
    expectedRevisions: { ['audit:' + accountId]: null },
    targets: [{ storeId: 'audit:' + accountId, value: audit, revision: audit.commitRevision }],
  });
  const before = JSON.stringify(h.storage.readSync('audit:' + accountId));
  await h.access.revoke(accountId, ctx.grantId);
  await deny(() => h.access.authenticate(x.token.access_token), 401);
  assert.equal(JSON.stringify(h.storage.readSync('audit:' + accountId)), before);
});
test('MA10 signed cursor persists across restart, rejects forgery/foreign owner and detects history epoch change', async (t) => {
  const h = await fixture(t);
  await issue(h);
  await issue(h, otherId);
  const epoch = h.access.syncHistoryEpoch(accountId, 'a'.repeat(64)),
    cursor = h.access.createCursor(accountId, epoch, 7);
  assert.ok(cursor.length <= 512);
  assert.deepEqual(h.access.readCursor(accountId, cursor), { epoch, sequence: 7 });
  assert.throws(() => h.access.readCursor(otherId, cursor));
  assert.throws(() =>
    h.access.readCursor(accountId, cursor.slice(0, -1) + (cursor.endsWith('a') ? 'b' : 'a')),
  );
  await h.reopen();
  assert.deepEqual(h.access.readCursor(accountId, cursor), { epoch, sequence: 7 });
  assert.equal(h.access.syncHistoryEpoch(accountId, 'a'.repeat(64)), epoch);
  assert.notEqual(h.access.syncHistoryEpoch(accountId, ''), epoch);
});
test('MA11 code expiry, strict verifier and refresh resource/client substitution refuse', async (t) => {
  const h = await fixture(t),
    a = await h.access.authorize(user(accountId), params());
  h.advance(300001);
  await assert.rejects(() =>
    h.access.token(
      {
        grant_type: 'authorization_code',
        code: new URL(a.redirectTo).searchParams.get('code'),
        code_verifier: verifier,
        client_id: 'rolemorrow-codex',
        redirect_uri: params().redirect_uri,
        resource: origin + '/mcp',
      },
      {},
    ),
  );
  const x = await issue(h);
  for (const extra of [
    { resource: 'https://other.example/mcp' },
    { client_id: 'foreign' },
    { grant_type: 'password' },
  ])
    await assert.rejects(() =>
      h.access.token(
        {
          grant_type: 'refresh_token',
          client_id: 'rolemorrow-codex',
          refresh_token: x.token.refresh_token,
          resource: origin + '/mcp',
          ...extra,
        },
        {},
      ),
    );
  const b = await h.access.authorize(user(accountId), params());
  await assert.rejects(() =>
    h.access.token(
      {
        grant_type: 'authorization_code',
        code: new URL(b.redirectTo).searchParams.get('code'),
        code_verifier: 'short',
        client_id: 'rolemorrow-codex',
        redirect_uri: params().redirect_uri,
        resource: origin + '/mcp',
      },
      {},
    ),
  );
});
test('MA12 ordinary refresh use survives64rotations while first old token replay still revokes family', async (t) => {
  const h = await fixture(t),
    first = await issue(h);
  let current = first.token;
  for (let i = 0; i < 65; i++)
    current = await h.access.token(
      {
        grant_type: 'refresh_token',
        client_id: 'rolemorrow-codex',
        refresh_token: current.refresh_token,
        resource: origin + '/mcp',
      },
      {},
    );
  const c = await h.access.authenticate(current.access_token);
  await assert.rejects(() =>
    h.access.token(
      {
        grant_type: 'refresh_token',
        client_id: 'rolemorrow-codex',
        refresh_token: first.token.refresh_token,
        resource: origin + '/mcp',
      },
      {},
    ),
  );
  await deny(() => h.access.authenticate(current.access_token), 401);
  const record = h.storage.readSync('connections:' + accountId);
  assert.equal(record.grants.find((g) => g.id === c.grantId).usedRefreshHashes.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 512 * 1024);
});
import { createAccountStore } from '../app/accounts.mjs';
test('MA13 empty history cursor remains valid when first event is appended', async (t) => {
  const h = await fixture(t);
  await issue(h);
  const epoch = await h.access.syncHistoryEpoch(accountId, '');
  const cursor = h.access.createCursor(accountId, epoch, 0);
  assert.equal(await h.access.syncHistoryEpoch(accountId, 'f'.repeat(64)), epoch);
  assert.equal(h.access.readCursor(accountId, cursor).epoch, epoch);
});
test('MA14 account and global preparation counters reserve atomically and idempotently across restart', async (t) => {
  const h = await fixture(t);
  let accounts = await createAccountStore({
    file: join(h.directory, 'unused-auth.json'),
    origin,
    storage: h.storage,
  });
  const options = { accountMax: 1, globalMax: 2, windowMs: 86400000 },
    requestId = randomUUID();
  assert.equal(
    (await accounts.consumePreparationQuota(accountId, requestId, options)).replayed,
    false,
  );
  assert.equal(
    (await accounts.consumePreparationQuota(accountId, requestId, options)).replayed,
    true,
  );
  const before = structuredClone(h.storage.readSync('auth'));
  await assert.rejects(
    () => accounts.consumePreparationQuota(accountId, randomUUID(), options),
    (e) => e.status === 429,
  );
  assert.deepEqual(h.storage.readSync('auth'), before);
  await accounts.consumePreparationQuota(otherId, randomUUID(), options);
  const full = structuredClone(h.storage.readSync('auth'));
  await assert.rejects(
    () => accounts.consumePreparationQuota(otherId, randomUUID(), { ...options, accountMax: 3 }),
    (e) => e.status === 429,
  );
  assert.deepEqual(h.storage.readSync('auth'), full);
  await h.reopen();
  accounts = await createAccountStore({
    file: join(h.directory, 'unused-auth.json'),
    origin,
    storage: h.storage,
  });
  assert.equal(
    (await accounts.consumePreparationQuota(accountId, requestId, options)).replayed,
    true,
  );
});
test('MA15 issuer-bound authorization supports stable native callback and preserves state', async (t) => {
  const h = await fixture(t),
    metadata = h.access.metadata();
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.issuer, origin);
  const authorized = await h.access.authorize(user(accountId), params()),
    redirect = new URL(authorized.redirectTo);
  assert.equal(redirect.searchParams.get('iss'), metadata.issuer);
  assert.equal(redirect.pathname, '/callback');
  assert.equal(redirect.searchParams.get('state'), 'synthetic-state');
  assert.ok(redirect.searchParams.get('code'));
});
