import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviders } from '../app/providers.mjs';
import { profile, job } from './fixtures.mjs';
const env = {
  ALLOW_LIVE: '1',
  NEBIUS_API_KEY: 'synthetic-only',
  TAVILY_API_KEY: 'synthetic-only',
  NEBIUS_MODEL: 'nvidia/configured-model',
};
function fixture() {
  let calls = 0;
  const auditBefore = [];
  const provider = getProviders({
    env,
    transport: async (_url, options) => {
      calls++;
      const b = JSON.parse(options.body),
        data = JSON.parse(b.messages[1].content),
        task = b.messages[0].content,
        mark = data.job?.title?.endsWith('B') ? 'marker-B' : 'marker-A';
      await new Promise((r) => setTimeout(r, mark === 'marker-A' ? 5 : 1));
      const result = task.includes('Assess a vacancy')
        ? {
            direction: 'aligned',
            directionReason: mark,
            rows: [
              {
                requirementId: 'r1',
                status: 'supported',
                factId: 'f1',
                profileQuote: 'AI product evaluation',
                jobQuote: 'Lead AI product evaluation.',
                unconfirmedQuote: null,
              },
            ],
          }
        : {
            reviews: [
              {
                requirementId: 'r1',
                supported: false,
                partialEvidence: null,
                reason: mark + ' unsupported ownership.',
              },
            ],
          };
      return {
        text: JSON.stringify({
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          choices: [{ message: { content: JSON.stringify(result) } }],
        }),
      };
    },
  });
  return { provider, calls: () => calls, auditBefore };
}
test('AP01 real assessment provider exposes proposal and independent verifier steps before/after every mocked model call', async () => {
  const h = fixture(),
    events = [];
  const result = await h.provider.assess(job(), profile, {
    onAudit: async (e) => {
      events.push(structuredClone(e));
      if (e.status === 'start')
        assert.equal(
          events.filter((x) => x.status === 'start').length,
          h.calls() + 1,
          'durable start must precede model HTTP',
        );
    },
  });
  assert.equal(h.calls(), 2);
  assert.equal(events.filter((e) => e.status === 'start').length, 2);
  assert.equal(events.filter((e) => e.status !== 'start').length, 2);
  assert.ok(events.every((e) => typeof e.stage === 'string' && e.stage.length > 0));
  assert.ok(events.some((e) => JSON.stringify(e).includes('unsupported ownership')));
  assert.ok(events.some((e) => e.status !== 'start' && e.usage?.totalTokens === 15));
  assert.ok(events.every((e) => e.model === env.NEBIUS_MODEL));
  assert.ok(events.every((e) => /^[a-f0-9]{64}$/.test(e.promptHash)));
  assert.equal(result.rows[0].status, 'unknown', 'mocked semantic refusal must remain visible');
});
test('AP02 failed durable audit start blocks all model calls', async () => {
  const h = fixture();
  await assert.rejects(
    () =>
      h.provider.assess(job(), profile, {
        onAudit: async () => {
          throw Object.assign(Error('Synthetic audit full'), { status: 507 });
        },
      }),
    (e) => e.status === 507,
  );
  assert.equal(h.calls(), 0);
});
test('AP03 concurrent account audit callbacks stay in their own invocation context', async () => {
  const h = fixture(),
    a = [],
    b = [];
  await Promise.all([
    h.provider.assess(job('a', { title: 'Senior Product Manager A' }), profile, {
      onAudit: async (e) => a.push(e),
    }),
    h.provider.assess(job('b', { title: 'Senior Product Manager B' }), profile, {
      onAudit: async (e) => b.push(e),
    }),
  ]);
  assert.equal(a.filter((e) => e.status === 'start').length, 2);
  assert.equal(b.filter((e) => e.status === 'start').length, 2);
  assert.match(JSON.stringify(a), /marker-A/);
  assert.doesNotMatch(JSON.stringify(a), /marker-B/);
  assert.match(JSON.stringify(b), /marker-B/);
  assert.doesNotMatch(JSON.stringify(b), /marker-A/);
});
