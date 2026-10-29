import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { createPublicServer } from '../app/public-server.mjs';
const password = 'Synthetic-long-password-2026!';
const webhookSecret =
  'whsec_' + Buffer.from('synthetic-only-public-webhook-secret').toString('base64');
async function reservePort() {
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
async function setup(t, extraEnv = {}, extraOptions = {}) {
  const storeDir = await mkdtemp(join(tmpdir(), 'rolemorrow-public-'));
  const port = await reservePort(),
    base = `http://127.0.0.1:${port}`,
    outbox = [];
  const env = {
    PUBLIC_ORIGIN: base,
    PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
    PUBLIC_REGISTRATION_ENABLED: '1',
    MAIL_FROM: 'applications@apply.rolemorrow.com',
    MAIL_REPLY_DOMAIN: 'apply.rolemorrow.com',
    RESEND_RECEIVE_API_KEY: 'synthetic-only',
    RESEND_WEBHOOK_SECRET: webhookSecret,
    ...extraEnv,
  };
  const mailProvider = {
    send: async () => {
      throw Error('No outbound mail allowed in public-service tests');
    },
    receive: async () => {
      throw Error('No inbound requests allowed in public-service tests');
    },
  };
  const server = await createPublicServer({
    storeDir,
    env,
    sendAccountMail: async (message) => {
      outbox.push(structuredClone(message));
    },
    mailProvider,
    ...extraOptions,
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(async () => {
    if (server.ingress?.listening) await new Promise((r) => server.ingress.close(r));
    await new Promise((r) => server.close(r));
    await rm(storeDir, { recursive: true, force: true });
  });
  async function call(
    path,
    { body, method = body === undefined ? 'GET' : 'POST', cookie, origin = base, accountId } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
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
    return {
      status: response.status,
      data,
      cookies: response.headers.getSetCookie(),
      headers: response.headers,
    };
  }
  const tokenFrom = (mail, kind) => {
    const content = [mail?.text, mail?.html, mail?.url, mail?.verificationUrl, mail?.resetUrl]
      .filter(Boolean)
      .join('\n');
    const token = mail?.token ?? content.match(new RegExp(`[?&]${kind}=([^\\s"'<>]+)`))?.[1];
    assert.ok(token, `Captured synthetic ${kind} message must contain its account link`);
    return decodeURIComponent(token);
  };
  async function account(email) {
    const start = outbox.length;
    let r = await call('/api/account/register', {
      body: { name: 'Synthetic Candidate', email, password },
    });
    assert.ok([200, 202].includes(r.status));
    assert.equal(r.cookies.length, 0);
    const mail = outbox
      .slice(start)
      .find((m) => m.to === email || (Array.isArray(m.to) && m.to.includes(email)));
    assert.ok(mail, 'Registration produces only captured synthetic account mail');
    r = await call('/api/account/login', { body: { email, password } });
    assert.equal(r.status, 401, 'unverified accounts cannot sign in');
    r = await call('/api/account/verify', { body: { token: tokenFrom(mail, 'verify') } });
    assert.equal(r.status, 200);
    assert.ok(r.data.user);
    assert.equal(r.cookies.length, 0, 'verification does not silently sign in');
    r = await call('/api/account/login', { body: { email, password } });
    assert.equal(r.status, 200);
    const session = r.cookies.find((c) => c.startsWith('rm_session='));
    assert.ok(session);
    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=(?:Lax|Strict)/i);
    assert.match(session, /Path=\//i);
    return { email, cookie: session.split(';')[0], user: r.data.user };
  }
  return { call, account, outbox, tokenFrom, base, server, mailProvider, env };
}
test('PS05 stale workspace identity cannot read or mutate a newly signed-in account', async (t) => {
  const h = await setup(t),
    a = await h.account('identity-a@example.com'),
    b = await h.account('identity-b@example.com');
  const before = (await h.call('/api/state', { cookie: b.cookie })).data;
  const stale = { cookie: b.cookie, accountId: a.user.id };
  assert.equal((await h.call('/api/state', stale)).status, 409);
  assert.equal(
    (
      await h.call('/api/intake/url', {
        ...stale,
        body: {
          url: 'https://employer.example/jobs/a-private-draft',
          title: 'A private draft',
          baseRevision: before.revision,
        },
      })
    ).status,
    409,
  );
  assert.deepEqual(
    (await h.call('/api/state', { cookie: b.cookie, accountId: b.user.id })).data,
    before,
  );
});
test('PS01 anonymous access and foreign origins cannot reach private workspace APIs', async (t) => {
  const h = await setup(t);
  assert.equal((await h.call('/api/state')).status, 401);
  assert.equal((await h.call('/api/account/me')).status, 401);
  assert.equal((await h.call('/api/application-files/unknown/unknown')).status, 401);
  assert.equal(
    (
      await h.call('/api/account/register', {
        body: { email: 'cross@example.com', name: 'Cross', password },
        origin: 'https://foreign.example',
      })
    ).status,
    403,
  );
  assert.equal(h.outbox.length, 0);
});
test('PS02 verified accounts have isolated state, private files and independently revoked sessions', async (t) => {
  const h = await setup(t),
    a = await h.account('alice@example.com'),
    b = await h.account('bob@example.com');
  let r = await h.call('/api/intake/url', {
    cookie: a.cookie,
    body: {
      url: 'https://employer.example/jobs/private-a',
      title: 'Private Alice role',
      baseRevision: 0,
    },
  });
  assert.equal(r.status, 200);
  const o = r.data.opportunities[0];
  r = await h.call('/api/applications/' + o.id, {
    cookie: a.cookie,
    body: {
      revision: 0,
      cvVersion: 'Alice private CV',
      cvText: 'Private A content',
      coverLetter: '',
      answers: '',
      files: [
        {
          name: 'cv.txt',
          type: 'text/plain',
          base64: Buffer.from('Private Alice attachment').toString('base64'),
        },
      ],
    },
  });
  assert.equal(r.status, 200);
  const file = r.data.applications[0].files[0];
  assert.equal(
    (await h.call('/api/application-files/' + o.id + '/' + file.id, { cookie: a.cookie })).data,
    'Private Alice attachment',
  );
  const bob = await h.call('/api/state', { cookie: b.cookie });
  assert.equal(bob.status, 200);
  assert.equal(bob.data.opportunities.length, 0);
  assert.equal(bob.data.applications.length, 0);
  assert.ok(!JSON.stringify(bob.data).includes('Private A'));
  assert.equal(
    (await h.call('/api/application-files/' + o.id + '/' + file.id, { cookie: b.cookie })).status,
    404,
  );
  assert.equal(
    (
      await h.call('/api/opportunities/' + o.id, {
        cookie: b.cookie,
        body: {
          decisionRevision: 0,
          stage: 'rejected',
          note: 'Injected',
          nextAction: '',
          dueDate: '',
        },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await h.call('/api/intake/url', {
        cookie: a.cookie,
        origin: 'https://foreign.example',
        body: { url: 'https://employer.example/forbidden', baseRevision: r.data.revision },
      })
    ).status,
    403,
  );
  assert.equal((await h.call('/api/account/logout', { cookie: a.cookie, body: {} })).status, 200);
  assert.equal((await h.call('/api/state', { cookie: a.cookie })).status, 401);
  assert.equal((await h.call('/api/state', { cookie: b.cookie })).status, 200);
});
test('PS03 reset invalidates old credentials and deletion cannot expose or recreate another workspace', async (t) => {
  const h = await setup(t),
    a = await h.account('reset@example.com'),
    b = await h.account('survivor@example.com');
  let r = await h.call('/api/account/request-reset', { body: { email: a.email } });
  assert.ok([200, 202].includes(r.status));
  const mail = h.outbox
      .filter((m) => m.to === a.email || (Array.isArray(m.to) && m.to.includes(a.email)))
      .at(-1),
    token = h.tokenFrom(mail, 'reset'),
    nextPassword = 'Replacement-synthetic-password-2026!';
  r = await h.call('/api/account/reset', { body: { token, password: nextPassword } });
  assert.equal(r.status, 200);
  assert.equal((await h.call('/api/state', { cookie: a.cookie })).status, 401);
  assert.equal(
    (await h.call('/api/account/login', { body: { email: a.email, password } })).status,
    401,
  );
  r = await h.call('/api/account/login', { body: { email: a.email, password: nextPassword } });
  assert.equal(r.status, 200);
  const cookie = r.cookies.find((c) => c.startsWith('rm_session=')).split(';')[0];
  assert.equal(
    (await h.call('/api/account/reset', { body: { token, password: nextPassword } })).status,
    400,
  );
  assert.equal(
    (
      await h.call('/api/account', {
        method: 'DELETE',
        cookie,
        body: { password: nextPassword, confirm: true },
      })
    ).status,
    200,
  );
  assert.equal((await h.call('/api/state', { cookie })).status, 401);
  assert.equal(
    (await h.call('/api/account/login', { body: { email: a.email, password: nextPassword } }))
      .status,
    401,
  );
  const survivor = await h.call('/api/state', { cookie: b.cookie });
  assert.equal(survivor.status, 200);
  assert.equal(survivor.data.opportunities.length, 0);
});
async function ingress(h) {
  const base = h.base,
    createdAt = new Date().toISOString();
  return async (id, emailId, to) => {
    const raw = JSON.stringify({
        type: 'email.received',
        created_at: createdAt,
        data: { email_id: emailId, to },
      }),
      ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64'))
      .update(`${id}.${ts}.${raw}`)
      .digest('base64');
    return fetch(base + '/hooks/resend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': ts,
        'svix-signature': 'v1,' + signature,
      },
      body: raw,
    });
  };
}
test('PS04 signed ingress routes one tenant only and mixed or deleted mailbox tags cannot materialize mail', async (t) => {
  const h = await setup(t),
    a = await h.account('mail-a@example.com'),
    b = await h.account('mail-b@example.com');
  const save = async (account) =>
    (
      await h.call('/api/intake/url', {
        cookie: account.cookie,
        body: { url: 'https://employer.example/jobs/shared-link', title: 'Role', baseRevision: 0 },
      })
    ).data.opportunities[0];
  const oa = await save(a),
    ob = await save(b),
    aa = `op-${a.user.mailboxTag}-${oa.id}@apply.rolemorrow.com`,
    ab = `op-${b.user.mailboxTag}-${ob.id}@apply.rolemorrow.com`;
  let reads = 0;
  h.mailProvider.receive = async (id) => {
    reads++;
    return {
      providerId: id,
      transportId: id,
      messageId: `<${id}@employer.example>`,
      from: 'hiring@employer.example',
      to: [id === 'mismatched-mail' ? ab : aa],
      subject: 'Next step',
      text: 'Please confirm availability.',
      files: [],
      attachments: [],
    };
  };
  const post = await ingress(h);
  assert.equal((await post('mixed-event', 'mixed-mail', [aa, ab])).status, 200);
  assert.equal(reads, 0);
  assert.equal((await h.call('/api/state', { cookie: a.cookie })).data.messages.length, 0);
  assert.equal((await h.call('/api/state', { cookie: b.cookie })).data.messages.length, 0);
  assert.equal((await post('a-event', 'a-mail', [aa])).status, 200);
  assert.equal(reads, 1);
  const as = (await h.call('/api/state', { cookie: a.cookie })).data,
    bs = (await h.call('/api/state', { cookie: b.cookie })).data;
  assert.equal(as.messages.length, 1);
  assert.equal(as.messages[0].opportunityId, oa.id);
  assert.equal(as.notifications.length, 1);
  assert.equal(bs.messages.length, 0);
  assert.equal(bs.notifications.length, 0);
  assert.equal((await post('a-event', 'a-mail', [aa])).status, 200);
  assert.equal((await h.call('/api/state', { cookie: a.cookie })).data.notifications.length, 1);
  await post('mismatched-event', 'mismatched-mail', [aa]);
  assert.equal(
    (await h.call('/api/state', { cookie: a.cookie })).data.messages.length,
    1,
    'provider-fetched recipients must belong to the routed account',
  );
  assert.equal((await h.call('/api/state', { cookie: b.cookie })).data.messages.length, 0);
  assert.equal(
    (
      await h.call('/api/account', {
        method: 'DELETE',
        cookie: a.cookie,
        body: { password, confirm: true },
      })
    ).status,
    200,
  );
  const before = reads;
  assert.equal((await post('deleted-event', 'deleted-mail', [aa])).status, 200);
  assert.equal(reads, before);
  assert.equal((await h.call('/api/state', { cookie: a.cookie })).status, 401);
  assert.equal((await h.call('/api/state', { cookie: b.cookie })).data.messages.length, 0);
});
test('PE02 public entry exposes no workspace and existing users must explicitly accept current policies', async (t) => {
  const h = await setup(t),
    a = await h.account('legacy-policies@example.com');
  h.env.PUBLIC_POLICY_ENFORCEMENT = '1';
  const metadata = await h.call('/api/policies');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.data.enforced, true);
  const landing = await h.call('/');
  assert.equal(landing.status, 200);
  assert.match(landing.data, /Turn a vacancy into a considered application/);
  assert(!landing.data.includes(a.email));
  for (const path of ['/privacy', '/terms']) assert.equal((await h.call(path)).status, 200);
  assert.equal(
    (
      await h.call('/api/account/register', {
        body: {
          email: 'new-policy@example.com',
          name: 'Candidate',
          password,
          acceptance: { termsAccepted: false },
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.call('/api/account/me', { cookie: a.cookie })).data.policies.required,
    true,
  );
  const redirect = await h.call('/', { cookie: a.cookie });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/account?setup=1');
  assert.equal(
    (
      await h.call('/api/intake/url', {
        cookie: a.cookie,
        body: { url: 'https://employer.example/jobs/policy', baseRevision: 0 },
      })
    ).status,
    403,
  );
  const acceptance = {
    termsVersion: metadata.data.termsVersion,
    termsDigest: metadata.data.documents.terms.sha256,
    privacyDigest: metadata.data.documents.privacy.sha256,
    privacyVersion: metadata.data.privacyVersion,
    termsAccepted: true,
    privacyAcknowledged: true,
  };
  const accepted = await h.call('/api/account/accept-policies', {
    cookie: a.cookie,
    body: { acceptance },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.user.id, a.user.id);
  assert.equal(accepted.data.policies.required, false);
  assert.equal(
    (
      await h.call('/api/intake/url', {
        cookie: a.cookie,
        body: { url: 'https://employer.example/jobs/policy', baseRevision: 0 },
      })
    ).status,
    200,
  );
});
test('PC04 only signed privacy ingress forwards operator correspondence, without creating tenant mail', async (t) => {
  const h = await setup(t, { PRIVACY_FORWARD_TO: 'operator@example.com' });
  let sends = 0;
  h.mailProvider.receive = async () => ({
    from: 'sender@example.com',
    to: ['privacy@example.invalid'],
    subject: 'Privacy',
    text: 'Synthetic contact',
    attachments: [],
  });
  h.mailProvider.send = async (input) => {
    sends++;
    assert.deepEqual(input.to, ['operator@example.com']);
    return { id: 'privacy-forward' };
  };
  const signed = await ingress(h);
  assert.equal(
    (await signed('privacy-event', 'privacy-mail', ['privacy@example.invalid'])).status,
    200,
  );
  assert.equal(sends, 1);
  assert.equal(
    (await signed('privacy-replay', 'privacy-mail', ['privacy@example.invalid'])).status,
    200,
  );
  assert.equal(sends, 1);
  const unsigned = await fetch(h.base + '/hooks/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'email.received',
      data: { email_id: 'forged', to: ['privacy@example.invalid'] },
    }),
  });
  assert.equal(unsigned.status, 401);
  assert.equal(sends, 1);
});
test('PE02b enforced public registration rejects a missing policy receipt before account creation', async (t) => {
  const h = await setup(t, { PUBLIC_POLICY_ENFORCEMENT: '1' });
  assert.equal(
    (
      await h.call('/api/account/register', {
        body: { email: 'no-policy@example.com', name: 'Candidate', password },
      })
    ).status,
    400,
  );
  assert.equal((await h.server.accounts.listUsers()).length, 0);
  assert.equal(h.outbox.length, 0);
});

test('OC08 catalog is authenticated/read-only; selected official domain gets canonical identity without publishing private additions', async (t) => {
  const { call, account } = await setup(t);
  assert.equal((await call('/api/organizations')).status, 401);
  const a = await account('catalog@example.com');
  let r = await call('/api/organizations?q=maze', { cookie: a.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.organizations.length, 1);
  const org = r.data.organizations[0];
  assert.equal(org.name, 'Maze');
  assert.equal(org.hiring, 'unknown');
  const filtered = await call(
    '/api/organizations?industry=data&employeeSize=' + encodeURIComponent('5,001–10,000'),
    { cookie: a.cookie },
  );
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.matching, 1);
  assert.equal(filtered.data.organizations[0].name, 'MongoDB');
  assert.equal(filtered.data.nextOffset, null);
  assert.ok(filtered.data.facets.industries.some((x) => x.value === 'data' && x.count > 0));
  const empty = await call('/api/organizations?q=MongoDB&industry=security', { cookie: a.cookie });
  assert.equal(empty.data.matching, 0);
  assert.deepEqual(empty.data.organizations, []);
  const before = (await call('/api/state', { cookie: a.cookie })).data;
  r = await call('/api/companies', {
    cookie: a.cookie,
    body: {
      baseRevision: before.revision,
      companies: [
        {
          name: 'Wrong name',
          homepage: 'https://www.maze.co',
          careers: 'https://www.maze.co/careers/',
        },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.companies[0].organizationId, org.id);
  assert.equal(r.data.companies[0].name, 'Maze');
  const revision = r.data.revision;
  r = await call('/api/companies', {
    cookie: a.cookie,
    body: {
      baseRevision: revision,
      companies: [
        {
          name: 'My private target',
          homepage: 'https://private-target.example',
          careers: 'https://private-target.example/jobs',
        },
      ],
    },
  });
  assert.equal(r.status, 200);
  r = await call('/api/organizations?q=private-target', { cookie: a.cookie });
  assert.equal(r.data.organizations.length, 0);
  const b = await account('catalog-other@example.com');
  assert.deepEqual((await call('/api/state', { cookie: b.cookie })).data.companies, []);
});

test('CG07 successful user source saves and explicit unknown searches grow the shared catalog only through verification', async (t) => {
  let verified = [];
  const verifier = async (candidate) => {
    verified.push(candidate);
    return {
      name: 'Public New Company',
      homepage: 'https://new-public.example',
      careers: 'https://new-public.example/careers',
      provenance: { kind: 'public-website-linked-careers' },
    };
  };
  const { call, account } = await setup(
    t,
    { ORGANIZATION_DISCOVERY_ENABLED: '1' },
    { organizationVerifier: verifier },
  );
  const a = await account('growth-one@example.com'),
    b = await account('growth-two@example.com');
  assert.equal(
    (await call('/api/organization-suggestions', { body: { query: 'New Company' } })).status,
    401,
  );
  await call('/api/organizations?q=Unknown', { cookie: a.cookie });
  assert.equal(verified.length, 0, 'passive search never triggers paid discovery');
  const before = (await call('/api/state', { cookie: a.cookie })).data;
  const saved = await call('/api/companies', {
    cookie: a.cookie,
    body: {
      baseRevision: before.revision,
      companies: [
        {
          name: 'PRIVATE target label',
          industry: 'PRIVATE preference',
          homepage: 'https://new-public.example',
          careers: 'https://new-public.example/careers',
        },
      ],
    },
  });
  assert.equal(saved.status, 200);
  let shared;
  for (let i = 0; i < 50; i++) {
    shared = await call('/api/organizations?q=Public New', { cookie: b.cookie });
    if (shared.data.organizations.length) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(shared.data.organizations[0].name, 'Public New Company');
  assert.equal(JSON.stringify(shared.data).includes('PRIVATE'), false);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].name, undefined);
  assert.equal(verified[0].industry, undefined);
  assert.equal(verified[0].userId, undefined);
  assert.deepEqual((await call('/api/state', { cookie: b.cookie })).data.companies, []);
  assert.equal(
    (
      await call('/api/organization-suggestions', {
        cookie: a.cookie,
        body: { query: 'New Query' },
      })
    ).status,
    202,
  );
  for (let i = 0; i < 50 && verified.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(verified.length, 2);
  const page = await call('/api/organizations?offset=30', { cookie: b.cookie });
  assert.ok(page.data.organizations.length > 0);
  assert.equal(
    new Set(page.data.organizations.map((x) => x.id)).size,
    page.data.organizations.length,
  );
});

test('VC04 authenticated shared vacancy snapshots do not mutate either personal workspace', async (t) => {
  const inspector = async (company) => ({
    status: 'openings-observed',
    openingCount: 1,
    sources: [company.careers],
    postings: [
      {
        url: company.careers + '/synthetic-role',
        title: 'Synthetic Senior Backend Engineer',
        text: 'Public source text only; Python and PostgreSQL',
        location: 'Remote - Portugal',
        facts: {
          workplaceType: 'Remote',
          employmentType: 'FullTime',
          salary: [
            {
              compensationType: 'Salary',
              currencyCode: 'EUR',
              interval: '1 YEAR',
              minValue: 80000,
              maxValue: 100000,
            },
          ],
        },
        sources: [company.careers],
      },
    ],
    inventory: { complete: false, urls: [], sources: [] },
  });
  const { call, account } = await setup(
    t,
    { ORGANIZATION_REFRESH_ENABLED: '1' },
    { organizationInspector: inspector },
  );
  assert.equal((await call('/api/vacancies')).status, 401);
  const a = await account('vacancy-one@example.com'),
    b = await account('vacancy-two@example.com');
  let data;
  for (let i = 0; i < 100; i++) {
    data = (await call('/api/vacancies?q=Synthetic', { cookie: a.cookie })).data;
    if (data.total > 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(data.total > 0);
  assert.equal(data.collection.batchSize, 10);
  assert.equal(data.collection.batchIntervalHours, 1);
  assert.equal(data.collection.companyIntervalHours, 24);
  assert.ok(data.collection.nextBatchAt > Date.now());
  assert.equal(data.vacancies[0].text, 'Public source text only; Python and PostgreSQL');
  const row = data.vacancies[0],
    other = await call('/api/vacancies?organizationId=' + row.organizationId, { cookie: b.cookie });
  assert.equal(other.status, 200);
  assert.equal(other.data.vacancies[0].id, row.id);
  assert.equal(other.data.coverage.complete, false);
  const filtered = await call(
    '/api/vacancies?q=python+synthetic&role=backend&level=senior&skills=python,postgresql&workMode=remote&location=portugal&salaryMin=90000&currency=EUR&salaryInterval=1%20YEAR',
    { cookie: a.cookie },
  );
  assert.ok(filtered.data.matching > 0);
  assert.equal((await call('/api/vacancies?level=junior', { cookie: a.cookie })).data.matching, 0);
  assert.equal(
    (await call('/api/vacancies?exclude=postgresql', { cookie: a.cookie })).data.matching,
    0,
  );
  assert.equal((await call('/api/state', { cookie: a.cookie })).data.opportunities.length, 0);
  assert.equal((await call('/api/state', { cookie: b.cookie })).data.opportunities.length, 0);
});
test('PE07 whitespace and case variants share the verification-email quota of their canonical mailbox', async (t) => {
  let now = Date.now();
  const h = await setup(t, {}, { accountNow: () => now });
  for (const email of ['quota@example.com', ' QUOTA@example.com', 'quota@example.com ']) {
    assert.equal(
      (await h.call('/api/account/register', { body: { email, password, name: 'Synthetic' } }))
        .status,
      202,
    );
    now += 60001;
  }
  assert.equal(
    (
      await h.call('/api/account/register', {
        body: { email: ' quota@example.com ', password, name: 'Synthetic' },
      })
    ).status,
    429,
  );
  assert.equal(h.outbox.length, 3);
});
test('RV02 health identifies exact shipped source without authentication or runtime secrets', async (t) => {
  const h = await setup(t);
  const response = await h.call('/health');
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.match(response.data.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(response.data).sort(), ['ok', 'revision']);
});
