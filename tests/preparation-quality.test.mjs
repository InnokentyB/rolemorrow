// Fully fictional public-release fixture; no personal career record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../app/server.mjs';
import { openPrivateStorage } from '../app/private-storage.mjs';
import { companies, providers } from './fixtures.mjs';
import { getProviders } from '../app/providers.mjs';
import { preparationEvidencePlan } from '../app/preparation-evidence.mjs';
import {
  preparationEvidenceCatalog,
  preparationClaimInventory,
  validatePreparationProposal,
  inspectPreparationProposal,
} from '../app/application-preparation.mjs';
const facts = [
  {
    id: 'f1',
    text: 'Northstar, Service Product Manager, June 2023–Present. Own AI product evaluation and data monitoring.',
  },
  {
    id: 'f2',
    text: 'Harbor, Platform Manager, March 2021–April 2023. Built a data platform and reduced integration time-to-market by 37%.',
  },
  {
    id: 'f3',
    text: 'At Harbor, built a warehouse chatbot for support requests. Built an AI assistant for Service Reliability analysts that assessed incident reports;63% of incident reports were handled fully automatically.',
  },
  {
    id: 'f4',
    text: 'At Harbor, built mobile workspace setup for the Canada launch and achieved 3× conversion. 72% of users were mobile users.',
  },
  {
    id: 'f5',
    text: 'At Harbor, worked with marketing across 2,400 companies and gained 417 new customers. Changed workspace setup for shared configuration reuse; causal uplift is unconfirmed.',
  },
];
const profile = {
  facts,
  version: 'synthetic-quality',
  goal: { roles: 'Product Manager', country: 'Canada', industries: 'AI', workMode: 'remote' },
};
const job = {
  title: 'Product Manager',
  company: 'Fictional Target',
  text: 'AI data platform monitoring mobile workspace setup integration.',
  requirements: [],
};
const claim = (text, id) => ({
  text,
  citations: [{ factId: id, quote: facts.find((f) => f.id === id).text }],
});
const good = () => ({
  version: 2,
  cv: {
    summary: [claim('Product leader with data platform and AI experience.', 'f2')],
    skills: [],
    experience: [
      {
        heading: claim('Northstar — Service Product Manager | June 2023–Present', 'f1'),
        bullets: [claim('Own AI product evaluation and data monitoring.', 'f1')],
      },
      {
        heading: claim('Harbor — Platform Manager | March 2021–April 2023', 'f2'),
        bullets: [
          claim('Built a data platform and reduced integration time-to-market by 37%.', 'f2'),
          claim(
            'Built an AI assistant for Service Reliability analysts that assessed incident reports;63% of incident reports were handled fully automatically.',
            'f3',
          ),
          claim('Built mobile workspace setup for the Canada launch and achieved 3× conversion.', 'f4'),
        ],
      },
    ],
  },
  coverLetter: [
    claim(
      'My product background includes the development of data platforms and integration work.',
      'f2',
    ),
    claim('I would bring AI evaluation and monitoring experience to this role.', 'f1'),
  ],
  answers: [],
});
const wire = (p) => {
  const w = structuredClone(p),
    catalog = preparationEvidenceCatalog(profile);
  for (const c of [
    ...w.cv.summary,
    ...w.cv.skills,
    ...w.cv.experience.flatMap((g) => [g.heading, ...g.bullets]),
    ...w.coverLetter,
    ...w.answers.flatMap((a) => a.claims),
  ])
    c.citations = c.citations.map(
      (s) => catalog.find((e) => e.factId === s.factId && e.quote === s.quote).ref,
    );
  return w;
};
const review = (p) => ({
  reviews: preparationClaimInventory(p).map((x) => ({
    claimId: x.claimId,
    supported: true,
    reason: 'Synthetic only.',
  })),
  coverage: { complete: true, reason: 'Synthetic only.' },
  answersComplete: true,
  distinctCover: true,
});
const env = { ALLOW_LIVE: '1', NEBIUS_API_KEY: 'synthetic-only', NEBIUS_MODEL: 'nvidia/synthetic' };
function model({
  initial = good(),
  repair = good(),
  firstNegative = false,
  waits = [],
  preparationTiming,
  onAudit,
} = {}) {
  const sent = [],
    events = [];
  const p = getProviders({
    env,
    preparationTiming,
    transport: async (_url, options) => {
      const body = JSON.parse(options.body),
        n = sent.push({ body, timeoutMs: options.timeoutMs });
      if (n > 4) throw Error('Forbidden extra model call');
      await delay(waits[n - 1] ?? 0); // Deliberately ignores abort to test late-result refusal.
      const value =
        n === 1
          ? wire(initial)
          : n === 2
            ? {
                ...review(initial),
                ...(firstNegative
                  ? { coverage: { complete: false, reason: 'Synthetic missing evidence.' } }
                  : {}),
              }
            : n === 3
              ? wire(repair)
              : review(repair);
      return {
        text: JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
        }),
      };
    },
  });
  return {
    provider: p,
    sent,
    events,
    run: (signal) =>
      p.prepareApplication(job, profile, [], {
        signal,
        onAudit: async (e) => {
          events.push(e);
          await onAudit?.(e);
        },
      }),
  };
}

test('Q01 same-fact project metric cannot be borrowed by chatbot, including metric-only citation and padding', () => {
  for (const mode of ['full', 'metric-only', 'both', 'generic', 'combined']) {
    const p = good(),
      c = p.cv.experience[1].bullets[1];
    c.text =
      mode === 'generic'
        ? 'Handled 63% of incident reports automatically.'
        : mode === 'combined'
          ? 'Built a chatbot and an AI assistant handling 63% of incident reports.'
          : 'Built a warehouse chatbot handling 63% of incident reports for Service Reliability analysts.';
    if (mode === 'metric-only') c.citations[0].quote = facts[2].text.split('. ')[1];
    if (mode === 'both')
      c.citations = [
        { factId: 'f3', quote: facts[2].text.split('. ')[0] + '.' },
        { factId: 'f3', quote: facts[2].text.split('. ')[1] },
      ];
    assert.throws(() => validatePreparationProposal(p, profile, [], job), undefined, mode);
  }
});
test('Q02 separate truthful sentences and actual same-project paraphrases stay valid', () => {
  const p = good();
  p.cv.experience[1].bullets[1].text =
    'Built a warehouse chatbot for support requests. Built an AI assistant for Service Reliability that handled 63% of incident reports automatically.';
  assert.doesNotThrow(() => validatePreparationProposal(p, profile, [], job));
});
test('Q03 unsupported causal bridge cannot borrow marketing result from another source sentence', () => {
  const p = good();
  p.cv.experience[1].bullets.push(claim('Gained 417 new customers via shared configuration reuse.', 'f5'));
  assert.throws(() => validatePreparationProposal(p, profile, [], job));
  const trueSource = structuredClone(profile);
  trueSource.facts[4].text = 'At Harbor, gained 417 new customers via shared configuration reuse.';
  p.cv.experience[1].bullets.at(-1).citations[0].quote = trueSource.facts[4].text;
  assert.doesNotThrow(() => validatePreparationProposal(p, trueSource, [], job));
});
test('Q04 current role requires truthful named dated heading and meaningful contribution, not citation padding', () => {
  for (const mode of ['missing', 'generic', 'wrong-date', 'no-contribution', 'reverse']) {
    const p = good();
    if (mode === 'missing') p.cv.experience.shift();
    if (mode === 'generic') p.cv.experience[0].heading.text = 'Additional Experience';
    if (mode === 'wrong-date')
      p.cv.experience[0].heading.text = 'Northstar — Service Product Manager';
    if (mode === 'no-contribution')
      p.cv.experience[0].bullets = [claim('Worked on products.', 'f1')];
    if (mode === 'reverse') p.cv.experience.reverse();
    assert.throws(() => validatePreparationProposal(p, profile, [], job), undefined, mode);
  }
});
test('Q05 job-relevant results must occur in sourced CV narrative, not only skills/cover or generic prose', () => {
  for (const mode of ['omitted', 'skills', 'generic', 'other-employer']) {
    const p = good(),
      metric = p.cv.experience[1].bullets.pop();
    if (mode === 'skills') p.cv.skills.push(claim('3× conversion', 'f4'));
    if (mode === 'generic') p.cv.experience[1].bullets.push(claim('Built new products.', 'f4'));
    if (mode === 'other-employer') p.cv.experience[0].bullets.push(metric);
    assert.throws(() => validatePreparationProposal(p, profile, [], job), undefined, mode);
  }
  assert.doesNotThrow(() => validatePreparationProposal(good(), profile, [], job));
});
test('Q06 model receives source-bound coverage plan and positive semantic verdict cannot override deterministic omission', async () => {
  const bad = good();
  bad.cv.experience.shift();
  const m = model({ initial: bad, repair: bad });
  await assert.rejects(m.run());
  assert.equal(m.sent.length, 3);
  const data = JSON.parse(m.sent[0].body.messages[1].content);
  assert.ok(data.evidencePlan.roles.some((r) => r.factId === 'f1'));
  assert.ok(m.events.some((e) => e.stage === 'deterministic-check' && e.status === 'rejected'));
  const issues = inspectPreparationProposal(bad, profile, [], job).issues;
  assert.ok(issues.some((i) => i.code === 'CV_ROLE_COVERAGE'));
});
test('Q07 each inference stage has its own bounded deadline and late ignored-abort output never reaches next stage', async (t) => {
  const stages = ['generation', 'semantic-review', 'repair', 'fresh-review'];
  for (let i = 0; i < 4; i++)
    await t.test(stages[i], async () => {
      const waits = [0, 0, 0, 0];
      waits[i] = 45;
      const timing = {
        generation: 100,
        'semantic-review': 100,
        repair: 100,
        'fresh-review': 100,
        total: 500,
        [stages[i]]: 10,
      };
      const m = model({ firstNegative: i >= 2, waits, preparationTiming: timing });
      await assert.rejects(
        m.run(),
        (e) => e.code === 'PREPARATION_STAGE_TIMEOUT' && e.stage === stages[i],
      );
      await delay(55);
      assert.equal(m.sent.length, i + 1);
      const e = m.events.find((e) => e.stage === stages[i] && e.status === 'cancelled');
      assert.equal(e.snapshot.data.verification.timing.timeout, 'stage');
    });
});
test('Q08 overall budget cancels without quota reset while four-stage scaled-budget path can finish', async () => {
  const m = model({
    firstNegative: true,
    waits: [25, 25, 25, 25],
    preparationTiming: {
      generation: 100,
      'semantic-review': 100,
      repair: 100,
      'fresh-review': 100,
      total: 35,
    },
  });
  await assert.rejects(m.run(), (e) => e.code === 'PREPARATION_TOTAL_TIMEOUT');
  await delay(65);
  assert.equal(m.sent.length, 2);
  const goodRun = model({
    firstNegative: true,
    waits: [15, 10, 15, 10],
    preparationTiming: {
      generation: 45,
      'semantic-review': 30,
      repair: 45,
      'fresh-review': 30,
      total: 155,
    },
  });
  assert.deepEqual(await goodRun.run(), good());
  assert.equal(goodRun.sent.length, 4);
  assert.deepEqual(
    goodRun.sent.map((c) => c.timeoutMs),
    [45, 30, 45, 30],
  );
});
test('Q09 invalid or larger internal deadline budgets are refused before any inference', () => {
  for (const preparationTiming of [
    { total: 155001 },
    { generation: 45001 },
    { 'semantic-review': 30001 },
    { repair: 0 },
    { total: Infinity },
    { alien: 1 },
  ]) {
    assert.throws(() =>
      getProviders({
        env,
        preparationTiming,
        transport: async () => {
          throw Error('No model call allowed');
        },
      }),
    );
  }
});

test('Q10 same numeric value in two named projects requires explicit disambiguation', () => {
  const source = structuredClone(profile);
  source.facts[2].text =
    'Built Project Atlas assistant that handled 63% of incident reports. Built Project Beacon assistant that handled 63% of incident reports.';
  const p = good(),
    c = p.cv.experience[1].bullets[1];
  c.citations[0].quote = source.facts[2].text;
  c.text = 'Built an assistant that handled 63% of incident reports.';
  assert.throws(() => validatePreparationProposal(p, source, []));
  c.text = 'Built Project Beacon assistant that handled 63% of incident reports.';
  assert.doesNotThrow(() => validatePreparationProposal(p, source, []));
});
test('Q11 repeated one-project labels and supported causal paraphrases do not become false conflicts', () => {
  const source = structuredClone(profile);
  source.facts[2].text =
    'Built Project Alpha assistant. Project Alpha handled 63% of incident reports.';
  const p = good(),
    c = p.cv.experience[1].bullets[1];
  c.citations[0].quote = source.facts[2].text;
  c.text = 'Handled 63% of incident reports.';
  assert.doesNotThrow(() => validatePreparationProposal(p, source, []));
  source.facts[2].text =
    'At Harbor, built a platform. Reduced manual work by 63% using workflow automation.';
  c.citations[0].quote = source.facts[2].text;
  c.text = 'Reduced manual work by 63% through workflow automation.';
  assert.doesNotThrow(() => validatePreparationProposal(p, source, []));
});
test('Q12 current role subtitle cannot replace its confirmed core title', () => {
  const source = structuredClone(profile);
  source.facts[0].text =
    'Northstar, Service Product Manager — AI Platform, June 2023–Present. Own AI product evaluation and data monitoring.';
  const p = good();
  for (const c of [
    ...p.cv.summary,
    ...p.cv.skills,
    ...p.cv.experience.flatMap((g) => [g.heading, ...g.bullets]),
    ...p.coverLetter,
  ])
    for (const cite of c.citations) if (cite.factId === 'f1') cite.quote = source.facts[0].text;
  p.cv.experience[0].heading.text = 'Northstar — AI Platform | June 2023–Present';
  assert.throws(() => validatePreparationProposal(p, source, [], job));
  p.cv.experience[0].heading.text = 'Northstar — Service Product Manager | June 2023–Present';
  assert.doesNotThrow(() => validatePreparationProposal(p, source, [], job));
});

async function ownedHttp(t, m, timeout = 500) {
  const directory = await mkdtemp(join(tmpdir(), 'quality-http-')),
    store = await openPrivateStorage({ directory, bootstrap: true }),
    accountId = '11111111-1111-4111-8111-111111111111';
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
              email: 'quality@example.test',
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
  const server = createServer({
    storage: store,
    accountId,
    accountGeneration: 0,
    preparationTimeoutMs: timeout,
    env: { CONTROLLED_LOCAL_MODE: '1' },
    providers: providers({
      prepareApplication: (j, p, q, o) => m.provider.prepareApplication(j, p, q, o),
    }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (path, body) => {
    const r = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await call('/api/profile', profile)).status, 200);
  assert.equal((await call('/api/companies', { companies })).status, 200);
  await call('/api/scans', { mode: 'fixture' });
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await call('/api/state')).data;
    if (state.run.status !== 'running') break;
    await delay(5);
  }
  state = (
    await call('/api/opportunities', {
      resultKey: state.run.results[0].key,
      baseRevision: state.revision,
    })
  ).data;
  const id = state.opportunities[0].id;
  assert.equal(
    (
      await call('/api/applications/' + id, {
        revision: 0,
        cvVersion: 'Prior',
        cvText: 'Prior CV',
        coverLetter: 'Prior letter',
        answers: 'Prior answers',
        files: [],
      })
    ).status,
    200,
  );
  const before = store.readSync('workspace:' + accountId);
  const body = {
    baseRevision: before.revision,
    revision: before.applications[0].revision,
    profileVersion: before.profile.version,
    questions: [],
    consent: true,
    requestId: randomUUID(),
  };
  return {
    call: () => call('/api/applications/' + id + '/prepare', body),
    before,
    state: () => store.readSync('workspace:' + accountId),
    audit: () => store.readSync('audit:' + accountId),
  };
}
test('Q13 owned HTTP refuses wrong-project metric and stage timeout with durable audit, exact replay and prior state preservation', async (t) => {
  for (const kind of ['metric', 'stage-timeout'])
    await t.test(kind, async (t) => {
      const bad = good();
      if (kind === 'metric')
        bad.cv.experience[1].bullets[1].text =
          'Built a warehouse chatbot handling 63% of incident reports.';
      const m = model({
        initial: bad,
        repair: bad,
        waits: kind === 'stage-timeout' ? [45] : [],
        preparationTiming: kind === 'stage-timeout' ? { generation: 10, total: 500 } : undefined,
      });
      const h = await ownedHttp(t, m),
        result = await h.call();
      assert.equal(result.status, kind === 'metric' ? 502 : 504, JSON.stringify(result));
      assert.deepEqual(h.state(), h.before);
      assert.deepEqual(await h.call(), result);
      await delay(70);
      assert.equal(m.sent.length, kind === 'metric' ? 3 : 1);
      assert.deepEqual(h.state(), h.before);
      const audit = h.audit();
      if (kind === 'stage-timeout')
        assert.ok(
          Object.values(audit.snapshots).some(
            (s) => s.data.verification?.timing?.timeout === 'stage',
          ),
        );
      else
        assert.ok(
          Object.values(audit.snapshots).some((s) =>
            s.data.issues?.some((i) => i.code === 'METRIC_PROJECT_SCOPE'),
          ),
        );
    });
});
test('Q14 parent HTTP deadline cancels ignored-abort work without later calls or packet replacement', async (t) => {
  const m = model({ waits: [60], preparationTiming: { generation: 100, total: 500 } }),
    h = await ownedHttp(t, m, 10);
  assert.equal((await h.call()).status, 504);
  await delay(80);
  assert.equal(m.sent.length, 1);
  assert.deepEqual(h.state(), h.before);
});

test('Q15 education dates are not employment roles or required experience headings', () => {
  const source = structuredClone(profile);
  source.facts.push({
    id: 'education',
    text: 'Education, Master of Business Administration and Management, September 2002–July 2007.',
  });
  assert.doesNotThrow(() => validatePreparationProposal(good(), source, [], job));
});

test('Q16 an earlier job at the same employer cannot supply a missing current-role contribution', () => {
  const source = structuredClone(profile);
  source.facts = source.facts.slice(0, 2);
  source.facts[0].text = 'Harbor, Service Product Manager, June 2023–Present.';
  const p = good();
  p.cv.experience[1].bullets = p.cv.experience[1].bullets.slice(0, 1);
  p.cv.experience[0].heading = claim('Harbor — Service Product Manager | June 2023–Present', 'f1');
  p.cv.experience[0].heading.citations[0].quote = source.facts[0].text;
  p.cv.experience[0].bullets = [
    claim('Built a data platform and reduced integration time-to-market by 37%.', 'f2'),
  ];
  p.coverLetter[1] = claim('I would bring platform experience to this role.', 'f2');
  assert.throws(() => validatePreparationProposal(p, source, [], job));
});

test('Q17 employment at a university remains a recognized role, unlike degree metadata', () => {
  const source = structuredClone(profile);
  source.facts.push({
    id: 'campus-job',
    text: 'University of Calgary, Researcher, July 2024–Present. Led fraud evaluation and monitoring.',
  });
  assert.ok(preparationEvidencePlan(source, job).roles.some((r) => r.factId === 'campus-job'));
});
