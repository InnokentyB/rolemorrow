import { readCapacityObservation } from './pg-capacity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPublicServer } from '../app/public-server.mjs';
import { TERMS_VERSION, PRIVACY_VERSION, policyDigest } from '../app/policies.mjs';
const password = 'Synthetic-gateway-password-2026!';
const connectionString = process.env.RM_TEST_PG ?? process.env.ROLEMORROW_PG_TEST_URL;
const blankArrays = [
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
];
async function reserve() {
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
test(
  'PG-WEB-ISOLATION-001 two verified accounts cannot access foreign packet/dispatch/reply; durable deletion survives gateway restart',
  { timeout: 30000 },
  async (t) => {
    assert.equal(process.env.ROLEMORROW_PG_SYNTHETIC, '1', 'Synthetic database marker required');
    assert.ok(connectionString, 'Synthetic PostgreSQL connection required');
    const directory = await mkdtemp(join(tmpdir(), 'rm-gateway-private-')),
      port = await reserve(),
      origin = 'http://127.0.0.1:' + port,
      namespace = 'gateway_private_' + randomBytes(6).toString('hex'),
      outbox = [],
      outbound = [];
    let server;
    const env = {
      PUBLIC_ORIGIN: origin,
      PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
      PUBLIC_REGISTRATION_ENABLED: '1',
      PUBLIC_POLICY_ENFORCEMENT: '1',
      CATALOG_BACKEND: 'postgres',
      CATALOG_DATABASE_URL: connectionString,
      CATALOG_NAMESPACE: namespace,
      CONTROLLED_LOCAL_MODE: '1',
    };
    async function start() {
      server = await createPublicServer({
        capacityObservation: await readCapacityObservation(),
        storeDir: directory,
        env,
        sendAccountMail: async (mail) => outbox.push(mail),
        mailProvider: {
          send: async (mail) => {
            outbound.push(mail);
            throw Error('Forbidden outbound provider attempt');
          },
          receive: async () => {
            outbound.push('receive');
            throw Error('Forbidden receive provider attempt');
          },
        },
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
    }
    async function stop() {
      if (!server) return;
      const current = server;
      server = null;
      await new Promise((resolve, reject) =>
        current.close((error) => (error ? reject(error) : resolve())),
      );
    }
    t.after(async () => {
      await stop();
      const cleanup = new pg.Client({ connectionString });
      try {
        await cleanup.connect();
        await cleanup.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
      } finally {
        await cleanup.end();
        await rm(directory, { recursive: true, force: true });
      }
    });
    async function call(
      path,
      { body, cookie, accountId, method = body === undefined ? 'GET' : 'POST' } = {},
    ) {
      const response = await fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(accountId ? { 'X-Rolemorrow-Account-ID': accountId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: response.status, data, text, cookies: response.headers.getSetCookie() };
    }
    async function account(email) {
      const before = outbox.length;
      let response = await call('/api/account/register', {
        body: {
          email,
          password,
          name: 'Synthetic ' + email,
          acceptance: {
            termsAccepted: true,
            privacyAcknowledged: true,
            termsVersion: TERMS_VERSION,
            termsDigest: policyDigest('terms'),
            privacyDigest: policyDigest('privacy'),
            privacyVersion: PRIVACY_VERSION,
          },
        },
      });
      assert.equal(response.status, 202, response.text);
      const mail = outbox.slice(before).find((mail) => mail.to === email);
      assert.ok(mail, 'Verification captured locally');
      const token = mail.text.match(/[?&]verify=([^\s]+)/)?.[1];
      assert.ok(token);
      response = await call('/api/account/verify', { body: { token: decodeURIComponent(token) } });
      assert.equal(response.status, 200, response.text);
      response = await call('/api/account/login', { body: { email, password } });
      assert.equal(response.status, 200, response.text);
      const cookie = response.cookies
        .find((cookie) => cookie.startsWith('rm_session='))
        ?.split(';')[0];
      assert.ok(cookie);
      assert.equal(response.data.user.verified, true);
      return { user: response.data.user, cookie };
    }
    await start();
    const alice = await account('gateway-alice@example.invalid'),
      bob = await account('gateway-bob@example.invalid');
    const a = (options) => ({ ...options, cookie: alice.cookie, accountId: alice.user.id }),
      b = (options) => ({ ...options, cookie: bob.cookie, accountId: bob.user.id });
    let response = await call(
      '/api/profile',
      a({
        body: {
          facts: [{ id: 'f1', text: 'PRIVATE-GATEWAY-CANARY-298 Built Python services.' }],
          goal: {
            roles: 'Backend Engineer',
            industries: 'Developer tools',
            country: 'Portugal',
            workMode: 'remote',
          },
        },
      }),
    );
    assert.equal(response.status, 200, response.text);
    const vacancies = await call('/api/vacancies?q=Controlled', a());
    assert.equal(vacancies.status, 200);
    assert.equal(vacancies.data.collection.mode, 'sequential-rounds');
    assert.ok(vacancies.data.vacancies.length);
    response = await call(
      '/api/catalog-opportunities',
      a({
        body: { vacancyId: vacancies.data.vacancies[0].id, baseRevision: response.data.revision },
      }),
    );
    assert.equal(response.status, 200, response.text);
    const opportunity = response.data.opportunities[0];
    response = await call(
      '/api/applications/' + opportunity.id,
      a({
        body: {
          revision: 0,
          cvVersion: 'Synthetic CV',
          cvText: 'PRIVATE-GATEWAY-CANARY-298',
          coverLetter: '',
          answers: '',
          files: [
            {
              name: 'synthetic.txt',
              type: 'text/plain',
              base64: Buffer.from('PRIVATE-GATEWAY-FILE-721').toString('base64'),
            },
          ],
        },
      }),
    );
    assert.equal(response.status, 200, response.text);
    const packet = response.data.applications[0],
      file = packet.files[0];
    const dispatch = {
      kind: 'application',
      opportunityId: opportunity.id,
      packetRevision: packet.revision,
      decisionRevision: opportunity.decisionRevision,
      to: 'candidate@example.invalid',
      subject: 'Synthetic gateway application',
      body: 'Synthetic application only',
      confirm: true,
    };
    response = await call('/api/mail/dispatches', a({ body: dispatch }));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.data.mailDispatches[0].status, 'simulated');
    const dispatchId = response.data.mailDispatches[0].id;
    response = await call(
      '/api/mail/simulated-reply',
      a({ body: { opportunityId: opportunity.id } }),
    );
    assert.equal(response.status, 200, response.text);
    const message = response.data.messages[0],
      notification = response.data.notifications[0];
    assert.ok(message && notification);
    const protectedPath = join(directory, 'users', alice.user.id, 'state.json'),
      beforeAlice = await readFile(protectedPath),
      beforeBob = (await call('/api/state', b())).data;
    const attacks = [
      ['/api/application-files/' + opportunity.id + '/' + file.id, undefined, 404],
      [
        '/api/opportunities/' + opportunity.id,
        {
          decisionRevision: opportunity.decisionRevision,
          stage: 'rejected',
          note: 'foreign mutation',
          nextAction: '',
          dueDate: '',
        },
        404,
      ],
      [
        '/api/applications/' + opportunity.id,
        {
          revision: packet.revision,
          cvVersion: 'Foreign',
          cvText: 'Injected',
          coverLetter: '',
          answers: '',
          files: [],
        },
        404,
      ],
      ['/api/mail/dispatches', dispatch, 404],
      ['/api/mail/simulated-reply', { opportunityId: opportunity.id }, 409],
      ['/api/mail/replies/' + message.id, { revision: 0, body: 'Foreign reply' }, 404],
      [
        '/api/mail/notifications/' + notification.id,
        { revision: notification.revision, read: true },
        404,
      ],
      ['/api/mail/dispatches/' + dispatchId + '/retry', { confirm: true, revision: 1 }, 503],
    ];
    for (const [path, body, status] of attacks) {
      const denied = await call(path, b({ body }));
      assert.equal(denied.status, status, path + ' ' + denied.text);
      assert.ok(
        !denied.text.includes('PRIVATE-GATEWAY'),
        'Foreign response must not expose private content',
      );
    }
    const mismatch = await call('/api/state', { cookie: bob.cookie, accountId: alice.user.id });
    assert.equal(mismatch.status, 409);
    assert.deepEqual(
      await readFile(protectedPath),
      beforeAlice,
      'Foreign actions changed owner aggregate',
    );
    const afterBob = (await call('/api/state', b())).data;
    assert.equal(afterBob.revision, beforeBob.revision);
    for (const field of [
      'opportunities',
      'applications',
      'messages',
      'replyDrafts',
      'mailDispatches',
      'notifications',
    ])
      assert.deepEqual(afterBob[field], beforeBob[field], field);
    assert.ok(!JSON.stringify(afterBob).includes('PRIVATE-GATEWAY'));
    response = await call(
      '/api/account',
      a({ method: 'DELETE', body: { password, confirm: true } }),
    );
    assert.equal(response.status, 200, response.text);
    assert.equal((await call('/api/state', a())).status, 401);
    const purged = JSON.parse(await readFile(protectedPath, 'utf8'));
    assert.equal(purged.profile, null);
    assert.equal(purged.run, null);
    for (const field of blankArrays) assert.deepEqual(purged[field], [], field);
    assert.ok(!JSON.stringify(purged).includes('PRIVATE-GATEWAY'));
    await stop();
    await start();
    assert.equal((await call('/api/state', a())).status, 401);
    assert.equal(
      (await call('/api/account/login', { body: { email: alice.user.email, password } })).status,
      401,
    );
    const survivor = await call('/api/state', b());
    assert.equal(survivor.status, 200, survivor.text);
    assert.equal(survivor.data.revision, afterBob.revision);
    assert.deepEqual(survivor.data.opportunities, afterBob.opportunities);
    assert.equal(outbound.length, 0, 'No live provider side effects');
    assert.equal(outbox.length, 2, 'Only two captured synthetic verification messages');
  },
);
