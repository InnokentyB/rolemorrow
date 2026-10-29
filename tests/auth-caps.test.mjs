import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createPublicServer } from '../app/public-server.mjs';
import { createAccountStore } from '../app/accounts.mjs';
const password = 'Synthetic-auth-boundary-password-2026';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rm-auth-caps-')),
    outbox = [];
  let now = Date.parse('2026-10-21T12:00:00Z'),
    server,
    base;
  async function start() {
    const reservation = net.createServer();
    await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    base = 'http://127.0.0.1:' + port;
    server = await createPublicServer({
      storeDir: directory,
      accountNow: () => now,
      env: {
        PUBLIC_ORIGIN: base,
        PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
        PUBLIC_REGISTRATION_ENABLED: '1',
        ORGANIZATION_REFRESH_ENABLED: '0',
        ORGANIZATION_DISCOVERY_ENABLED: '0',
      },
      sendAccountMail: async (m) => outbox.push(m),
      mailProvider: {
        send: async () => assert.fail('No external mail'),
        receive: async () => assert.fail('No provider read'),
      },
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
  }
  async function close() {
    if (server) {
      await new Promise((r) => server.close(r));
      server = null;
    }
  }
  await start();
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (action, input) => {
    const r = await fetch(base + '/api/account/' + action, {
      method: 'POST',
      headers: { Origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: r.status, body: await r.json() };
  };
  const protectedState = async () => {
    let state;
    try {
      state = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      state = {};
    }
    return { users: state.users ?? [], sessions: state.sessions ?? [], tokens: state.tokens ?? [] };
  };
  return {
    call,
    outbox,
    protectedState,
    advance(ms) {
      now += ms;
    },
    async restart() {
      await close();
      await start();
    },
  };
}
test('AUTH-CAP-001 canonical login identity allows at most ten/hour and survives gateway restart', async (t) => {
  const h = await fixture(t),
    before = await h.protectedState();
  for (let i = 0; i < 10; i++) {
    const email = i % 2 ? ' Missing@Example.com ' : 'missing@example.com';
    assert.equal((await h.call('login', { email, password })).status, 401);
  }
  await h.restart();
  assert.equal((await h.call('login', { email: 'MISSING@example.com', password })).status, 429);
  assert.deepEqual(await h.protectedState(), before);
  assert.equal(h.outbox.length, 0);
  h.advance(3600001);
  assert.equal((await h.call('login', { email: 'missing@example.com', password })).status, 401);
});
test('AUTH-CAP-002 source login cap persists while in-memory generic limiter resets', async (t) => {
  const h = await fixture(t),
    before = await h.protectedState();
  for (let i = 0; i < 25; i++)
    assert.equal(
      (await h.call('login', { email: 'source' + i + '@example.com', password })).status,
      401,
    );
  await h.restart();
  for (let i = 25; i < 50; i++)
    assert.equal(
      (await h.call('login', { email: 'source' + i + '@example.com', password })).status,
      401,
    );
  assert.equal((await h.call('login', { email: 'source50@example.com', password })).status, 429);
  assert.deepEqual(await h.protectedState(), before);
  assert.equal(h.outbox.length, 0);
});
test('AUTH-CAP-003 verification presented-token cap is generic and durable; no identity/session/token content changes', async (t) => {
  const h = await fixture(t),
    before = await h.protectedState(),
    token = 'A'.repeat(43);
  for (let i = 0; i < 5; i++) {
    const response = await h.call('verify', { token });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /invalid|expired/i);
  }
  await h.restart();
  assert.equal((await h.call('verify', { token })).status, 429);
  assert.deepEqual(await h.protectedState(), before);
  assert.equal(h.outbox.length, 0);
});
test('AUTH-CAP-004 canonical resend refuses within minute, recovers at boundary, retains hourly cap and emits only captured mail', async (t) => {
  const h = await fixture(t),
    input = { email: 'resend@example.com', password, name: 'Synthetic' };
  assert.equal((await h.call('register', input)).status, 202);
  const before = await h.protectedState();
  assert.equal(h.outbox.length, 1);
  assert.equal((await h.call('register', { ...input, email: ' RESEND@example.com ' })).status, 429);
  assert.deepEqual(await h.protectedState(), before);
  assert.equal(h.outbox.length, 1);
  h.advance(60001);
  assert.equal((await h.call('register', { ...input, email: 'Resend@example.com' })).status, 202);
  assert.equal(h.outbox.length, 2);
  h.advance(60001);
  assert.equal((await h.call('register', input)).status, 202);
  assert.equal(h.outbox.length, 3);
  h.advance(60001);
  const protectedBefore = await h.protectedState();
  assert.equal((await h.call('register', input)).status, 429);
  assert.deepEqual(await h.protectedState(), protectedBefore);
  assert.equal(h.outbox.length, 3);
});
test('AUTH-CAP-005 deleted identity reservation survives registration race, restart and normal quota expiry without sending mail', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-deleted-identity-')),
    file = join(directory, 'accounts.json'),
    outbox = [];
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-21T12:00:00Z');
  const open = () =>
      createAccountStore({
        file,
        origin: 'https://synthetic.example',
        now: () => now,
        sendAccountMail: async (m) => outbox.push(m),
      }),
    store = open(),
    credentials = { email: 'deleted@example.com', password, name: 'Synthetic' };
  await store.register(credentials);
  const verification = new URL(outbox[0].text.match(/https:\/\/\S+/)[0]).searchParams.get('verify');
  await store.verify({ token: verification });
  const login = await store.login(credentials);
  const results = await Promise.allSettled([
    store.deleteAccount(login.sessionToken, { password }),
    store.register({ ...credentials, email: ' DELETED@example.com ' }),
  ]);
  assert.equal(
    results.every((r) => r.status === 'fulfilled'),
    true,
  );
  assert.deepEqual(await store.listUsers(), []);
  assert.equal(outbox.length, 1);
  now += 2 * 86400000;
  const restored = open();
  assert.deepEqual(await restored.register({ ...credentials, email: 'Deleted@Example.com' }), {
    ok: true,
  });
  assert.deepEqual(await restored.listUsers(), []);
  assert.equal(outbox.length, 1);
  assert.equal((await readFile(file, 'utf8')).includes('deleted@example.com'), false);
  await assert.rejects(restored.login(credentials), (e) => e.status === 401);
  assert.equal(await restored.authenticate(login.sessionToken), null);
});
