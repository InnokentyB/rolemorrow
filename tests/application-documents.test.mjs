// Fully fictional public-release fixture; no personal career record.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as preparation from '../app/application-preparation.mjs';
import { getProviders } from '../app/providers.mjs';
const facts = [
  {
    id: 'p1',
    text: 'At WorkshopCloud, Platform Manager from March 2021 to April 2023. Led five platform products and reduced time-to-market by 37%; managed two teams of 16+ people.',
  },
  {
    id: 'p2',
    text: 'At ClearHarbor, Service Product Manager from June 2023 to September 2025. Built a production AI workflow that processed 63% of flagged incidents automatically.',
  },
  {
    id: 'p3',
    text: 'At Logistics, led gradual decomposition of scheduling, dispatch and routing services from a legacy monolith.',
  },
  {
    id: 'p4',
    text: 'Delivered 24+ enterprise API integrations and personally wrote SQL queries including window functions.',
  },
  {
    id: 'p5',
    text: 'Based in Calgary with Canada work authorization. No current Australia work authorization.',
  },
  {
    id: 'p6',
    text: 'Available for full-time work from 5 December 2026; consulting from 15 September 2025.',
  },
  {
    id: 'p7',
    text: 'At ClearHarbor, partnered with ML engineers on production monitoring, data quality and human-in-the-loop evaluation.',
  },
];
const profile = {
  facts,
  version: 'synthetic-v2',
  goal: { roles: 'Platform Product Manager' },
};
const job = {
  title: 'Senior AI Platform Product Manager',
  company: 'Synthetic Insurance',
  text: 'Modernise legacy services, build AI-enabled workflows and measurable platform impact. SQL, Snowflake or Looker desirable.',
  requirements: [],
};
const questions = [
  'Describe your platform ownership and measurable business impact.',
  'Have you personally queried Snowflake or Looker?',
  'Are you authorised to work in Canada?',
  'When can you start full-time?',
];
const c = (text, ...ids) => ({
  text,
  citations: ids.map((id) => ({
    factId: id,
    quote: facts.find((f) => f.id === id).text,
  })),
});
function proposal() {
  return {
    version: 2,
    cv: {
      summary: [
        c('Platform product leader with fintech and production AI experience.', 'p1', 'p2'),
      ],
      skills: [c('SQL and API integrations', 'p4')],
      experience: [
        {
          heading: c('ClearHarbor — Service Product Manager | June 2023 to September 2025', 'p2'),
          bullets: [
            c(
              'Built a production AI workflow that automatically processed 63% of flagged incidents.',
              'p2',
            ),
            c(
              'Partnered with ML engineers on production monitoring and human-in-the-loop evaluation.',
              'p7',
            ),
          ],
        },
        {
          heading: c('WorkshopCloud — Platform Manager | March 2021 to April 2023', 'p1'),
          bullets: [
            c(
              'Led five platform products, reducing time-to-market by 37% across two teams of 16+ people.',
              'p1',
            ),
          ],
        },
        {
          heading: c('Logistics — legacy modernisation', 'p3'),
          bullets: [
            c('Led incremental decomposition of scheduling, dispatch and routing services.', 'p3'),
          ],
        },
      ],
    },
    coverLetter: [
      c(
        'I bring platform delivery experience from WorkshopCloud, where I led five products and reduced time-to-market by 37%.',
        'p1',
      ),
      c(
        'My production AI delivery at ClearHarbor combined automation of 63% of flagged incidents with ML monitoring and human-in-the-loop evaluation.',
        'p2',
        'p7',
      ),
      c(
        'The platform modernisation work builds on my experience decomposing legacy scheduling, dispatch and routing services.',
        'p3',
      ),
    ],
    answers: [
      {
        questionIndex: 0,
        status: 'answered',
        claims: [
          c(
            'At WorkshopCloud, I led five platform products and reduced time-to-market by 37% across two teams of 16+ people.',
            'p1',
          ),
        ],
      },
      { questionIndex: 1, status: 'unknown', claims: [] },
      {
        questionIndex: 2,
        status: 'answered',
        claims: [c('Yes. I am based in Calgary and have Canada work authorization.', 'p5')],
      },
      {
        questionIndex: 3,
        status: 'answered',
        claims: [c('I can start full-time from 5 December 2026.', 'p6')],
      },
    ],
  };
}
const inventory = (p) => preparation.preparationClaimInventory(p);
const review = (p) => ({
  reviews: inventory(p).map(({ claimId }) => ({
    claimId,
    supported: true,
    reason: 'Supported by supplied exact source.',
  })),
  coverage: {
    complete: true,
    reason: 'Platform impact, AI results, legacy and direct answers covered.',
  },
  answersComplete: true,
  distinctCover: true,
});
const render = (p) =>
  preparation.renderPreparation(p, profile, { snapshot: job }, questions, {
    method: 'nebius-grounded-documents-v2',
  });
const fail = (f) => assert.throws(f, (e) => e.status === 502 || e.statusCode === 502);
test('D01 full documents preserve chronology and supported impact, separate letter, direct answers without internal warnings', () => {
  const result = render(proposal());
  for (const heading of ['Professional Summary', 'Skills', 'Experience'])
    assert.ok(result.draft.cvText.includes(heading));
  for (const v of ['ClearHarbor', 'WorkshopCloud', 'March 2021', '37%', '63%', '16+'])
    assert.ok(result.draft.cvText.includes(v), v);
  assert.ok(result.draft.coverLetter.includes(job.company));
  assert.notEqual(result.draft.coverLetter, result.draft.cvText);
  assert.ok(result.draft.answers.includes('37%'));
  assert.ok(result.draft.answers.includes('5 December 2026'));
  const portugal = result.draft.answers.split(questions[2])[1].split(questions[3])[0];
  assert.doesNotMatch(portugal, /US work/);
  const start = result.draft.answers.split(questions[3])[1];
  assert.doesNotMatch(start, /consulting|15 October/);
  for (const body of Object.values(result.draft).filter((v) => typeof v === 'string'))
    assert.doesNotMatch(
      body,
      /review required|Please review this draft|Saved evidence relevant|p[1-7]:/i,
    );
  assert.ok(result.provenance.evidence.some((e) => e.factId === 'p1'));
});
test('D02 old ID-only shape cannot masquerade as full document generation', () => {
  fail(() => render({ cvFactIds: ['p1'], coverFactIds: ['p1'], answers: [] }));
});
test('D03 invalid evidence or altered metrics/dates are rejected before export', async (t) => {
  const cases = [
    (p) => (p.cv.summary[0].citations[0].factId = 'foreign'),
    (p) => (p.cv.summary[0].citations[0].quote = 'Not in the saved profile'),
    (p) => (p.cv.summary[0].citations = []),
    (p) => (p.cv.experience[1].bullets[0].text = 'Reduced time-to-market by 100%.'),
    (p) => (p.cv.experience[1].heading.text = 'WorkshopCloud — Platform Manager | March 2020 to April 2023'),
    (p) => (p.cv.experience[1].bullets[0].text = 'Saved €400000.'),
    (p) => (p.answers[0].claims[0].text = 'Reduced time-to-market by 40 dollars.'),
  ];
  for (const change of cases)
    await t.test('reject malformed or unsupported claim', () => {
      const p = proposal();
      change(p);
      fail(() => render(p));
    });
});
test('D04 no duplicated CV dump or prose in unknown answer', async (t) => {
  for (const change of [
    (p) => (p.coverLetter[0] = structuredClone(p.cv.summary[0])),
    (p) => (p.answers[1].claims = [c('Yes, I used Snowflake.', 'p4')]),
    (p) => (p.coverLetter[0].text = 'Please review this draft before submitting.'),
    (p) => (p.cv.summary = []),
  ])
    await t.test('refuse invalid document completeness', () => {
      const p = proposal();
      change(p);
      fail(() => render(p));
    });
});
test('D05 measurable impact answer cannot ignore available metrics', () => {
  const p = proposal();
  p.answers[0].claims = [c('I led platform products.', 'p1')];
  fail(() => render(p));
});
test('D06 semantic review is exhaustive and fail-closed', async (t) => {
  const expectedPaths = [
    'cv.summary.0',
    'cv.skills.0',
    'cv.experience.0.heading',
    'cv.experience.0.bullets.0',
    'cv.experience.0.bullets.1',
    'cv.experience.1.heading',
    'cv.experience.1.bullets.0',
    'cv.experience.2.heading',
    'cv.experience.2.bullets.0',
    'coverLetter.0',
    'coverLetter.1',
    'coverLetter.2',
    'answers.0.claims.0',
    'answers.2.claims.0',
    'answers.3.claims.0',
  ];
  const p = proposal(),
    items = inventory(p);
  assert.deepEqual(
    items.map((c) => c.claimId),
    expectedPaths,
    'independent literal inventory oracle',
  );
  for (const item of items) {
    const expected = item.claimId.split('.').reduce((value, key) => value[key], p);
    assert.equal(item.text, expected.text);
    assert.deepEqual(item.citations, expected.citations);
  }
  assert.ok(items.length > 10);
  assert.equal(new Set(items.map((c) => c.claimId)).size, items.length);
  assert.doesNotThrow(() => preparation.validatePreparationReview(review(p), items));
  const changes = [
    (r) => r.reviews.pop(),
    (r) => r.reviews.push(r.reviews[0]),
    (r) => (r.reviews[0].claimId = 'foreign'),
    (r) => (r.reviews[0].supported = false),
    (r) => (r.reviews[0].supported = 'true'),
    (r) => (r.reviews[0].reason = ''),
    (r) => (r.coverage.complete = false),
    (r) => (r.answersComplete = false),
    (r) => (r.distinctCover = false),
    (r) => (r.extra = 'unsupported'),
  ];
  for (const change of changes)
    await t.test('reject missing or negative semantic verdict', () => {
      const r = review(p);
      change(r);
      fail(() => preparation.validatePreparationReview(r, items));
    });
});
function asWire(proposal, sourceProfile = profile) {
  const p = structuredClone(proposal);
  const claims = [
    ...p.cv.summary,
    ...p.cv.skills,
    ...p.cv.experience.flatMap((g) => [g.heading, ...g.bullets]),
    ...p.coverLetter,
    ...p.answers.flatMap((a) => a.claims),
  ];
  for (const c of claims)
    c.citations = c.citations.map((cite) => {
      const index = sourceProfile.facts.findIndex(
        (f) => f.id === cite.factId && f.text === cite.quote,
      );
      assert.ok(index >= 0, 'synthetic wire helper requires a full canonical fact');
      return preparation.preparationEvidenceCatalog(sourceProfile)[index].ref;
    });
  return p;
}
function live(responder, sourceProfile = profile) {
  const bodies = [];
  const p = getProviders({
    env: {
      ALLOW_LIVE: '1',
      NEBIUS_API_KEY: 'synthetic-only',
      NEBIUS_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
    },
    transport: async (url, options) => {
      assert.equal(url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
      const body = JSON.parse(options.body);
      bodies.push(body);
      const output = await responder(bodies.length, body, options);
      return {
        text: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  output?.version === 2 ? asWire(output, sourceProfile) : output,
                ),
              },
            },
          ],
        }),
      };
    },
  });
  return { p, bodies };
}
test('D07 two-stage live method uses proposal and separate exhaustive review with full evidence, no Tavily', async () => {
  const expected = proposal(),
    { p, bodies } = live((n) => (n === 1 ? expected : review(expected)));
  assert.deepEqual(
    await p.prepareApplication(job, profile, questions, {
      signal: AbortSignal.timeout(1000),
    }),
    expected,
  );
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(
      body.chat_template_kwargs.enable_thinking,
      false,
      'preparation-only fast mode after observed deadline failure',
    );
    assert.equal(body.chat_template_kwargs.reasoning_budget, undefined);
    assert.equal(body.max_tokens, 6000);
  }

  const data = JSON.parse(bodies[1].messages[1].content);
  assert.ok(JSON.stringify(data).includes('37%'));
  assert.ok(JSON.stringify(data).includes('63%'));
  assert.ok(JSON.stringify(data).includes('Snowflake'));
  assert.notEqual(bodies[0].messages[0].content, bodies[1].messages[0].content);
  assert.match(bodies[1].messages[0].content, /unsupported|entail|support/i);
});
test('D08 negative semantic verdict routing refuses output; mocked review is not an accuracy oracle', async (t) => {
  for (const reason of [
    'Swapped WorkshopCloud achievement onto ClearHarbor.',
    'Led overstates partnered ownership.',
    'Snowflake cannot be inferred from SQL.',
    'Required impact metric omitted.',
  ])
    await t.test(reason, async () => {
      const expected = proposal(),
        { p, bodies } = live((n) => {
          if (n === 1 || n === 3) return expected;
          const r = review(expected);
          r.reviews[0].supported = false;
          r.reviews[0].reason = reason;
          return r;
        });
      await assert.rejects(
        () =>
          p.prepareApplication(job, profile, questions, {
            signal: AbortSignal.timeout(1000),
          }),
        (error) =>
          error.status === 502 && /grounded-content and completeness review/.test(error.message),
      );
      assert.equal(bodies.length, 4);
    });
});
test('D09 review transport failure must not silently accept or retry into a different draft', async () => {
  const { p, bodies } = live((n) => {
    if (n === 1) return proposal();
    throw Object.assign(Error('Synthetic outage'), { status: 503 });
  });
  await assert.rejects(() =>
    p.prepareApplication(job, profile, questions, {
      signal: AbortSignal.timeout(1000),
    }),
  );
  assert.equal(bodies.length, 2);
});
test('D10 abort during semantic review cannot publish a late verified proposal', async () => {
  const controller = new AbortController();
  const { p } = live((n) => {
    if (n === 1) return proposal();
    controller.abort(Error('Cancelled by candidate'));
    return review(proposal());
  });
  await assert.rejects(() =>
    p.prepareApplication(job, profile, questions, {
      signal: controller.signal,
    }),
  );
});

function largeProposal() {
  const profile = {
    version: 'large',
    facts: ['a', 'b', 'c', 'd'].map((id, i) => ({
      id,
      text: ['文', '字', '語', '言'][i].repeat(1500),
    })),
  };
  const claim = (text) => ({
    text,
    citations: profile.facts.map((f) => ({ factId: f.id, quote: f.text })),
  });
  const p = {
    version: 2,
    cv: {
      summary: Array.from({ length: 4 }, () => claim('Platform product experience.')),
      skills: [],
      experience: Array.from({ length: 10 }, () => ({
        heading: claim('Platform experience'),
        bullets: Array.from({ length: 8 }, () => claim('Delivered platform capabilities.')),
      })),
    },
    coverLetter: [
      claim('I bring platform delivery experience to this opportunity.'),
      claim('My background supports the platform work described by this role.'),
    ],
    answers: [],
  };
  return { profile, p };
}
test('D11 a single result with repeated multibyte citations cannot exceed bounded cache payload', () => {
  const { profile, p } = largeProposal();
  assert.ok(Buffer.byteLength(JSON.stringify(p)) > 1024 * 1024);
  fail(() =>
    preparation.renderPreparation(p, profile, { snapshot: job }, [], {
      method: 'nebius-grounded-documents-v2',
    }),
  );
});
test('D12 actual bad claims and their original citations reach separate reviewer without laundering', async (t) => {
  const cases = [
    [
      'wrong company',
      'At ClearHarbor, I reduced time-to-market by 37%.',
      (p) => p.cv.experience[1].bullets[0],
    ],
    [
      'ownership inflation',
      'Led ML engineers on production monitoring and human-in-the-loop evaluation.',
      (p) => p.cv.experience[0].bullets[1],
    ],
    [
      'metric scope inflation',
      'Built an AI workflow that processed 63% of all incidents automatically.',
      (p) => p.cv.experience[0].bullets[0],
    ],
  ];
  for (const [name, text, pick] of cases)
    await t.test(name, async () => {
      const expected = proposal(),
        target = pick(expected);
      target.text = text;
      const originalSources = structuredClone(target.citations);
      const { p, bodies } = live((n, body) => {
        if (n === 1 || n === 3) return expected;
        const data = JSON.parse(body.messages[1].content);
        const encoded = JSON.stringify(data);
        assert.ok(encoded.includes(text));
        for (const cite of originalSources) assert.ok(encoded.includes(cite.quote));
        const r = review(expected);
        r.reviews[0].supported = false;
        r.reviews[0].reason = name;
        return r;
      });
      await assert.rejects(
        () =>
          p.prepareApplication(job, profile, questions, {
            signal: AbortSignal.timeout(1000),
          }),
        (error) =>
          error.status === 502 &&
          (name === 'wrong company'
            ? /CV omits or misplaces/.test(error.message)
            : /grounded-content and completeness review/.test(error.message)),
      );
      assert.equal(bodies.length, name === 'wrong company' ? 3 : 4);
    });
});
test('D13 oversized preparation input refuses before inference HTTP, not silent truncation', async () => {
  const hugeJob = { ...job, text: 'x'.repeat(600000) };
  const { p, bodies } = live(() => proposal());
  await assert.rejects(() =>
    p.prepareApplication(hugeJob, profile, questions, {
      signal: AbortSignal.timeout(1000),
    }),
  );
  assert.equal(bodies.length, 0);
});
test('D14 oversized repeated-citation semantic review request refuses before second inference', async () => {
  const { profile, p: proposal } = largeProposal();
  const { p, bodies } = live(() => proposal, profile);
  await assert.rejects(() =>
    p.prepareApplication(job, profile, [], {
      signal: AbortSignal.timeout(1000),
    }),
  );
  assert.equal(bodies.length, 1);
});
test('D15 altered month or start day cannot be exported', async (t) => {
  for (const change of [
    (p) => (p.cv.experience[1].heading.text = 'WorkshopCloud — Platform Manager | February 2021 to April 2023'),
    (p) => (p.answers[3].claims[0].text = 'I can start full-time from 15 November 2026.'),
  ])
    await t.test('reject changed calendar value', () => {
      const p = proposal();
      change(p);
      fail(() => render(p));
    });
});

test('D16 controlled fixture lists explicitly supplied technical skills but never infers certification from usage', () => {
  const p = {
    facts: [
      {
        id: 's1',
        text: 'Built Python PostgreSQL services and operated Kubernetes.',
      },
      {
        id: 's2',
        text: 'Led platform products and reduced time-to-market by 37%.',
      },
    ],
    version: 'skills-fixture',
  };
  const questions = ['Do you hold a Kubernetes certification?'];
  const result = preparation.fixturePreparation(job, p, questions);
  assert.equal(result.version, 2);
  assert.ok(result.cv.skills.length > 0);
  assert.ok(result.cv.skills.some((c) => /PostgreSQL/.test(c.text)));
  assert.equal(result.answers[0].status, 'unknown');
  assert.deepEqual(result.answers[0].claims, []);
  const plain = {
    facts: [{ id: 'n1', text: 'Managed platform products.' }],
    version: 'no-skills',
  };
  assert.equal(
    preparation.fixturePreparation(job, plain, []).cv.skills.length,
    0,
    'no invented technical skills',
  );
});

test('D17 more-than comparator cannot silently become plus notation in adapted prose', () => {
  const changed = structuredClone(profile);
  changed.facts[0].text = changed.facts[0].text.replace('16+ people', 'more than 16 people');
  const p = proposal();
  for (const item of inventory(p))
    for (const cite of item.citations) if (cite.factId === 'p1') cite.quote = changed.facts[0].text;
  fail(() =>
    preparation.renderPreparation(p, changed, { snapshot: job }, questions, {
      method: 'nebius-grounded-documents-v2',
    }),
  );
});
test('D18 complete cover letter must stay within 350 words including server greeting and closing', () => {
  const p = proposal();
  p.coverLetter = Array.from({ length: 5 }, (_, i) =>
    c(
      'My relevant platform experience supports product delivery. '.repeat(16) +
        [
          'I value this opportunity.',
          'I bring relevant experience.',
          'I would discuss the role.',
          'I have platform experience.',
          'I bring product context.',
        ][i],
      'p1',
    ),
  );
  fail(() => render(p));
});
test('D19 semantic reviewer receives employer heading context for an unattributed cross-company bullet', async () => {
  const expected = proposal();
  const misplaced = structuredClone(expected.cv.experience[1].bullets[0]);
  expected.cv.experience[0].bullets.push(misplaced);
  const { p, bodies } = live((n, body) => {
    if (n === 1 || n === 3) return expected;
    const data = JSON.parse(body.messages[1].content);
    assert.ok(data.proposal.cv.experience[0].heading.text.includes('ClearHarbor'));
    assert.deepEqual(data.proposal.cv.experience[0].bullets.at(-1).citations, misplaced.citations);
    assert.match(body.messages[0].content, /heading|group context|attribution/i);
    const r = review(expected);
    r.reviews.find((r) => r.claimId === 'cv.experience.0.bullets.2').supported = false;
    return r;
  });
  await assert.rejects(
    () =>
      p.prepareApplication(job, profile, questions, {
        signal: AbortSignal.timeout(1000),
      }),
    (error) =>
      error.status === 502 && /grounded-content and completeness review/.test(error.message),
  );
  assert.equal(bodies.length, 4);
});

test('D20 canonical evidence catalog and reference expansion preserve exact source bytes with unchanged public proposal', () => {
  const expected = facts.map((f, i) => ({
    ref: preparation.preparationEvidenceCatalog(profile)[i].ref,
    factId: f.id,
    quote: f.text,
  }));
  assert.deepEqual(preparation.preparationEvidenceCatalog(profile), expected);
  const wire = asWire(proposal());
  assert.deepEqual(preparation.resolvePreparationReferences(wire, profile), proposal());
  assert.match(wire.cv.summary[0].citations[0], /^src_[a-f0-9]{64}$/);
  assert.equal(
    preparation.resolvePreparationReferences(wire, profile).cv.summary[0].citations[0].quote,
    facts[0].text,
  );
  const long = {
    facts: [
      {
        id: 'long',
        text: 'This is a complete confirmed source sentence. '.repeat(50),
      },
    ],
    version: 'long',
  };
  const catalog = preparation.preparationEvidenceCatalog(long);
  assert.ok(catalog.length > 0);
  for (const item of catalog) {
    assert.ok(item.quote.length <= 1500);
    assert.ok(long.facts[0].text.includes(item.quote));
    assert.match(item.quote, /[.!?]$/);
  }
  fail(() =>
    preparation.preparationEvidenceCatalog({
      facts: [{ id: 'long', text: 'x'.repeat(1600) }],
    }),
  );
});
test('D21 unknown object-valued empty or mixed refs cannot inject quoted text or fact attribution', async (t) => {
  for (const change of [
    (p) => (p.cv.summary[0].citations = ['foreign']),
    (p) =>
      (p.cv.summary[0].citations = [
        preparation.preparationEvidenceCatalog(profile)[0].ref,
        preparation.preparationEvidenceCatalog(profile)[0].ref,
        'foreign',
      ]),
    (p) => (p.cv.summary[0].citations = [{ factId: 'p2', quote: facts[0].text }]),
    (p) => (p.cv.summary[0].citations = []),
    (p) => (p.cv.summary[0].extra = 'invented'),
  ])
    await t.test('reject invalid model reference', () => {
      const p = asWire(proposal());
      change(p);
      fail(() => preparation.resolvePreparationReferences(p, profile));
    });
});
test('D22 narrative sentence truncation and unbalanced delimiters refuse while headings and compact skills remain valid', async (t) => {
  for (const change of [
    (p) => (p.cv.summary[0].text = 'Platform experience with'),
    (p) => (p.cv.experience[0].bullets[0].text = 'Built production AI workflows and.'),
    (p) => (p.coverLetter[0].text = 'My relevant platform experience [supports this opportunity.'),
    (p) => (p.answers[0].claims[0].text = 'I delivered platform products, with'),
  ])
    await t.test('reject unfinished narrative', () => {
      const p = proposal();
      change(p);
      fail(() => render(p));
    });
  assert.doesNotThrow(() => render(proposal()));
});
test('D23 skills are short complete labels, never clipped copied job-requirement sentences', async (t) => {
  for (const text of [
    'Technical literacy: confident with engineers on system architecture and APIs',
    'Clarity in complexity; explain dependencies',
    'Platform delivery and API architecture with engineering leaders',
    'SQL\nAPI integration',
  ])
    await t.test('reject malformed skills label', () => {
      const p = proposal();
      p.cv.skills[0].text = text;
      fail(() => render(p));
    });
});
test('D24 prepared semantic requests preserve unknown versus negative distinction rather than claim never used', async () => {
  const extra = {
      id: 'p8',
      text: 'Direct Snowflake experience is not confirmed.',
    },
    sourceProfile = { ...profile, facts: [...facts, extra] },
    expected = proposal();
  expected.coverLetter[0] = {
    text: 'I have never used Snowflake.',
    citations: [{ factId: 'p8', quote: extra.text }],
  };
  const { p, bodies } = live((n, body) => {
    if (n === 1 || n === 3) return expected;
    const data = JSON.parse(body.messages[1].content);
    assert.ok(JSON.stringify(data).includes('Direct Snowflake experience is not confirmed.'));
    const r = review(expected);
    r.reviews[0].supported = false;
    r.reviews[0].reason = 'Unknown is not evidence that the candidate never used a tool.';
    return r;
  }, sourceProfile);
  await assert.rejects(
    () =>
      p.prepareApplication(job, sourceProfile, questions, {
        signal: AbortSignal.timeout(1000),
      }),
    (error) =>
      error.status === 502 && /grounded-content and completeness review/.test(error.message),
  );
  assert.equal(bodies.length, 4);
});

function repairCase() {
  const initial = proposal();
  initial.cv.summary[0].text = 'Product leader with 5+ years of platform experience.';
  initial.coverLetter[0].text = 'Modernised legacy services with zero downtime.';
  const corrected = proposal();
  corrected.cv.summary.push(c('I delivered API integrations and wrote SQL queries.', 'p4'));
  const negative = review(initial);
  negative.reviews.find((r) => r.claimId === 'cv.summary.0').supported = false;
  negative.reviews.find((r) => r.claimId === 'cv.summary.0').reason =
    '5+ years is not supported by the cited source.';
  negative.reviews.find((r) => r.claimId === 'coverLetter.0').supported = false;
  negative.reviews.find((r) => r.claimId === 'coverLetter.0').reason =
    'Zero downtime is not confirmed.';
  negative.coverage.complete = false;
  negative.coverage.reason = 'Correct unsupported claims before acceptance.';
  return { initial, corrected, negative };
}
test('D25 untrusted content inspection gives bounded issues without publishing or weakening final validation', () => {
  const { initial } = repairCase();
  const projected = preparation.resolvePreparationReferences(asWire(initial), profile);
  const inspected = preparation.inspectPreparationProposal(projected, profile, questions);
  assert.ok(inspected.issues.length >= 1);
  assert.ok(inspected.issues[0].message);
  assert.equal(inspected.issues[0].code, 'CONTENT_VALIDATION');
  assert.ok(inspected.inventory.some((c) => c.claimId === 'cv.summary.0'));
  fail(() => render(projected));
});
test('D26 one feedback repair resolves initial numeric and unsupported claims, then requires fresh exhaustive review', async () => {
  const { initial, corrected, negative } = repairCase();
  const { p, bodies } = live((n, body) => {
    const data = JSON.parse(body.messages[1].content);
    if (n === 1) return initial;
    if (n === 2) {
      assert.ok(data.deterministicIssues.length > 0);
      assert.ok(data.inventory.some((c) => c.text.includes('5+ years')));
      return negative;
    }
    if (n === 3) {
      assert.ok(data.deterministicIssues.length > 0);
      assert.ok(data.semanticReview.reviews.some((r) => r.reason.includes('Zero downtime')));
      assert.ok(JSON.stringify(data).includes(facts[0].text));
      return corrected;
    }
    assert.equal(n, 4, 'no fifth model call');
    assert.ok(
      data.inventory.some((c) => c.claimId === 'cv.summary.1'),
      'repaired inventory must be freshly reviewed',
    );
    assert.equal(data.proposal.cv.summary[0].text, corrected.cv.summary[0].text);
    return review(corrected);
  });
  const result = await p.prepareApplication(job, profile, questions, {
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(result, corrected);
  assert.equal(bodies.length, 4);
});
test('D27 invalid repaired content refuses before final review and never takes a fifth call', async () => {
  const { initial, negative } = repairCase();
  const { p, bodies } = live((n) => (n === 2 ? negative : initial));
  await assert.rejects(
    () =>
      p.prepareApplication(job, profile, questions, {
        signal: AbortSignal.timeout(1000),
      }),
    (error) => error.status === 502,
  );
  assert.equal(bodies.length, 3);
});
test('D28 malformed first review must refuse without repair', async () => {
  const { initial } = repairCase();
  const { p, bodies } = live((n) => {
    if (n === 1) return initial;
    const r = review(initial);
    r.reviews.pop();
    return r;
  });
  await assert.rejects(
    () =>
      p.prepareApplication(job, profile, questions, {
        signal: AbortSignal.timeout(1000),
      }),
    (error) => error.status === 502,
  );
  assert.equal(bodies.length, 2);
});
test('D29 negative fresh review refuses final repaired draft without fallback or extra repair', async () => {
  const { initial, corrected, negative } = repairCase();
  const { p, bodies } = live((n) => {
    if (n === 1) return initial;
    if (n === 2) return negative;
    if (n === 3) return corrected;
    assert.equal(n, 4);
    const r = review(corrected);
    r.coverage.complete = false;
    return r;
  });
  await assert.rejects(
    () =>
      p.prepareApplication(job, profile, questions, {
        signal: AbortSignal.timeout(1000),
      }),
    (error) =>
      error.status === 502 && /grounded-content and completeness review/.test(error.message),
  );
  assert.equal(bodies.length, 4);
});
test('D30 cancel at review, repair or final review stops later calls and never returns draft', async (t) => {
  for (const stage of [2, 3, 4])
    await t.test('abort stage ' + stage, async () => {
      const { initial, corrected, negative } = repairCase(),
        controller = new AbortController();
      const { p, bodies } = live((n) => {
        if (n === stage) controller.abort(Error('Cancelled at stage ' + stage));
        return n === 1 ? initial : n === 2 ? negative : n === 3 ? corrected : review(corrected);
      });
      await assert.rejects(
        () =>
          p.prepareApplication(job, profile, questions, {
            signal: controller.signal,
          }),
        (error) => error.message === 'Cancelled at stage ' + stage,
      );
      assert.equal(bodies.length, stage);
    });
});
test('D31 valid negative semantic feedback is structured, never itself accepted as final review', () => {
  const { initial, negative } = repairCase();
  assert.doesNotThrow(() =>
    preparation.validatePreparationReviewShape(negative, inventory(initial)),
  );
  fail(() => preparation.validatePreparationReview(negative, inventory(initial)));
  const malformed = structuredClone(negative);
  malformed.reviews[0].supported = 'false';
  fail(() => preparation.validatePreparationReviewShape(malformed, inventory(initial)));
});
test('D32 malformed reference gets at most one repair and never semantic review of invalid wire', async () => {
  const wire = asWire(proposal());
  wire.cv.summary[0].citations = ['foreign'];
  let calls = 0;
  const p = getProviders({
    env: {
      ALLOW_LIVE: '1',
      NEBIUS_API_KEY: 'synthetic-only',
      NEBIUS_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
    },
    transport: async () => {
      calls++;
      return {
        text: JSON.stringify({
          choices: [{ message: { content: JSON.stringify(wire) } }],
        }),
      };
    },
  });
  await assert.rejects(
    () =>
      p.prepareApplication(job, profile, questions, {
        signal: AbortSignal.timeout(1000),
      }),
    (error) => error.status === 502,
  );
  assert.equal(
    calls,
    2,
    'generation and one repair only; neither invalid wire reaches semantic review',
  );
});

test('D33 deterministic issue forces repair even when first semantic review says all true', async () => {
  const { initial, corrected } = repairCase();
  const { p, bodies } = live((n) =>
    n === 1 ? initial : n === 2 ? review(initial) : n === 3 ? corrected : review(corrected),
  );
  const result = await p.prepareApplication(job, profile, questions, {
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(result, corrected);
  assert.equal(bodies.length, 4);
});
test('D34 semantic issue alone repairs content-valid draft then freshly reviews every claim', async () => {
  const initial = proposal(),
    corrected = structuredClone(initial),
    negative = review(initial);
  negative.reviews[0].supported = false;
  negative.reviews[0].reason = 'Unsupported role attribution.';
  corrected.cv.summary.push(structuredClone(initial.cv.summary[0]));
  const { p, bodies } = live((n, body) => {
    const data = JSON.parse(body.messages[1].content);
    if (n === 1) return initial;
    if (n === 2) return negative;
    if (n === 3) {
      assert.deepEqual(data.deterministicIssues, []);
      assert.deepEqual(data.semanticReview, negative);
      return corrected;
    }
    assert.equal(n, 4);
    assert.ok(data.inventory.some((c) => c.claimId === 'cv.summary.1'));
    return review(corrected);
  });
  const result = await p.prepareApplication(job, profile, questions, {
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(result, corrected);
  assert.equal(bodies.length, 4);
});

test('D35 complete letter overflow is repair feedback even when semantic reviewer approves all claims', async () => {
  const initial = proposal(),
    corrected = proposal();
  initial.coverLetter = Array.from({ length: 5 }, () => ({
    ...structuredClone(initial.coverLetter[0]),
    text: 'Supported platform delivery '.repeat(24) + 'delivers measurable impact.',
  }));
  // Each paragraph <90 words and <1500 characters; full letter exceeds 350.
  assert.doesNotThrow(() => preparation.validatePreparationProposal(initial, profile, questions));
  assert.throws(
    () => preparation.renderPreparation(initial, profile, { snapshot: job }, questions),
    /350-word/,
  );
  const { p, bodies } = live((n, body) => {
    const data = JSON.parse(body.messages[1].content);
    if (n === 1) return initial;
    if (n === 2) return review(initial);
    if (n === 3) {
      assert.ok(data.deterministicIssues.some((i) => /350-word/.test(i.message)));
      return corrected;
    }
    assert.equal(n, 4);
    return review(corrected);
  });
  const result = await p.prepareApplication(job, profile, questions, {
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(bodies.length, 4);
  assert.deepEqual(result, corrected);
  assert.ok(
    preparation
      .renderPreparation(result, profile, { snapshot: job }, questions)
      .draft.coverLetter.split(/\s+/).length <= 350,
  );
});
test('D36 inspection reports every numeric citation mismatch with its exact claim identity', () => {
  const p = proposal();
  p.cv.summary[0].text = 'I delivered 99% improvement.';
  p.coverLetter[0].text = 'I delivered 98% automation.';
  const result = preparation.inspectPreparationProposal(p, profile, questions, job);
  const metricRows = result.issues.filter((i) => i.code === 'UNSUPPORTED_NUMERIC_CITATION');
  assert.ok(metricRows.some((r) => r.claimId === 'cv.summary.0'));
  assert.ok(metricRows.some((r) => r.claimId === 'coverLetter.0'));
  fail(() => render(p));
});
test('D37 JA cover opens with a grounded hook and retains target context without a generic application announcement', () => {
  const result = render(proposal());
  assert.doesNotMatch(result.draft.coverLetter, /I am applying for/);
  assert.ok(result.draft.coverLetter.includes(job.title));
  assert.ok(result.draft.coverLetter.includes(job.company));
  assert.ok(result.draft.coverLetter.includes(proposal().coverLetter[0].text));
});
test('D38 exact alphanumeric employer brand is context only in cover, never an exemption for candidate metrics', () => {
  const p = proposal();
  p.coverLetter[0].text = 'I bring this experience to Trading 212. ' + p.coverLetter[0].text;
  const target = { ...job, company: 'Trading 212' };
  assert.doesNotThrow(() =>
    preparation.renderPreparation(p, profile, { snapshot: target }, questions),
  );
  for (const change of [
    (x) => (x.coverLetter[0].text += ' I achieved 212% improvement.'),
    (x) => (x.coverLetter[0].text += ' I delivered 212 products.'),
    (x) => (x.cv.summary[0].text += ' I led Trading 212.'),
    (x) => (x.answers[0].claims[0].text += ' I led Trading 212.'),
  ]) {
    const x = structuredClone(p);
    change(x);
    fail(() => preparation.renderPreparation(x, profile, { snapshot: target }, questions));
  }
  fail(() =>
    preparation.renderPreparation(p, profile, { snapshot: { ...job, company: '212' } }, questions),
  );
  fail(() =>
    preparation.renderPreparation(
      p,
      profile,
      { snapshot: { ...job, company: 'Trading' } },
      questions,
    ),
  );
});
test('D39 numeric binding feedback identifies missing tokens and canonical refs without assigning them', () => {
  const p = proposal();
  p.cv.summary[0] = c('I delivered 63% automation.', 'p1');
  const before = structuredClone(p);
  const inspection = preparation.inspectPreparationProposal(p, profile, questions, job);
  const issue = inspection.issues.find((i) => i.claimId === 'cv.summary.0');
  assert.deepEqual(issue.unsupportedNumericTokens, ['63%']);
  assert.ok(
    issue.canonicalRefHints.some(
      (h) =>
        h.token === '63%' &&
        h.refs.includes(preparation.preparationEvidenceCatalog(profile)[1].ref),
    ),
  );
  assert.deepEqual(p, before);
});
test('D40 SQL and named product-analysis/AI tools require their own exact cited support', () => {
  for (const word of ['SQL', 'Amplitude', 'Mixpanel', 'Claude Code', 'MCP', 'RAG']) {
    const p = proposal();
    p.cv.skills[0] = c(word, 'p2');
    fail(() => render(p));
  }
});
test('D41 employer context cannot hide percentages, plus/decimal suffixes, hostile labels or unrelated outcomes', () => {
  const target = { ...job, company: 'Trading 212' };
  for (const text of [
    'Trading 212%',
    'Trading 212+',
    'Trading 212.5',
    'Trading 212,000',
    'Trading 212a',
  ]) {
    const p = proposal();
    p.coverLetter[0].text = 'I delivered ' + text + '.';
    fail(() => preparation.renderPreparation(p, profile, { snapshot: target }, questions));
  }
  for (const company of [
    '99%',
    'Brand 99%',
    'Brand 212+',
    'Trading 212\nCo',
    'Trading 212' + 'x'.repeat(201),
  ]) {
    const p = proposal();
    p.coverLetter[0].text = 'I bring this experience to ' + company + '.';
    fail(() =>
      preparation.renderPreparation(p, profile, { snapshot: { ...job, company } }, questions),
    );
  }
  const valid = proposal();
  valid.coverLetter[0].text =
    'I bring this experience to Trading 212’s team. ' + valid.coverLetter[0].text;
  assert.doesNotThrow(() =>
    preparation.renderPreparation(valid, profile, { snapshot: target }, questions),
  );
  fail(() => preparation.validatePreparationProposal(valid, profile, questions));
});
test('D42 one repair receives both numeric and named-tool reference defects from different claims', () => {
  const p = proposal();
  p.cv.summary[0] = c('I delivered 63% automation.', 'p1');
  p.coverLetter[0] = c('I write SQL and use Amplitude.', 'p2');
  const inspection = preparation.inspectPreparationProposal(p, profile, questions, job);
  assert.ok(
    inspection.issues.some(
      (i) => i.claimId === 'cv.summary.0' && i.code === 'UNSUPPORTED_NUMERIC_CITATION',
    ),
  );
  const tool = inspection.issues.find(
    (i) => i.claimId === 'coverLetter.0' && i.code === 'UNSUPPORTED_TOOL_CITATION',
  );
  assert.deepEqual(tool.unsupportedTerms, ['SQL', 'Amplitude']);
  assert.ok(
    tool.canonicalRefHints.some(
      (h) =>
        h.term === 'SQL' && h.refs.includes(preparation.preparationEvidenceCatalog(profile)[3].ref),
    ),
  );
  fail(() => render(p));
});
