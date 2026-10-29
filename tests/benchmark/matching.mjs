import { people, jobs, cases, version } from '../persona-v2-bank.mjs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const benchmarkVersion = `comparative-matching-v1:${version}`;
export const products = ['rolemorrow', 'huntr', 'simplify'];
export const fixture = cases.map(c => ({
  id: `${c.personId}/${c.jobId}`,
  targetRequirementId: c.requirementId ?? "r1",
  profile: people[c.personId].profile,
  job: jobs[c.jobId],
  expected: {
    evidence: c.status,
    direction: c.direction,
    decision: c.expectedCategory ?? (c.direction === 'different' ? 'Low priority' : c.status === 'supported' ? 'Worth reviewing' : 'Conditional'),
  },
}));
const values = {
  evidence: ['supported', 'partial', 'unknown'],
  direction: ['aligned', 'different', 'uncertain'],
  decision: ['Worth reviewing', 'Conditional', 'Low priority'],
};
export function template(product) {
  if (!products.includes(product)) throw Error('Unknown product');
  return { benchmarkVersion, product, observations: fixture.map(c => ({
    caseId: c.id, status: 'pending', capturedAt: null, productVersion: null,
    source: null, rawOutput: null, mappingRationale: null,
    evidence: null, direction: null, decision: null,
    explanationUseful: null, reviewer: null,
  })) };
}
function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`Missing ${name}`);
}
export function score(report) {
  if (report.benchmarkVersion !== benchmarkVersion || !products.includes(report.product)) throw Error('Unknown benchmark or product');
  if (!Array.isArray(report.observations)) throw Error('Missing observations');
  const seen = new Set();
  const counts = { total: fixture.length, pending: 0, observed: 0, unavailable: 0, unsupported: 0,
    falseRecommendations: 0, missedSuitableRoles: 0, explanationUseful: 0, explanationRated: 0 };
  const dimensions = Object.fromEntries(Object.keys(values).map(key => [key, { correct: 0, comparable: 0, unmappable: 0 }]));
  for (const o of report.observations) {
    const c = fixture.find(c => c.id === o.caseId);
    if (!c || seen.has(o.caseId)) throw Error('Unknown or duplicate case');
    seen.add(o.caseId);
    if (!['pending', 'observed', 'unavailable', 'unsupported'].includes(o.status)) throw Error('Invalid observation status');
    counts[o.status]++;
    if (o.status === 'pending') {
      if (Object.keys(values).some(key => o[key] != null) || o.explanationUseful != null) throw Error('Pending observations cannot contain scores');
      continue;
    }
    for (const key of ['capturedAt', 'productVersion', 'source', 'rawOutput', 'reviewer']) requireText(o[key], key);
    if (!Number.isFinite(Date.parse(o.capturedAt))) throw Error('Invalid capturedAt');
    if (o.status !== 'observed') {
      if (Object.keys(values).some(key => o[key] != null) || o.explanationUseful != null) throw Error('Unavailable/unsupported observations cannot contain scores');
      continue;
    }
    requireText(o.mappingRationale, 'mappingRationale');
    for (const [key, allowed] of Object.entries(values)) {
      if (o[key] == null) { dimensions[key].unmappable++; continue; }
      if (!allowed.includes(o[key])) throw Error(`Invalid ${key}`);
      dimensions[key].comparable++;
      if (o[key] === c.expected[key]) dimensions[key].correct++;
    }
    if (o.decision === 'Worth reviewing' && c.expected.decision !== 'Worth reviewing') counts.falseRecommendations++;
    if (c.expected.decision === 'Worth reviewing' && o.decision != null && o.decision !== 'Worth reviewing') counts.missedSuitableRoles++;
    if (o.explanationUseful != null) {
      if (typeof o.explanationUseful !== 'boolean') throw Error('Invalid explanation rating');
      counts.explanationRated++;
      if (o.explanationUseful) counts.explanationUseful++;
    }
  }
  if (seen.size !== fixture.length) throw Error('Every case must be explicit, including pending cases');
  return { benchmarkVersion, product: report.product, syntheticOnly: true,
    scope: 'Authored pilot expectations, not independent hiring judgments or market accuracy',
    complete: counts.pending === 0, counts, dimensions,
    allCaseDecisionAgreement: { correct: dimensions.decision.correct, denominator: fixture.length },
    ranking: null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, arg] = process.argv.slice(2);
  const result = command === 'fixtures' ? { benchmarkVersion, syntheticOnly: true, cases: fixture }
    : command === 'template' ? template(arg)
    : command === 'score' ? score(JSON.parse(await readFile(arg, 'utf8')))
    : (() => { throw Error('Usage: matching.mjs fixtures | template <product> | score <report.json>'); })();
  console.log(JSON.stringify(result, null, 2));
}
