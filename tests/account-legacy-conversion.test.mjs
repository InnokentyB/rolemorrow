import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createAccountStore } from '../app/accounts.mjs';
import { openPrivateStorage } from '../app/private-storage.mjs';
import { createPublicServer } from '../app/public-server.mjs';
test('AUTH-LEGACY-001 converted existing revisionless auth supports HTTP quota/login/logout and restart without replacing identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-auth-legacy-')),
    file = join(directory, 'accounts.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mails = [],
    credentials = {
      email: 'legacy-owner@example.test',
      name: 'Legacy owner',
      password: 'Synthetic-legacy-password-2026!',
    };
  const legacy = createAccountStore({
    file,
    origin: 'https://legacy.example.test',
    sendAccountMail: async (m) => mails.push(m),
  });
  await legacy.register(credentials);
  const token = new URL(mails[0].text.match(/https:\/\/\S+/)[0]).searchParams.get('verify');
  await legacy.verify({ token });
  const original = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(original.commitRevision, undefined);
  const storage = await openPrivateStorage({ directory, bootstrap: true });
  await storage.checkpoint();
  await storage.close();
  let server,
    base,
    providerCalls = 0;
  const forbidden = async () => {
    providerCalls++;
    throw Error('No external providers');
  };
  async function start() {
    const reservation = net.createServer();
    await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    base = 'http://127.0.0.1:' + port;
    server = await createPublicServer({
      storeDir: directory,
      env: {
        PUBLIC_ORIGIN: base,
        PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
        PUBLIC_REGISTRATION_ENABLED: '0',
        ALLOW_LIVE: '0',
        MAIL_ALLOW_SEND: '0',
        ORGANIZATION_REFRESH_ENABLED: '0',
        ORGANIZATION_DISCOVERY_ENABLED: '0',
      },
      sendAccountMail: forbidden,
      mailProvider: { send: forbidden, receive: forbidden },
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
  }
  async function stop() {
    if (server) {
      const current = server;
      server = null;
      await new Promise((r) => current.close(r));
    }
  }
  t.after(stop);
  async function login() {
    const r = await fetch(base + '/api/account/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    assert.equal(
      r.status,
      200,
      'legacy HTTP login must write quota/session using existing revision0',
    );
    return r.headers.get('set-cookie').split(';')[0];
  }
  await start();
  let cookie = await login();
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 200);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after.users, original.users);
  assert.ok(after.commitRevision >= 3);
  assert.ok(after.quotas.length >= 2);
  await stop();
  await start();
  assert.equal(
    (await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status,
    200,
    'existing session survives coordinator restart',
  );
  cookie = await login();
  const logout = await fetch(base + '/api/account/logout', {
    method: 'POST',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 401);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).users, original.users);
  assert.equal(providerCalls, 0);
});
