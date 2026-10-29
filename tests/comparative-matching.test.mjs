import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, template, score } from './benchmark/matching.mjs';
function observed(product = 'rolemorrow') {
  const r = template(product);
  r.observations = r.observations.map((o, i) => ({ ...o, status: 'observed', capturedAt: '2026-10-19T10:00:00Z', productVersion: 'test fixture', source: 'synthetic test only', rawOutput: 'Synthetic observation, never real product evidence', reviewer: 'test', mappingRationale: 'Test expectation copied deliberately', ...fixture[i].expected }));
  return r;
}
test('pending competitor data never becomes a successful benchmark', () => {
  const r = score(template('huntr'));
  assert.equal(r.counts.pending, 15); assert.equal(r.dimensions.decision.comparable, 0);
  assert.equal(r.allCaseDecisionAgreement.denominator, 15); assert.equal(r.complete, false); assert.equal(r.ranking, null);
});
test('false recommendations and missed suitable roles are counted independently', () => {
  const r = observed();
  r.observations.find(o => o.decision === 'Conditional').decision = 'Worth reviewing';
  r.observations.find(o => fixture.find(c => c.id === o.caseId).expected.decision === 'Worth reviewing').decision = 'Low priority';
  const s = score(r);
  assert.equal(s.counts.falseRecommendations, 1); assert.equal(s.counts.missedSuitableRoles, 1);
  assert.equal(s.dimensions.decision.correct, 13);
});
test('unavailable and unmappable outputs remain visible in denominator', () => {
  const r = observed(); Object.assign(r.observations[0], {status: 'unavailable', evidence: null, direction: null, decision: null});
  r.observations[1].direction = null;
  const s = score(r); assert.equal(s.counts.unavailable, 1); assert.equal(s.dimensions.decision.comparable, 14);
  assert.equal(s.dimensions.direction.unmappable, 1); assert.equal(s.allCaseDecisionAgreement.denominator, 15);
});
test('rejects omissions, duplicates, invalid mappings and untraceable results', () => {
  for (const mutate of [r => r.observations.pop(), r => r.observations[1] = r.observations[0], r => r.observations[0].decision = '99%', r => r.observations[0].rawOutput = '', r => r.observations[0].capturedAt = 'bad']) {
    const r = observed(); mutate(r); assert.throws(() => score(r));
  }
  const pending = template('simplify'); pending.observations[0].decision = 'Worth reviewing'; assert.throws(() => score(pending));
});
test('explanation usefulness is a separate reviewer rating', () => {
  const r = observed(); r.observations[0].explanationUseful = true; r.observations[1].explanationUseful = false;
  const s = score(r); assert.equal(s.counts.explanationRated, 2); assert.equal(s.counts.explanationUseful, 1);
});
