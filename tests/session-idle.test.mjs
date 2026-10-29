import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../app/accounts.mjs';
const hour = 3600000;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rm-session-idle-')),
    file = join(directory, 'accounts.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-23T12:00:00Z'),
    step = 0;
  const outbox = [];
  const credentials = {
    email: 'idle-owner@example.test',
    name: 'Idle owner',
    password: 'Synthetic-idle-password-2026!',
  };
  const open = () =>
    createAccountStore({
      file,
      origin: 'https://idle.example.test',
      now: () => {
        const at = now;
        now += step;
        return at;
      },
      sendAccountMail: async (m) => outbox.push(m),
    });
  let store = open();
  await store.register(credentials);
  await store.verify({
    token: new URL(outbox[0].text.match(/https:\/\/\S+/)[0]).searchParams.get('verify'),
  });
  return {
    file,
    credentials,
    outbox,
    get store() {
      return store;
    },
    advance(ms) {
      now += ms;
    },
    stepOnRead(ms) {
      step = ms;
    },
    get now() {
      return now;
    },
    restart() {
      store = open();
    },
    async disk() {
      return JSON.parse(await readFile(file, 'utf8'));
    },
  };
}
test('IDLE01 session admits59m59.999s without touch, expires exactly1h and rejected access cannot revive it', async (t) => {
  const h = await fixture(t),
    login = await h.store.login(h.credentials);
  h.advance(hour - 1);
  assert.equal(h.store.assertSession(login.sessionToken, login.user.id).user.id, login.user.id);
  h.advance(1);
  assert.equal(await h.store.authenticate(login.sessionToken), null);
  assert.throws(
    () => h.store.assertSession(login.sessionToken, login.user.id),
    (e) => e.status === 401,
  );
  assert.equal(await h.store.authenticate(login.sessionToken), null);
});
test('IDLE02 ten inactive sessions cease occupying slots; login durably prunes them without changing password/users', async (t) => {
  const h = await fixture(t),
    sessions = [];
  for (let i = 0; i < 10; i++) sessions.push((await h.store.login(h.credentials)).sessionToken);
  const users = (await h.disk()).users;
  h.advance(hour);
  const next = await h.store.login(h.credentials);
  assert.equal((await h.disk()).sessions.length, 1);
  assert.deepEqual((await h.disk()).users, users);
  h.restart();
  assert.ok(await h.store.authenticate(next.sessionToken));
  for (const token of sessions) assert.equal(await h.store.authenticate(token), null);
  assert.equal((await h.disk()).sessions.length, 1);
  assert.equal(h.outbox.length, 1);
});
test('IDLE03 activity refreshes idle age durably while ten active sessions remain protected from eviction', async (t) => {
  const h = await fixture(t),
    sessions = [];
  for (let i = 0; i < 10; i++) sessions.push((await h.store.login(h.credentials)).sessionToken);
  h.advance(45 * 60000);
  for (const token of sessions) assert.ok(await h.store.authenticate(token));
  h.restart();
  h.advance(45 * 60000);
  for (const token of sessions) assert.ok(h.store.assertSession(token));
  await assert.rejects(h.store.login(h.credentials), (e) => e.status === 429);
  assert.equal((await h.disk()).sessions.length, 10);
  for (const token of sessions) assert.ok(await h.store.authenticate(token));
});
test('IDLE04 legacy session without lastActiveAt uses createdAt and refreshes into a durable current session', async (t) => {
  const h = await fixture(t),
    login = await h.store.login(h.credentials),
    state = await h.disk();
  delete state.sessions[0].lastActiveAt;
  await writeFile(h.file, JSON.stringify(state), { mode: 0o600 });
  h.restart();
  h.advance(45 * 60000);
  assert.ok(await h.store.authenticate(login.sessionToken));
  assert.equal((await h.disk()).sessions[0].lastActiveAt, h.now);
  h.restart();
  h.advance(45 * 60000);
  assert.ok(h.store.assertSession(login.sessionToken));
});
test('IDLE05 active use never extends the24hour absolute deadline', async (t) => {
  const h = await fixture(t),
    login = await h.store.login(h.credentials);
  for (let i = 0; i < 47; i++) {
    h.advance(30 * 60000);
    assert.ok(await h.store.authenticate(login.sessionToken));
  }
  h.advance(30 * 60000);
  assert.equal(await h.store.authenticate(login.sessionToken), null);
});
test('IDLE06 malformed provided activity timestamp cannot fall back to createdAt and grant access', async (t) => {
  const h = await fixture(t),
    login = await h.store.login(h.credentials),
    state = await h.disk();
  state.sessions[0].lastActiveAt = 'not-a-time';
  await writeFile(h.file, JSON.stringify(state), { mode: 0o600 });
  h.restart();
  assert.equal(await h.store.authenticate(login.sessionToken), null);
});
test('IDLE07 crossing idle deadline during authentication refuses without error, mutation or session revival', async (t) => {
  const h = await fixture(t),
    login = await h.store.login(h.credentials),
    before = await h.disk();
  h.advance(hour - 1);
  h.stepOnRead(1);
  assert.equal(await h.store.authenticate(login.sessionToken), null);
  assert.deepEqual(await h.disk(), before);
  h.restart();
  assert.equal(await h.store.authenticate(login.sessionToken), null);
});
