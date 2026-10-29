import { readCapacityObservation } from './pg-capacity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { createPublicServer } from '../app/public-server.mjs';
const password = 'Synthetic-long-password-2026!';
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
    ...extraEnv,
    CONTROLLED_LOCAL_MODE: '1',
    CATALOG_BACKEND: 'postgres',
    CATALOG_DATABASE_URL: process.env.RM_TEST_PG,
    CATALOG_NAMESPACE: 'audit_api_' + randomUUID().replaceAll('-', ''),
    RESEND_RECEIVE_API_KEY: '',
    RESEND_WEBHOOK_SECRET: '',
    MAIL_FROM: '',
    MAIL_REPLY_DOMAIN: '',
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
    capacityObservation: await readCapacityObservation(),
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

import { randomUUID } from 'node:crypto';
import { profile, companies } from './fixtures.mjs';
async function workspace(h, a) {
  const cookie = a.cookie;
  await h.call('/api/profile', { cookie, body: profile });
  await h.call('/api/companies', { cookie, body: { companies } });
  const start = await h.call('/api/scans', { cookie, body: { mode: 'fixture' } });
  assert.equal(start.status, 202);
  let state;
  for (let i = 0; i < 200; i++) {
    state = (await h.call('/api/state', { cookie })).data;
    if (state.run?.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(state.run.status, 'complete');
  return state;
}
test('AH01 owner public audit records unsaved assessment then links saved opportunity; export/read leave workspace unchanged', async (t) => {
  const h = await setup(t),
    a = await h.account('audit-a@example.com'),
    s = await workspace(h, a);
  const initial = await h.call('/api/audit', { cookie: a.cookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.available, true);
  assert.ok(initial.data.events.some((e) => e.action === 'assessment'));
  for (const e of initial.data.events) {
    assert.match(e.actor.codeRevision, /^[a-f0-9]{64}$/);
    assert.match(e.at, /\.\d{3}Z$/);
  }
  assert.ok(initial.data.events.some((e) => e.action === 'recommendation'));
  const result = s.run.results[0];
  assert.ok(result.auditVacancyKey);
  const old = initial.data.events.filter((e) => e.vacancyKey === result.auditVacancyKey);
  assert.ok(old.length > 0);
  const saved = await h.call('/api/opportunities', {
    cookie: a.cookie,
    body: { resultKey: result.key, baseRevision: s.revision },
  });
  assert.equal(saved.status, 200);
  const o = saved.data.opportunities[0],
    journal = await h.call('/api/audit?opportunityId=' + o.id, { cookie: a.cookie });
  assert.equal(journal.status, 200);
  assert.ok(journal.data.events.some((e) => e.action === 'opportunity-save'));
  assert.ok(
    journal.data.events.some((e) => e.eventId === old[0].eventId),
    'saved view must include pre-save evidence',
  );
  const before = (await h.call('/api/state', { cookie: a.cookie })).data;
  const exportResponse = await h.call('/api/audit/export?opportunityId=' + o.id, {
    cookie: a.cookie,
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-type'), /ndjson|jsonl/);
  assert.ok(
    String(exportResponse.data)
      .split('\n')
      .some((line) => line.includes('assessment')),
  );
  assert.deepEqual((await h.call('/api/state', { cookie: a.cookie })).data, before);
  assert.equal(before.audit.events, undefined);
});
test('AH02 foreign opportunity filters and forged audit writes never expose/mutate another account', async (t) => {
  const h = await setup(t),
    a = await h.account('audit-owner@example.com'),
    b = await h.account('audit-other@example.com'),
    s = await workspace(h, a);
  const save = await h.call('/api/opportunities', {
      cookie: a.cookie,
      body: { resultKey: s.run.results[0].key, baseRevision: s.revision },
    }),
    id = save.data.opportunities[0].id;
  const before = await h.call('/api/audit', { cookie: a.cookie });
  assert.equal((await h.call('/api/audit?opportunityId=' + id, { cookie: b.cookie })).status, 404);
  assert.equal(
    (await h.call('/api/audit/export?opportunityId=' + id, { cookie: b.cookie })).status,
    404,
  );
  assert.equal(
    (await h.call('/api/audit?accountId=' + a.user.id, { cookie: b.cookie })).status,
    400,
  );
  assert.equal((await h.call('/api/audit')).status, 401);
  const forged = await h.call('/api/audit', {
    cookie: a.cookie,
    body: { actor: { type: 'agent' }, status: 'accepted' },
  });
  assert.ok([404, 405].includes(forged.status));
  assert.deepEqual((await h.call('/api/audit', { cookie: a.cookie })).data, before.data);
});
test('AH03 preparation cancellation/replay leave explicit failure history and unchanged saved packet revision', async (t) => {
  const h = await setup(t),
    a = await h.account('audit-prep@example.com'),
    s = await workspace(h, a);
  const saved = await h.call('/api/opportunities', {
      cookie: a.cookie,
      body: { resultKey: s.run.results[0].key, baseRevision: s.revision },
    }),
    state = saved.data,
    o = state.opportunities[0],
    body = {
      baseRevision: state.revision,
      revision: 0,
      profileVersion: state.profile.version,
      questions: ['Describe your experience.'],
      consent: true,
      requestId: randomUUID(),
    };
  const first = await h.call('/api/applications/' + o.id + '/prepare', { cookie: a.cookie, body });
  assert.equal(first.status, 200);
  const after = (await h.call('/api/state', { cookie: a.cookie })).data;
  assert.equal(after.revision, state.revision);
  assert.deepEqual(after.applications, state.applications);
  const log = (await h.call('/api/audit?opportunityId=' + o.id, { cookie: a.cookie })).data;
  assert.ok(log.events.some((e) => e.action.startsWith('preparation:')));
  const n = log.events.length;
  assert.equal(
    (await h.call('/api/applications/' + o.id + '/prepare', { cookie: a.cookie, body })).status,
    200,
  );
  assert.equal(
    (await h.call('/api/audit?opportunityId=' + o.id, { cookie: a.cookie })).data.events.length,
    n,
    'logical replay must not rerun audited provider steps',
  );
});
test('AH04 strict paging snapshot isolation and unknown historical filters are explicit', async (t) => {
  const h = await setup(t),
    a = await h.account('audit-query@example.com'),
    b = await h.account('audit-query-other@example.com');
  await workspace(h, a);
  for (const q of ['limit=0', 'limit=101', 'after=-1', 'agent=forged&accountId=x'])
    assert.equal((await h.call('/api/audit?' + q, { cookie: a.cookie })).status, 400);
  const page = (await h.call('/api/audit?limit=1', { cookie: a.cookie })).data;
  assert.equal(page.events.length, 1);
  assert.ok(page.cursor);
  const snapshot = page.snapshotRefs?.[0];
  assert.ok(snapshot, 'input snapshot reference is required, not optional');
  {
    const own = await h.call('/api/audit/snapshots/' + snapshot.digest, { cookie: a.cookie });
    assert.equal(own.status, 200);
    assert.equal(
      (await h.call('/api/audit/snapshots/' + snapshot.digest, { cookie: b.cookie })).status,
      404,
    );
  }
  assert.equal(
    (await h.call('/api/audit?opportunityId=unknown', { cookie: a.cookie })).status,
    404,
  );
});

test('AH05 historical classification retains exact country/preferences and rule grounds after profile changes', async (t) => {
  const h = await setup(t),
    a = await h.account('audit-grounds@example.com'),
    cookie = a.cookie;
  const original = {
    ...profile,
    goal: { ...profile.goal, country: 'United States' },
    preferences: {
      careerPriority: 'content',
      leadershipRequired: false,
      relocations: [],
      officePolicy: 'deprioritize',
      salary: {
        country: 'Portugal',
        currency: 'EUR',
        targetMin: 100000,
        targetMax: 120000,
        period: 'year',
        basis: 'base',
        policy: 'soft',
        unknownPolicy: 'pending',
      },
      preferredThemes: [],
      disfavoredIndustries: [],
      themesConfirmed: false,
      industriesConfirmed: false,
    },
  };
  assert.equal((await h.call('/api/profile', { cookie, body: original })).status, 200);
  await h.call('/api/companies', { cookie, body: { companies } });
  await h.call('/api/scans', { cookie, body: { mode: 'fixture' } });
  let state;
  for (let i = 0; i < 200; i++) {
    state = (await h.call('/api/state', { cookie })).data;
    if (state.run?.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const history = (await h.call('/api/audit', { cookie })).data;
  const recommendation = history.events.find((e) => e.action === 'recommendation');
  assert.ok(recommendation);
  assert.equal(
    recommendation.actor.type,
    'system',
    'classification policy is not an AI or employer verdict',
  );
  assert.equal(recommendation.actor.role, 'classification');
  const refs = history.snapshotRefs ?? [];
  let snapshots = [];
  for (const ref of refs)
    snapshots.push((await h.call('/api/audit/snapshots/' + ref.digest, { cookie })).data);
  assert.ok(
    snapshots.some(
      (s) =>
        s.kind === 'profile' &&
        s.data.goal.country === 'United States' &&
        s.data.preferences?.salary?.targetMin === 100000,
    ),
  );
  assert.ok(
    snapshots.some((s) => s.kind === 'proposal' && JSON.stringify(s).includes('constraints')),
    'actual rule grounds must be retained',
  );
  const oldIds = history.events.map((e) => e.eventId);
  await h.call('/api/profile', { cookie, body: profile });
  const next = (await h.call('/api/audit', { cookie })).data;
  assert.ok(oldIds.every((id) => next.events.some((e) => e.eventId === id)));
  for (const ref of recommendation.snapshotRefs ?? [])
    assert.equal((await h.call('/api/audit/snapshots/' + ref, { cookie })).status, 200);
});

test('AH06 each submission attempt includes its exact approved packet revision and excludes another revision', async (t) => {
  const h = await setup(t),
    a = await h.account('audit-attempt@example.com'),
    cookie = a.cookie;
  await h.call('/api/profile', { cookie, body: profile });
  const jobs = await h.call('/api/vacancies?q=Controlled%20Backend%20Engineer', { cookie });
  assert.equal(jobs.status, 200);
  const job = jobs.data.vacancies[0];
  assert.ok(job);
  let state = (await h.call('/api/state', { cookie })).data;
  state = (
    await h.call('/api/catalog-opportunities', {
      cookie,
      body: { vacancyId: job.id, baseRevision: state.revision },
    })
  ).data;
  const o = state.opportunities[0],
    attempts = [];
  for (const revision of [1, 2]) {
    const saved = await h.call('/api/applications/' + o.id, {
      cookie,
      body: {
        revision: revision - 1,
        cvVersion: 'Version ' + revision,
        cvText: 'Exact CV for attempt ' + revision,
        coverLetter: 'Cover ' + revision,
        answers: 'Answers ' + revision,
        files: [],
      },
    });
    assert.equal(saved.status, 200);
    const dispatched = await h.call('/api/mail/dispatches', {
      cookie,
      body: {
        kind: 'application',
        opportunityId: o.id,
        packetRevision: revision,
        decisionRevision: o.decisionRevision,
        to: 'candidate-test@example.com',
        subject: 'Synthetic attempt ' + revision,
        body: 'Review fixture ' + revision,
        confirm: true,
      },
    });
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.data));
    attempts.push(dispatched.data.mailDispatches.find((d) => d.packetRevision === revision).id);
  }
  for (let i = 0; i < attempts.length; i++) {
    const result = await h.call('/api/audit?applicationAttemptId=' + attempts[i], { cookie });
    assert.equal(result.status, 200);
    const rows = result.data.events;
    assert.ok(rows.some((e) => e.action === 'dispatch-approval' && e.actor.type === 'user'));
    assert.ok(rows.some((e) => e.action === 'packet-save' && e.packetRevision === i + 1));
    assert.ok(!rows.some((e) => e.action === 'packet-save' && e.packetRevision !== i + 1));
    const snapshotIds = new Set(rows.flatMap((e) => e.snapshotRefs ?? []));
    let texts = '';
    for (const id of snapshotIds)
      texts += JSON.stringify((await h.call('/api/audit/snapshots/' + id, { cookie })).data);
    assert.ok(texts.includes('Exact CV for attempt ' + (i + 1)));
    assert.ok(!texts.includes('Exact CV for attempt ' + (i === 0 ? 2 : 1)));
  }
});

test('AH07 generated packet links only to its verified owned accepted preparation and exact document text', async (t) => {
  const h = await setup(t),
    a = await h.account('audit-generated-link@example.com'),
    cookie = a.cookie;
  await h.call('/api/profile', { cookie, body: profile });
  const jobs = (await h.call('/api/vacancies?q=Controlled%20Backend%20Engineer', { cookie })).data
    .vacancies;
  let state = (await h.call('/api/state', { cookie })).data;
  state = (
    await h.call('/api/catalog-opportunities', {
      cookie,
      body: { vacancyId: jobs[0].id, baseRevision: state.revision },
    })
  ).data;
  const o = state.opportunities[0],
    requestId = randomUUID(),
    prepared = await h.call('/api/applications/' + o.id + '/prepare', {
      cookie,
      body: {
        baseRevision: state.revision,
        revision: 0,
        profileVersion: state.profile.version,
        questions: [],
        consent: true,
        requestId,
      },
    });
  assert.equal(prepared.status, 200);
  const save = {
    revision: 0,
    ...prepared.data.draft,
    files: [],
    preparedRequestId: requestId,
    preparedProfileVersion: prepared.data.provenance.profileVersion,
    preparedOpportunityHash: prepared.data.provenance.opportunityHash,
  };
  assert.equal(
    (
      await h.call('/api/applications/' + o.id, {
        cookie,
        body: { ...save, preparedRequestId: randomUUID() },
      })
    ).status,
    409,
    'forged preparation identity must not link unrelated proof',
  );
  assert.equal(
    (
      await h.call('/api/applications/' + o.id, {
        cookie,
        body: { ...save, cvText: save.cvText + ' Manually changed text.' },
      })
    ).status,
    409,
    'changed text must not be represented as exact generated proof',
  );
  const saved = await h.call('/api/applications/' + o.id, { cookie, body: save });
  assert.equal(saved.status, 200);
  const dispatch = await h.call('/api/mail/dispatches', {
    cookie,
    body: {
      kind: 'application',
      opportunityId: o.id,
      packetRevision: 1,
      decisionRevision: o.decisionRevision,
      to: 'candidate-test@example.com',
      subject: 'Generated proof fixture',
      body: 'Synthetic only',
      confirm: true,
    },
  });
  assert.equal(dispatch.status, 200);
  const attempt = dispatch.data.mailDispatches[0].id,
    history = (await h.call('/api/audit?applicationAttemptId=' + attempt, { cookie })).data.events;
  const packet = history.find((e) => e.action === 'packet-save');
  assert.equal(packet.traceId, requestId);
  assert.ok(packet.parentSpanId);
  assert.ok(
    history.some(
      (e) =>
        e.action === 'preparation:request' && e.traceId === requestId && e.status === 'accepted',
    ),
  );
  assert.ok(history.some((e) => e.action === 'preparation:generation' && e.traceId === requestId));
});
