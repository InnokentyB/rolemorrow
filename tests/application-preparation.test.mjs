import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../app/server.mjs';
import {
  preparationClaimInventory,
  preparationEvidenceCatalog,
  resolvePreparationReferences,
} from '../app/application-preparation.mjs';
import { getProviders } from '../app/providers.mjs';
import { profile, companies, providers } from './fixtures.mjs';
const questions = ['Describe your product experience.', 'Do you hold a Kubernetes certification?'];
const claim = (text, id) => ({
  text,
  citations: [{ factId: id, quote: profile.facts.find((f) => f.id === id).text }],
});
const proposal = () => ({
  version: 2,
  cv: {
    summary: [claim(profile.facts[0].text, 'f1')],
    skills: [],
    experience: [
      {
        heading: claim('Product experience', 'f1'),
        bullets: [claim(profile.facts[0].text, 'f1')],
      },
    ],
  },
  coverLetter: [
    claim('My onboarding experience includes: ' + profile.facts[1].text, 'f2'),
    claim('I bring the following product delivery background: ' + profile.facts[0].text, 'f1'),
  ],
  answers: [
    {
      questionIndex: 0,
      status: 'answered',
      claims: [claim(profile.facts[0].text, 'f1')],
    },
    { questionIndex: 1, status: 'unknown', claims: [] },
  ],
});
const asWire = (proposal) => {
  const p = structuredClone(proposal);
  for (const claim of [
    ...p.cv.summary,
    ...p.cv.skills,
    ...p.cv.experience.flatMap((g) => [g.heading, ...g.bullets]),
    ...p.coverLetter,
    ...p.answers.flatMap((a) => a.claims),
  ])
    claim.citations = claim.citations.map(
      (c) =>
        preparationEvidenceCatalog(profile).find(
          (row) => row.factId === c.factId && row.quote === c.quote,
        ).ref,
    );
  return p;
};
const acceptedReview = (p) => ({
  reviews: preparationClaimInventory(p).map(({ claimId }) => ({
    claimId,
    supported: true,
    reason: 'Synthetic supported claim.',
  })),
  coverage: { complete: true, reason: 'Synthetic coverage only.' },
  answersComplete: true,
  distinctCover: true,
});

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'preparation-')),
    file = join(dir, 'state.json');
  let calls = 0;
  const server = createServer({
    storeFile: file,
    env: { CONTROLLED_LOCAL_MODE: '1', ...options.env },
    preparationTimeoutMs: options.timeout ?? 60000,
    providers: providers({
      prepareApplication: async (...args) => {
        calls++;
        return options.prepare ? options.prepare(...args) : proposal();
      },
    }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (path, body, method = 'POST') => {
    const r = await fetch(origin + path, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, data: await r.json() };
  };
  const state = async () => (await call('/api/state', undefined, 'GET')).data;
  await call('/api/profile', profile);
  await call('/api/companies', { companies });
  await call('/api/scans', { mode: 'fixture' });
  let s;
  for (let n = 0; n < 100; n++) {
    s = await state();
    if (s.run.status !== 'running') break;
    await delay(5);
  }
  s = (
    await call('/api/opportunities', {
      resultKey: s.run.results[0].key,
      baseRevision: s.revision,
    })
  ).data;
  const o = s.opportunities[0];
  const body = async (extra = {}) => {
    const now = await state();
    return {
      baseRevision: now.revision,
      revision: now.applications.find((a) => a.opportunityId === o.id)?.revision ?? 0,
      profileVersion: now.profile.version,
      questions,
      consent: true,
      requestId: randomUUID(),
      ...extra,
    };
  };
  const prepare = async (b) => call('/api/applications/' + o.id + '/prepare', b ?? (await body()));
  return {
    server,
    file,
    origin,
    state,
    call,
    body,
    prepare,
    o,
    calls: () => calls,
  };
}
test('G01 HTTP preparation produces CV cover and complete exact-question answers without durable effects', async (t) => {
  const h = await setup(t),
    before = await h.state(),
    result = await h.prepare();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.data.draft.cvText, /Led AI product evaluation and API platform launches\./);
  assert.match(result.data.draft.coverLetter, /Built B2B fintech onboarding\./);
  assert.ok(result.data.draft.answers.includes(questions[0]));
  assert.ok(result.data.draft.answers.includes(questions[1]));
  assert.match(result.data.draft.answers, /not (?:stated|supplied)|clarify|unknown/i);
  assert.doesNotMatch(result.data.draft.answers, /I am certified/);
  assert.equal(result.data.provenance.profileVersion, before.profile.version);
  assert.ok(result.data.provenance.opportunityHash);
  assert.ok(
    result.data.provenance.evidence.some(
      (e) => e.factId === 'f1' && e.quote === profile.facts[0].text,
    ),
  );
  assert.deepEqual(await h.state(), before);
  assert.equal(h.calls(), 1);
});
test('G02 no-consent foreign IDs malformed input and forged profile refuse before provider with unchanged state', async (t) => {
  const h = await setup(t),
    before = await h.state();
  for (const extra of [
    { consent: false },
    { profile: { facts: profile.facts } },
    { owner: 'foreign' },
    { profileVersion: 'old' },
    { questions: Array(11).fill('question') },
    { questions: ['x'.repeat(1001)] },
    { questions: ['same', 'same'] },
    { questions: [3] },
    { requestId: 'bad' },
  ]) {
    const result = await h.prepare(await h.body(extra));
    assert.ok([400, 403, 409].includes(result.status), JSON.stringify(result));
    assert.equal(h.calls(), 0);
    assert.deepEqual(await h.state(), before);
  }
  const result = await h.call('/api/applications/foreign/prepare', await h.body());
  assert.equal(result.status, 404);
  assert.equal(h.calls(), 0);
  assert.deepEqual(await h.state(), before);
});
test('G03 model invented text unknown/duplicate IDs or incomplete questions refuse preserving existing packet', async (t) => {
  const mutate = (fn) => {
    const p = proposal();
    fn(p);
    return p;
  };
  const bad = [
    mutate((p) => (p.cv.summary[0].citations[0].factId = 'invented')),
    { ...proposal(), cvText: 'I hold certificates' },
    mutate((p) => p.cv.summary[0].citations.push({ ...p.cv.summary[0].citations[0] })),
    { ...proposal(), answers: [] },
    mutate((p) => (p.answers[0].status = 'false')),
    mutate((p) => (p.answers[0].claims = [])),
  ];
  for (const response of bad) {
    await t.test('reject ' + JSON.stringify(response).slice(0, 70), async (st) => {
      const h = await setup(st, { prepare: async () => response });
      await h.call('/api/applications/' + h.o.id, {
        revision: 0,
        cvVersion: 'Saved',
        cvText: 'Original CV',
        coverLetter: 'Original letter',
        answers: 'Original answer',
        files: [],
      });
      const before = await h.state();
      const result = await h.prepare();
      assert.ok([400, 422, 502].includes(result.status));
      assert.deepEqual(await h.state(), before);
    });
  }
});
test('G04 repeated logical request no rerun and changed-input reuse refuses', async (t) => {
  const h = await setup(t),
    body = await h.body(),
    first = await h.prepare(body);
  assert.equal(first.status, 200);
  assert.deepEqual(await h.prepare(body), first);
  assert.equal(h.calls(), 1);
  assert.equal((await h.prepare({ ...body, questions: ['different'] })).status, 409);
  assert.equal(h.calls(), 1);
});
test('G05 profile change during pending work fences result and preserves saved material', async (t) => {
  let release, begun;
  const started = new Promise((r) => (begun = r));
  const h = await setup(t, {
    prepare: async () => {
      begun();
      if (!release) await new Promise((r) => (release = r));
      return proposal();
    },
  });
  const pending = h.prepare();
  await started;
  await h.call('/api/profile', {
    ...profile,
    facts: [...profile.facts, { id: 'f3', text: 'A new saved fact.' }],
  });
  const before = await h.state();
  release();
  assert.equal((await pending).status, 409);
  assert.deepEqual(await h.state(), before);
});
test('G06 packet edit during pending work fences result; guarded generated save refuses newer profile', async (t) => {
  let release, begun;
  const started = new Promise((r) => (begun = r));
  const h = await setup(t, {
    prepare: async () => {
      begun();
      if (!release) await new Promise((r) => (release = r));
      return proposal();
    },
  });
  const pending = h.prepare();
  await started;
  await h.call('/api/applications/' + h.o.id, {
    revision: 0,
    cvVersion: 'Manual',
    cvText: 'Preserved edit',
    coverLetter: '',
    answers: '',
    files: [],
  });
  const before = await h.state();
  release();
  assert.equal((await pending).status, 409);
  assert.deepEqual(await h.state(), before);
  const result = await h.prepare();
  assert.equal(result.status, 200);
  await h.call('/api/profile', {
    ...profile,
    goal: { ...profile.goal, roles: 'Director' },
  });
  const after = await h.state();
  const saved = await h.call('/api/applications/' + h.o.id, {
    ...result.data.draft,
    revision: 1,
    files: [],
    preparedProfileVersion: result.data.provenance.profileVersion,
    preparedOpportunityHash: result.data.provenance.opportunityHash,
  });
  assert.equal(saved.status, 409);
  assert.deepEqual(await h.state(), after);
});
test('G07 timeout ignoring abort preserves packet; no late output', async (t) => {
  const h = await setup(t, {
    timeout: 20,
    prepare: async () => {
      await delay(80);
      return proposal();
    },
  });
  const before = await h.state(),
    start = Date.now(),
    result = await h.prepare();
  assert.equal(result.status, 504);
  assert.ok(Date.now() - start < 1000);
  await delay(100);
  assert.deepEqual(await h.state(), before);
});
test('G08 explicit cancel and concurrent refusal never re-run canceled logical id', async (t) => {
  let release, begun;
  const started = new Promise((r) => (begun = r));
  const h = await setup(t, {
    prepare: async () => {
      begun();
      if (!release) await new Promise((r) => (release = r));
      return proposal();
    },
  });
  const body = await h.body(),
    pending = h.prepare(body);
  await started;
  assert.equal((await h.prepare(await h.body())).status, 409);
  const cancel = await h.call('/api/applications/' + h.o.id + '/prepare/cancel', {
    requestId: body.requestId,
  });
  assert.equal(cancel.status, 200);
  release();
  assert.ok([409, 410].includes((await pending).status));
  const before = await h.state();
  assert.ok([409, 410].includes((await h.prepare(body)).status));
  assert.equal(h.calls(), 1);
  assert.deepEqual(await h.state(), before);
});
test('G09 workspace deletion during ignored-abort provider work cannot recreate packet or notifications', async (t) => {
  let release, begun;
  const started = new Promise((r) => (begun = r));
  const h = await setup(t, {
    prepare: async () => {
      begun();
      if (!release) await new Promise((r) => (release = r));
      return proposal();
    },
  });
  const pending = h.prepare();
  await started;
  assert.equal((await h.call('/api/data', undefined, 'DELETE')).status, 200);
  const after = await h.state();
  release();
  assert.ok([409, 410].includes((await pending).status));
  assert.deepEqual(await h.state(), after);
  assert.equal(after.applications.length, 0);
  assert.equal(after.notifications.length, 0);
});
test('G10 Nebius preparation needs no Tavily and transmits only bounded canonical payload to mocked inference', async () => {
  let calls = 0,
    payload;
  const p = getProviders({
    env: {
      ALLOW_LIVE: '1',
      NEBIUS_API_KEY: 'synthetic-nebius',
      NEBIUS_MODEL: 'nvidia/synthetic-model',
    },
    transport: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
      payload = JSON.parse(options.body);
      return {
        text: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  calls === 1 ? asWire(proposal()) : acceptedReview(proposal()),
                ),
              },
            },
          ],
        }),
      };
    },
  });
  assert.equal(typeof p.prepareApplication, 'function');
  const response = await p.prepareApplication(
    { title: 'Synthetic role', text: 'Public synthetic source' },
    profile,
    questions,
    { signal: new AbortController().signal },
  );
  assert.deepEqual(response, proposal());
  assert.equal(calls, 2);
  assert.match(payload.messages[0].content, /untrusted|never instructions/i);
});

test('G11 disconnecting a same-ID waiter must not cancel original request', async (t) => {
  let release, begun;
  const started = new Promise((r) => (begun = r));
  const h = await setup(t, {
    prepare: async () => {
      begun();
      await new Promise((r) => (release = r));
      return proposal();
    },
  });
  const body = await h.body(),
    original = h.prepare(body);
  await started;
  let seen;
  const received = new Promise((r) => (seen = r));
  h.server.once('request', () => seen());
  const abort = new AbortController();
  const waiter = fetch(h.origin + '/api/applications/' + h.o.id + '/prepare', {
    method: 'POST',
    headers: { Origin: h.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abort.signal,
  });
  await received;
  await delay(25);
  abort.abort();
  await assert.rejects(waiter);
  await delay(25);
  release();
  assert.equal((await original).status, 200);
  assert.equal(h.calls(), 1);
});
test('G12 twenty logical IDs bounded admission, old same-ID replay not rerun', async (t) => {
  const h = await setup(t),
    firstBody = await h.body();
  assert.equal((await h.prepare(firstBody)).status, 200);
  for (let i = 1; i < 20; i++) assert.equal((await h.prepare()).status, 200);
  const before = await h.state();
  assert.equal((await h.prepare()).status, 429);
  assert.equal(h.calls(), 20);
  assert.equal((await h.prepare(firstBody)).status, 200);
  assert.equal(h.calls(), 20);
  assert.deepEqual(await h.state(), before);
});
test('G13 prepared save guard fields must be paired and source hash current', async (t) => {
  const h = await setup(t),
    s = await h.state(),
    before = await h.state(),
    packet = {
      revision: 0,
      cvVersion: 'draft',
      cvText: 'Preserved',
      coverLetter: '',
      answers: '',
      files: [],
    };
  for (const fields of [
    { preparedProfileVersion: s.profile.version },
    { preparedOpportunityHash: 'bad' },
    {
      preparedProfileVersion: s.profile.version,
      preparedOpportunityHash: 'bad',
    },
  ]) {
    const r = await h.call('/api/applications/' + h.o.id, {
      ...packet,
      ...fields,
    });
    assert.ok([400, 409].includes(r.status));
    assert.deepEqual(await h.state(), before);
  }
});
test('G14 no employer questions never fabricates screening questions', async (t) => {
  const h = await setup(t, {
    prepare: async () => ({ ...proposal(), answers: [] }),
  });
  const result = await h.prepare(await h.body({ questions: [] }));
  assert.equal(result.status, 200);
  assert.equal(result.data.draft.answers, '');
});
test('G15 duplicate/wrong question indexes or extra prose refuse model output', async (t) => {
  const change = [
    (p) => (p.answers[1].questionIndex = 0),
    (p) => (p.answers[0].questionIndex = 2),
    (p) => (p.answers[0].extra = 'Invented'),
  ];
  for (const fn of change)
    await t.test('reject malformed question coverage', async (st) => {
      const p = proposal();
      fn(p);
      const h = await setup(st, { prepare: async () => p });
      const before = await h.state();
      assert.equal((await h.prepare()).status, 502);
      assert.deepEqual(await h.state(), before);
    });
});
test('G16 active same-ID retries share result while wrong-opportunity cancel refuses', async (t) => {
  let release, begun;
  const started = new Promise((r) => (begun = r));
  const h = await setup(t, {
    prepare: async () => {
      begun();
      await new Promise((r) => (release = r));
      return proposal();
    },
  });
  const body = await h.body(),
    first = h.prepare(body);
  await started;
  const second = h.prepare(body);
  const cancel = await h.call('/api/applications/foreign/prepare/cancel', {
    requestId: body.requestId,
  });
  assert.equal(cancel.status, 404);
  release();
  const answers = await Promise.all([first, second]);
  assert.equal(answers[0].status, 200);
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(h.calls(), 1);
});
test('G17 completed payload eviction retains tombstone and never repeats provider', async (t) => {
  const facts = Array.from({ length: 20 }, (_, i) => ({
    id: 'b' + i,
    text: '文'.repeat(650) + ' ' + i + '.',
  }));
  const c = (text, ...indices) => ({
    text,
    citations: indices.map((i) => ({
      factId: facts[i].id,
      quote: facts[i].text,
    })),
  });
  const p = {
    version: 2,
    cv: {
      summary: [c(facts[0].text, 0)],
      skills: [],
      experience: [0, 6, 12].map((offset) => ({
        heading: c('Saved experience', offset),
        bullets: facts.slice(offset, offset + 6).map((f, i) => c(f.text, offset + i)),
      })),
    },
    coverLetter: [10, 12, 14, 16, 18].map((i) =>
      c('Relevant experience: ' + facts[i].text + ' ' + facts[i + 1].text, i, i + 1),
    ),
    answers: [
      {
        questionIndex: 0,
        status: 'answered',
        claims: facts.slice(0, 4).map((f, i) => c(f.text, i)),
      },
      {
        questionIndex: 1,
        status: 'answered',
        claims: facts.slice(4, 8).map((f, i) => c(f.text, i + 4)),
      },
    ],
  };
  const h = await setup(t, { prepare: async () => p });
  assert.equal((await h.call('/api/profile', { ...profile, facts })).status, 200);
  const firstBody = await h.body();
  assert.equal((await h.prepare(firstBody)).status, 200);
  for (let i = 1; i < 20; i++) assert.equal((await h.prepare()).status, 200);
  const count = h.calls();
  assert.equal((await h.prepare(firstBody)).status, 410);
  assert.equal(h.calls(), count);
});

test('G18 actual private coordinator accepts active generation-zero and fences durable auth deletion', async (t) => {
  const seed = await setup(t);
  const canonical = JSON.parse(await readFile(seed.file, 'utf8'));
  canonical.revision = 1;
  const { openPrivateStorage } = await import('../app/private-storage.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'prepare-private-'));
  const store = await openPrivateStorage({ directory, bootstrap: true });
  const accountId = '11111111-1111-4111-8111-111111111111',
    user = {
      id: accountId,
      email: 'generated-fixture@example.test',
      name: 'Synthetic',
      verified: true,
      mailboxTag: 'abcdef123456',
      passwordSalt: 'a'.repeat(64),
      passwordHash: 'b'.repeat(128),
      createdAt: 1720000000000,
    };
  const auth = {
    version: 1,
    commitRevision: 1,
    users: [user],
    sessions: [],
    tokens: [],
    quotas: [],
  };
  await store.commit({
    transactionId: randomUUID(),
    expectedRevisions: { auth: null },
    targets: [{ storeId: 'auth', value: auth, revision: 1 }],
  });
  await store.commit({
    transactionId: randomUUID(),
    accountId,
    generation: 0,
    expectedRevisions: { ['workspace:' + accountId]: null },
    targets: [{ storeId: 'workspace:' + accountId, value: canonical, revision: 1 }],
  });
  let block = false,
    release,
    begun;
  const started = new Promise((r) => (begun = r));
  const server = createServer({
    storage: store,
    accountId,
    accountGeneration: 0,
    env: { CONTROLLED_LOCAL_MODE: '1' },
    providers: providers({
      prepareApplication: async () => {
        if (block) {
          begun();
          await new Promise((r) => (release = r));
        }
        return proposal();
      },
    }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = async () => {
    const response = await fetch(
      origin + '/api/applications/' + canonical.opportunities[0].id + '/prepare',
      {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseRevision: store.readSync('workspace:' + accountId).revision,
          revision: store.readSync('workspace:' + accountId).applications[0]?.revision ?? 0,
          profileVersion: canonical.profile.version,
          questions,
          consent: true,
          requestId: randomUUID(),
        }),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  assert.equal(store.readSync('lifecycle'), null);
  assert.equal((await call()).status, 200, 'normal active account needs no lifecycle row');
  const packetUrl = origin + '/api/applications/' + canonical.opportunities[0].id;
  for (let revision = 0; revision < 2; revision++) {
    const response = await fetch(packetUrl, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision,
        cvVersion: 'Version ' + revision,
        cvText: 'Confirmed profile text ' + revision,
        coverLetter: '',
        answers: '',
        files: [],
      }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  const durablePacket = store.readSync('workspace:' + accountId).applications[0];
  assert.equal(durablePacket.revision, 2);
  assert.equal(durablePacket.history.length, 1);
  assert.equal(durablePacket.history[0].cvText, 'Confirmed profile text 0');
  assert.equal(Object.hasOwn(durablePacket.history[0], 'history'), false);
  // Pending preparation uses the current packet and workspace revisions after both saves.
  canonical.revision = store.readSync('workspace:' + accountId).revision;
  block = true;
  const pending = call();
  await started;
  const tombstone = {
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
  await store.commit({
    transactionId: randomUUID(),
    expectedRevisions: { auth: 1, lifecycle: null },
    targets: [
      {
        storeId: 'auth',
        value: { ...auth, commitRevision: 2, users: [] },
        revision: 2,
      },
      { storeId: 'lifecycle', value: tombstone, revision: 1 },
    ],
  });
  const before = store.readSync('workspace:' + accountId);
  release();
  assert.equal((await pending).status, 409);
  assert.deepEqual(store.readSync('workspace:' + accountId), before);
  assert.deepEqual(store.readSync('auth').users, []);
  assert.equal(store.readSync('lifecycle').records[accountId].active, false);
});

test('G19 repaired preparation caches only accepted final result while preserving saved packet and model replay budget', async (t) => {
  const bad = proposal();
  bad.cv.summary[0].text = 'I delivered a 99% improvement.';
  const negative = acceptedReview(bad);
  negative.reviews[0].supported = false;
  negative.reviews[0].reason = '99% is unsupported by canonical facts.';
  let modelCalls = 0;
  const actual = getProviders({
    env: {
      ALLOW_LIVE: '1',
      NEBIUS_API_KEY: 'synthetic-only',
      NEBIUS_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
    },
    transport: async () => {
      modelCalls++;
      const response =
        modelCalls === 1
          ? asWire(bad)
          : modelCalls === 2
            ? negative
            : modelCalls === 3
              ? asWire(proposal())
              : acceptedReview(proposal());
      return {
        text: JSON.stringify({
          choices: [{ message: { content: JSON.stringify(response) } }],
        }),
      };
    },
  });
  const h = await setup(t, {
    prepare: (...args) => actual.prepareApplication(...args),
  });
  await h.call('/api/applications/' + h.o.id, {
    revision: 0,
    cvVersion: 'Existing packet',
    cvText: 'Preserved original CV',
    coverLetter: 'Original letter',
    answers: 'Original answers',
    files: [],
  });
  const before = await h.state(),
    body = await h.body(),
    first = await h.prepare(body);
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(modelCalls, 4);
  assert.deepEqual(await h.state(), before);
  assert.deepEqual(await h.prepare(body), first);
  assert.equal(modelCalls, 4);
  assert.equal(h.calls(), 1);
  assert.equal(before.mailDispatches.length, 0);
});

// LOCK-RM-JA-ADAPT-004: no modelwire repair may relax grounding or mutate saved data.
function scriptedPreparation(responses, events = [], hooks = {}) {
  const sent = [];
  const provider = getProviders({
    env: {
      ALLOW_LIVE: '1',
      NEBIUS_API_KEY: 'synthetic-ja-only',
      NEBIUS_MODEL: 'nvidia/synthetic-model',
    },
    transport: async (_url, options) => {
      const payload = JSON.parse(options.body);
      sent.push(payload);
      const value = responses[sent.length - 1];
      if (value === undefined) throw Error('Forbidden extra inference call');
      await hooks.onCall?.(sent.length);
      return {
        text: JSON.stringify(
          hooks.envelope?.(sent.length, value) ?? {
            choices: [
              {
                message: {
                  content: typeof value === 'string' ? value : JSON.stringify(value),
                },
              },
            ],
          },
        ),
      };
    },
  });
  return {
    provider,
    sent,
    options: {
      onAudit: async (e) => {
        events.push(e);
        await hooks.onAudit?.(e);
      },
    },
  };
}
const syntheticJob = {
  title: 'Synthetic Product Manager',
  company: 'Northstar',
  text: 'Own product evaluation and onboarding.',
  requirements: [],
};

test('G20 exact duplicate known refs normalize after full validation without changing text or source', () => {
  const wire = asWire(proposal());
  wire.coverLetter[0].citations = [
    preparationEvidenceCatalog(profile)[1].ref,
    preparationEvidenceCatalog(profile)[1].ref,
  ];
  const untouched = structuredClone(wire);
  const notes = [];
  const p = resolvePreparationReferences(wire, profile, {
    onNormalization: (n) => notes.push(n),
  });
  assert.deepEqual(p, proposal());
  assert.deepEqual(wire, untouched);
  assert.deepEqual(notes, [{ duplicateReferencesRemoved: 1 }]);
  for (const refs of [
    [preparationEvidenceCatalog(profile)[1].ref, preparationEvidenceCatalog(profile)[1].ref, 'bad'],
    [preparationEvidenceCatalog(profile)[1].ref, 3],
    Array(5).fill(preparationEvidenceCatalog(profile)[1].ref),
  ]) {
    const bad = asWire(proposal());
    bad.coverLetter[0].citations = refs;
    assert.throws(() => resolvePreparationReferences(bad, profile), {
      code: 'PREPARATION_REFERENCE_INVALID',
    });
  }
  const bad = structuredClone(wire);
  bad.answers[0].questionIndex = -1;
  const rejected = [];
  assert.throws(() =>
    resolvePreparationReferences(bad, profile, {
      onNormalization: (n) => rejected.push(n),
    }),
  );
  assert.deepEqual(rejected, []);
});
test('G21 duplicate references plus wrong numeric fact reach one repair, not silent metric reassignment', async () => {
  const bad = asWire(proposal());
  bad.coverLetter[0].citations = [
    preparationEvidenceCatalog(profile)[1].ref,
    preparationEvidenceCatalog(profile)[1].ref,
  ];
  bad.cv.summary[0].text = 'I delivered 63% automation.';
  const events = [],
    h = scriptedPreparation(
      [bad, acceptedReview(proposal()), asWire(proposal()), acceptedReview(proposal())],
      events,
    );
  const result = await h.provider.prepareApplication(syntheticJob, profile, questions, h.options);
  assert.deepEqual(result, proposal());
  assert.equal(h.sent.length, 4);
  const repair = JSON.parse(h.sent[2].messages[1].content);
  assert.ok(JSON.stringify(repair).includes('63%'));
  assert.ok(events.some((e) => e.stage === 'deterministic-check' && e.status === 'rejected'));
  assert.ok(
    events.some(
      (e) =>
        e.snapshot?.data?.verification?.referenceNormalization?.duplicateReferencesRemoved === 1,
    ),
  );
});
test('G22 unknown ref goes directly to exactly one repair and fresh review; HTTP output leaves prior packet intact', async (t) => {
  const bad = asWire(proposal());
  bad.cv.summary[0].citations = ['e999'];
  const events = [],
    model = scriptedPreparation([bad, asWire(proposal()), acceptedReview(proposal())], events);
  const h = await setup(t, {
    prepare: (j, p, q, o) =>
      model.provider.prepareApplication(j, p, q, {
        ...o,
        onAudit: async (e) => events.push(e),
      }),
  });
  await h.call('/api/applications/' + h.o.id, {
    revision: 0,
    cvVersion: 'Prior JA packet',
    cvText: 'Existing CV',
    coverLetter: 'Existing cover',
    answers: 'Existing answers',
    files: [],
  });
  const before = await h.state(),
    body = await h.body(),
    result = await h.prepare(body);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(model.sent.length, 3);
  assert.deepEqual(await h.state(), before);
  assert.deepEqual(await h.prepare(body), result);
  assert.equal(model.sent.length, 3);
  assert.ok(events.some((e) => e.stage === 'deterministic-check' && e.status === 'rejected'));
  assert.match(model.sent[1].messages[0].content, /single permitted whole-document repair/);
});
test('G23 second bad reference, wrong metric or negative fresh review refuses with no second repair or saved effects', async (t) => {
  for (const kind of ['bad-ref', 'wrong-metric', 'negative-review']) {
    const bad = asWire(proposal());
    bad.coverLetter[0].citations = ['unknown'];
    const repaired = asWire(proposal());
    if (kind === 'bad-ref') repaired.cv.summary[0].citations = ['unknown'];
    if (kind === 'wrong-metric') repaired.cv.summary[0].text = 'I delivered 99% automation.';
    const negative = acceptedReview(proposal());
    negative.reviews[0].supported = false;
    negative.reviews[0].reason = 'Unsupported metric ownership.';
    const model = scriptedPreparation([
      bad,
      repaired,
      ...(kind === 'negative-review' ? [negative] : []),
    ]);
    const h = await setup(t, {
      prepare: (...args) => model.provider.prepareApplication(...args),
    });
    const before = await h.state();
    const result = await h.prepare();
    assert.equal(result.status, 502, kind + JSON.stringify(result));
    assert.equal(
      model.sent.length,
      kind === 'negative-review' ? 3 : 2,
      kind + JSON.stringify(result),
    );
    assert.deepEqual(await h.state(), before);
  }
});
test('G24 canonical profile errors, invalid JSON and transport errors are not reference errors or repair invitations', async () => {
  const wire = asWire(proposal());
  assert.throws(
    () => resolvePreparationReferences(wire, { facts: [] }),
    (e) => e.code !== 'PREPARATION_REFERENCE_INVALID',
  );
  for (const value of ['not JSON']) {
    const h = scriptedPreparation([value]);
    await assert.rejects(
      h.provider.prepareApplication(syntheticJob, profile, questions, h.options),
    );
    assert.equal(h.sent.length, 1);
  }
  const events = [],
    h = scriptedPreparation([wire], events, {
      onAudit: async (e) => {
        if (e.stage === 'deterministic-check' && e.status === 'start')
          throw Error('audit unavailable');
      },
    });
  await assert.rejects(
    h.provider.prepareApplication(syntheticJob, profile, questions, h.options),
    /audit unavailable/,
  );
  assert.equal(h.sent.length, 1);
});
test('G25 cancel at malformed-wire rejection prevents repair and never admits late output', async () => {
  const controller = new AbortController(),
    bad = asWire(proposal());
  bad.cv.summary[0].citations = ['unknown'];
  const events = [],
    h = scriptedPreparation([bad, asWire(proposal())], events, {
      onAudit: async (e) => {
        if (e.stage === 'deterministic-check' && e.status === 'rejected')
          controller.abort(Error('synthetic cancelled'));
      },
    });
  await assert.rejects(
    h.provider.prepareApplication(syntheticJob, profile, questions, {
      ...h.options,
      signal: controller.signal,
    }),
    /synthetic cancelled/,
  );
  assert.equal(h.sent.length, 1);
});
test('G26 malformed wire repair is strictly validated even when duplicate normalization is possible', async () => {
  const malformed = asWire(proposal());
  delete malformed.cv.skills;
  const repaired = asWire(proposal());
  repaired.coverLetter[0].citations = [
    preparationEvidenceCatalog(profile)[1].ref,
    preparationEvidenceCatalog(profile)[1].ref,
  ];
  repaired.cv.summary[0].text = 'I delivered 63% automation.';
  const h = scriptedPreparation([malformed, repaired, acceptedReview(proposal())]);
  await assert.rejects(h.provider.prepareApplication(syntheticJob, profile, questions, h.options));
  assert.equal(h.sent.length, 2);
});
test('G27 duplicate-only valid wire passes the real HTTP/audit boundary with two calls and unchanged saved state', async (t) => {
  const wire = asWire(proposal());
  wire.coverLetter[0].citations = [
    preparationEvidenceCatalog(profile)[1].ref,
    preparationEvidenceCatalog(profile)[1].ref,
  ];
  const model = scriptedPreparation([wire, acceptedReview(proposal())]);
  const h = await setup(t, {
    prepare: (...args) => model.provider.prepareApplication(...args),
  });
  const before = await h.state();
  const result = await h.prepare();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(model.sent.length, 2);
  assert.deepEqual(await h.state(), before);
});
test('G28 transport failures never trigger a reference repair', async () => {
  const model = scriptedPreparation([asWire(proposal())], [], {
    onCall: async () => {
      throw Error('synthetic transport failed');
    },
  });
  await assert.rejects(
    model.provider.prepareApplication(syntheticJob, profile, questions, model.options),
    /synthetic transport failed/,
  );
  assert.equal(model.sent.length, 1);
});
test('G29 target brand numbers survive both actual provider gates while unrelated numeric claims remain rejected', async () => {
  const expected = proposal();
  expected.coverLetter[0].text =
    'I bring this experience to Trading 212. ' + expected.coverLetter[0].text;
  const wire = asWire(expected),
    model = scriptedPreparation([wire, acceptedReview(expected)]);
  const result = await model.provider.prepareApplication(
    { ...syntheticJob, company: 'Trading 212' },
    profile,
    questions,
    model.options,
  );
  assert.deepEqual(result, expected);
  assert.equal(model.sent.length, 2);
});

// RM-JA-REF-DIAG-005: source identity and safe response diagnostics.
test('G30 synthesis sees a single opaque evidence catalog and reviewer retains full profile', async () => {
  const model = scriptedPreparation([asWire(proposal()), acceptedReview(proposal())]);
  assert.deepEqual(
    await model.provider.prepareApplication(syntheticJob, profile, questions, model.options),
    proposal(),
  );
  const generation = JSON.parse(model.sent[0].messages[1].content);
  assert.equal(generation.profile, undefined);
  assert.deepEqual(generation.evidenceCatalog, preparationEvidenceCatalog(profile));
  assert.ok(generation.evidenceCatalog.every((x) => /^src_[a-f0-9]{64}$/.test(x.ref)));
  const review = JSON.parse(model.sent[1].messages[1].content);
  assert.deepEqual(review.profile.facts, profile.facts);
  assert.equal(model.sent.length, 2);
});

test('G31 reference identity survives reorder but changes on id or exact quote edit; ordinal aliases reject', () => {
  const catalog = preparationEvidenceCatalog(profile);
  assert.ok(catalog.every((x) => /^src_[a-f0-9]{64}$/.test(x.ref)));
  assert.deepEqual(
    preparationEvidenceCatalog({
      ...profile,
      facts: [...profile.facts].reverse(),
    })
      .map((x) => x.ref)
      .sort(),
    catalog.map((x) => x.ref).sort(),
  );
  for (const field of ['id', 'text']) {
    const changed = structuredClone(profile);
    changed.facts[0][field] += field === 'id' ? 'changed' : ' Changed source.';
    assert.notEqual(preparationEvidenceCatalog(changed)[0].ref, catalog[0].ref);
  }
  const wire = asWire(proposal());
  wire.cv.summary[0].citations = ['e0'];
  assert.throws(
    () => resolvePreparationReferences(wire, profile),
    (e) => e.code === 'PREPARATION_REFERENCE_INVALID',
  );
});

const reviewEnvelope = (content, finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content } }],
  usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
  headers: { authorization: 'synthetic-secret-must-not-leak' },
});
const failedDiagnostics = (events) =>
  events.find((e) => e.stage === 'semantic-review' && e.status === 'failed');
test('G32 malformed reviewer contents refuse without repair and retain bounded safe metadata plus usage', async (t) => {
  for (const [name, content, type, failure] of [
    ['malformed', 'private-synthetic-candidate-claim {', 'string', 'invalid_json'],
    ['empty', '', 'string', 'empty_content'],
    ['missing', undefined, 'missing', 'missing_content'],
    ['null', null, 'null', 'non_text_content'],
    ['object', { private: 'synthetic-secret-must-not-leak' }, 'object', 'non_text_content'],
    ['array', [{ text: 'synthetic-secret-must-not-leak' }], 'array', 'non_text_content'],
  ])
    await t.test(name, async () => {
      const events = [],
        model = scriptedPreparation([asWire(proposal()), 'unused'], events, {
          envelope: (n) => (n === 2 ? reviewEnvelope(content) : undefined),
        });
      await assert.rejects(
        model.provider.prepareApplication(syntheticJob, profile, questions, model.options),
      );
      assert.equal(model.sent.length, 2);
      const failed = failedDiagnostics(events);
      assert.ok(failed);
      assert.equal(failed.usage.totalTokens, 42);
      const diag = failed.snapshot.data.verification.responseDiagnostics;
      assert.equal(diag.contentType, type);
      assert.equal(diag.failure, failure);
      assert.equal(diag.finishReason, 'stop');
      if (typeof content === 'string') {
        assert.equal(diag.contentBytes, Buffer.byteLength(content));
        assert.match(diag.contentHash, /^[a-f0-9]{64}$/);
      } else {
        assert.equal(diag.contentBytes, null);
        assert.equal(diag.contentHash, null);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(diag)) <= 1024);
      assert.doesNotMatch(
        JSON.stringify(failed),
        /private-synthetic-candidate|synthetic-secret|authorization|\[object Object\]/,
      );
    });
});

test('G33 incomplete reviewer responses fail closed even with valid JSON; malicious finish reason is never stored', async (t) => {
  for (const [reason, shown, failure] of [
    ['length', 'length', 'truncated'],
    ['content_filter', 'content_filter', 'content_filtered'],
    ['tool_calls', 'tool_calls', 'unexpected_finish_reason'],
    ['function_call', 'function_call', 'unexpected_finish_reason'],
    ['synthetic-secret-finish', 'unknown', 'unexpected_finish_reason'],
  ])
    await t.test(reason, async () => {
      const events = [],
        model = scriptedPreparation([asWire(proposal()), acceptedReview(proposal())], events, {
          envelope: (n, v) => (n === 2 ? reviewEnvelope(JSON.stringify(v), reason) : undefined),
        });
      await assert.rejects(
        model.provider.prepareApplication(syntheticJob, profile, questions, model.options),
      );
      assert.equal(model.sent.length, 2);
      const e = failedDiagnostics(events),
        d = e.snapshot.data.verification.responseDiagnostics;
      assert.equal(d.finishReason, shown);
      assert.equal(d.failure, failure);
      assert.equal(e.usage.totalTokens, 42);
      assert.doesNotMatch(JSON.stringify(e), /synthetic-secret/);
    });
});

test('G34 invalid reviewer metadata usage cannot enter audit; parseable bad shape is not acceptance', async () => {
  const events = [],
    model = scriptedPreparation([asWire(proposal()), {}], events, {
      envelope: (n, v) =>
        n === 2
          ? {
              ...reviewEnvelope(JSON.stringify(v)),
              usage: {
                prompt_tokens: -1,
                completion_tokens: 2.5,
                total_tokens: Number.MAX_SAFE_INTEGER + 1,
              },
            }
          : undefined,
    });
  await assert.rejects(
    model.provider.prepareApplication(syntheticJob, profile, questions, model.options),
  );
  assert.equal(model.sent.length, 2);
  const e = events.find((x) => x.stage === 'semantic-review' && x.status !== 'start');
  assert.deepEqual(e.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cost: null,
  });
  assert.equal(e.snapshot.data.verification.responseDiagnostics.parseStatus, 'parsed');
});

test('G35 durable HTTP failed-review diagnostics preserve prior packet and replay never calls model again', async (t) => {
  const seed = await setup(t);
  await seed.call('/api/applications/' + seed.o.id, {
    revision: 0,
    cvVersion: 'Prior',
    cvText: 'Existing CV',
    coverLetter: 'Existing letter',
    answers: 'Existing answers',
    files: [],
  });
  const canonical = JSON.parse(await readFile(seed.file, 'utf8'));
  canonical.revision = 1;
  const { openPrivateStorage } = await import('../app/private-storage.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'diag-private-')),
    store = await openPrivateStorage({ directory, bootstrap: true });
  const accountId = '11111111-1111-4111-8111-111111111111';
  await store.commit({
    transactionId: randomUUID(),
    expectedRevisions: { auth: null },
    targets: [
      {
        storeId: 'auth',
        revision: 1,
        value: {
          version: 1,
          commitRevision: 1,
          users: [
            {
              id: accountId,
              email: 'synthetic@example.test',
              name: 'Synthetic',
              verified: true,
              mailboxTag: 'abcdef123456',
              passwordSalt: 'a'.repeat(64),
              passwordHash: 'b'.repeat(128),
              createdAt: 1720000000000,
            },
          ],
          sessions: [],
          tokens: [],
          quotas: [],
        },
      },
    ],
  });
  await store.commit({
    transactionId: randomUUID(),
    accountId,
    generation: 0,
    expectedRevisions: { ['workspace:' + accountId]: null },
    targets: [{ storeId: 'workspace:' + accountId, value: canonical, revision: 1 }],
  });
  const model = scriptedPreparation([asWire(proposal()), 'bad'], [], {
    envelope: (n) => (n === 2 ? reviewEnvelope('synthetic-secret-content {', 'length') : undefined),
  });
  const server = createServer({
    storage: store,
    accountId,
    accountGeneration: 0,
    env: { CONTROLLED_LOCAL_MODE: '1' },
    providers: providers({
      prepareApplication: (...args) => model.provider.prepareApplication(...args),
    }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const before = store.readSync('workspace:' + accountId),
    body = {
      baseRevision: before.revision,
      revision: before.applications[0].revision,
      profileVersion: before.profile.version,
      questions,
      consent: true,
      requestId: randomUUID(),
    };
  const call = async () => {
    const r = await fetch(origin + '/api/applications/' + seed.o.id + '/prepare', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const result = await call();
  assert.equal(result.status, 502, JSON.stringify(result));
  assert.deepEqual(store.readSync('workspace:' + accountId), before);
  assert.equal(model.sent.length, 2);
  assert.deepEqual(await call(), result);
  assert.equal(model.sent.length, 2);
  const audit = store.readSync('audit:' + accountId);
  const failed = audit.events.find(
    (e) => e.action === 'preparation:semantic-review' && e.status === 'failed',
  );
  assert.ok(failed);
  assert.equal(failed.usage.totalTokens, 42);
  const snapshot = failed.snapshotRefs
    .map((ref) => audit.snapshots[ref])
    .find((s) => s.data.verification?.responseDiagnostics);
  assert.equal(snapshot.data.verification.responseDiagnostics.failure, 'truncated');
  assert.doesNotMatch(
    JSON.stringify(audit),
    /synthetic-secret-content|synthetic-secret-must-not-leak/,
  );
});

test('G36 segmented source refs are quote-specific, stable under reorder, and not profile-number aliases', () => {
  const a = 'First confirmed sentence ' + 'a'.repeat(850) + '.',
    b = 'Second confirmed sentence ' + 'b'.repeat(850) + '.';
  const source = {
    facts: [
      { id: 'f2', text: a + ' ' + b },
      { id: 'f99', text: 'Other confirmed fact.' },
    ],
  };
  const catalog = preparationEvidenceCatalog(source);
  assert.equal(catalog.length, 3);
  assert.equal(new Set(catalog.map((x) => x.ref)).size, 3);
  assert.deepEqual(
    catalog.slice(0, 2).map((x) => x.quote),
    [a, b],
  );
  assert.deepEqual(
    preparationEvidenceCatalog({ facts: [...source.facts].reverse() })
      .map((x) => x.ref)
      .sort(),
    catalog.map((x) => x.ref).sort(),
  );
});

test('G37 legacy reference repair still uses one catalog and exact valid refs with mandatory fresh review', async () => {
  const bad = asWire(proposal());
  bad.cv.summary[0].citations = ['e0'];
  const events = [],
    model = scriptedPreparation([bad, asWire(proposal()), acceptedReview(proposal())], events);
  assert.deepEqual(
    await model.provider.prepareApplication(syntheticJob, profile, questions, model.options),
    proposal(),
  );
  const repair = JSON.parse(model.sent[1].messages[1].content);
  assert.equal(repair.profile, undefined);
  assert.deepEqual(repair.evidenceCatalog, preparationEvidenceCatalog(profile));
  assert.equal(repair.rejectedWire.cv.summary[0].citations[0], 'e0');
  assert.ok(events.some((x) => x.stage === 'fresh-review' && x.status === 'observed'));
  assert.equal(model.sent.length, 3);
});

test('G38 missing choice envelope fails with safe missing-content diagnostics; zero usage stays zero', async () => {
  const events = [],
    model = scriptedPreparation([asWire(proposal()), 'unused'], events, {
      envelope: (n) =>
        n === 2
          ? {
              choices: [],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
              },
            }
          : undefined,
    });
  await assert.rejects(
    model.provider.prepareApplication(syntheticJob, profile, questions, model.options),
  );
  const e = failedDiagnostics(events),
    d = e.snapshot.data.verification.responseDiagnostics;
  assert.equal(model.sent.length, 2);
  assert.equal(d.failure, 'missing_content');
  assert.equal(d.finishReason, 'unknown');
  assert.deepEqual(e.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: null,
  });
});

test('G39 diagnostic persistence failure and abort cannot schedule repair or return unverified output', async () => {
  for (const action of ['audit-failure', 'abort']) {
    const events = [],
      controller = new AbortController();
    const model = scriptedPreparation([asWire(proposal()), 'bad'], events, {
      envelope: (n) => (n === 2 ? reviewEnvelope('invalid {') : undefined),
      onAudit: async (e) => {
        if (e.stage === 'semantic-review' && e.status === 'failed') {
          if (action === 'audit-failure') throw Error('Synthetic audit unavailable');
          controller.abort(Error('Synthetic cancellation'));
        }
      },
    });
    await assert.rejects(
      model.provider.prepareApplication(syntheticJob, profile, questions, {
        ...model.options,
        signal: controller.signal,
      }),
    );
    assert.equal(model.sent.length, 2);
  }
});
