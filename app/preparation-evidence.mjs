// Conservative source-bound blockers, not a replacement for semantic entailment review.
const sentences = (text) =>
  [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .flatMap((x) => x.segment.trim().split(/(?<=[.!?])\s+/u))
    .filter(Boolean);
const norm = (text) => text.toLowerCase().replace(/[–—]/gu, '-').replace(/\s+/gu, ' ').trim();
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const numeric = (value) => value.replace(/\s+/gu, '').toLowerCase();
const metrics = (text) =>
  [
    ...text.matchAll(
      /\d+(?:[.,]\d+)*(?:\s*[%+×]|\s+(?:(?:new|paying|active|flagged|suspicious|enterprise|direct|cross-functional|platform|professional)\s+){0,3}(?:customers?|clients?|users?|people|FTE|teams?|products?|integrations?|learners?|companies))\b|\d+(?:[.,]\d+)*\s*[%+×]/giu,
    ),
  ].map((m) => ({ value: numeric(m[0].match(/^\d+(?:[.,]\d+)*(?:\s*[%+×])?/u)[0]), text: m[0] }));
const kinds = [
  'chatbot',
  'assistant',
  'onboarding',
  'platform',
  'workflow',
  'engine',
  'dashboard',
  'application',
  'scoring',
  'API',
];
function scopeMatchers(text) {
  const result = kinds
    .map((label) => ({
      label: label.toLowerCase(),
      test: new RegExp('\\b' + label + 's?\\b', 'iu'),
    }))
    .filter((x) => x.test.test(text));
  for (const m of text.matchAll(/\b(?:project|product)\s+([\p{L}][\p{L}\d-]*)\b/giu)) {
    if (!/^[A-Z]/u.test(m[1]) || /^(?:Manager|Lead|Owner|Director)$/iu.test(m[1])) continue;
    result.push({
      label: 'named:' + m[1].toLowerCase(),
      test: new RegExp('\\b' + escaped(m[1]) + '\\b', 'iu'),
    });
  }
  return [...new Map(result.map((x) => [x.label, x])).values()];
}
const causal = (text) =>
  /\b(?:via|through|due to|thanks to|because of|by)\s+(?!\d|[$€£])/iu.exec(text);
const stop = new Set(
  'the and for with from into that this these those were was are have has had own owns owned built build led managed delivered reduced reducing improved achieved work worked working product products manager lead senior director role experience company companies team teams source stated confirmed relevant new more than including through via years months july january february march april may june august september october november december present'.split(
    ' ',
  ),
);
function words(text) {
  return new Set(
    (norm(text).match(/[\p{L}][\p{L}\d-]*/gu) ?? [])
      .map((x) =>
        x === 'clients'
          ? 'customer'
          : x === 'client'
            ? 'customer'
            : x.length > 4 && x.endsWith('s')
              ? x.slice(0, -1)
              : x,
      )
      .filter((x) => (x.length > 2 || ['ai', 'ml', 'ui', 'ux'].includes(x)) && !stop.has(x)),
  );
}
const overlap = (a, b) => [...a].filter((x) => b.has(x)).length;
export function preparationMetricIssues(inventory, profile) {
  const issues = [];
  for (const row of inventory) {
    if (
      typeof row.text !== 'string' ||
      !Array.isArray(row.citations) ||
      row.citations.some((c) => typeof c?.quote !== 'string')
    )
      continue;
    for (const part of sentences(row.text))
      for (const metric of metrics(part)) {
        const supports = [];
        for (const citation of row.citations) {
          const fact = profile.facts.find((f) => f.id === citation.factId);
          if (!fact || !metrics(citation.quote).some((x) => x.value === metric.value)) continue;
          const units = sentences(fact.text),
            matchers = scopeMatchers(fact.text);
          const identity = (scopes) => {
            const names = scopes.filter((x) => x.label.startsWith('named:'));
            return (names.length ? names : scopes)
              .map((x) => x.label)
              .sort()
              .join('|');
          };
          const identities = new Set(
            units
              .filter(
                (u) =>
                  action.test(u) ||
                  matchers.some((x) => x.label.startsWith('named:') && x.test.test(u)),
              )
              .map((u) => identity(matchers.filter((x) => x.test.test(u))))
              .filter(Boolean),
          );
          const competing = identities.size > 1;
          for (const unit of units) {
            if (
              !metrics(unit).some((x) => x.value === metric.value) ||
              !(citation.quote.includes(unit) || unit.includes(citation.quote))
            )
              continue;
            const sourceScopes = matchers.filter((x) => x.test.test(unit)),
              claimScopes = matchers.filter((x) => x.test.test(part));
            const conflict =
              competing && claimScopes.some((x) => !sourceScopes.some((y) => y.label === x.label));
            const ambiguous = competing && (sourceScopes.length === 0 || claimScopes.length === 0);
            const bridge = causal(part);
            // A novel cause cannot borrow an outcome from another sentence. Match meaningful
            // bridge anchors, allowing ordinary connectors and supported paraphrases.
            const bridgeWords = bridge
              ? words(part.slice(bridge.index + bridge[0].length))
              : new Set();
            const bridgeUnsupported =
              units.length > 1 && [...bridgeWords].some((w) => !words(unit).has(w));
            supports.push({
              valid: !conflict && !ambiguous && !bridgeUnsupported,
              scope: identity(sourceScopes),
            });
          }
        }
        if (
          supports.length &&
          (!supports.some((x) => x.valid) ||
            new Set(supports.filter((x) => x.valid).map((x) => x.scope)).size > 1)
        )
          issues.push({
            claimId: row.claimId,
            code: 'METRIC_PROJECT_SCOPE',
            message:
              'This metric must retain its source project and causal scope; another sentence in the same fact is not outcome evidence.',
            metric: metric.value,
          });
      }
  }
  return issues;
}
const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const rangePattern =
  '(' +
  monthNames.join('|') +
  ')\\s+(\\d{4})\\s*(?:-|–|—|to)\\s*(?:(' +
  monthNames.join('|') +
  ')\\s+(\\d{4})|(Present))';
const range = (text) => new RegExp(rangePattern, 'iu').exec(text);
const contextOnly =
  /\b(?:company context|context only|not (?:my|candidate|personal) (?:impact|achievement)|unconfirmed|not established)\b/iu;
const action =
  /\b(?:own(?:s|ed)?|built|led|designed|delivered|worked|partnered|managed|reduced|improved|achieved|launched|negotiated|gained|developed)\b/iu;
function roleFromFact(fact) {
  const dates = range(fact.text),
    comma = fact.text.indexOf(',');
  if (!dates || comma < 1 || comma > 120 || comma > dates.index) return null;
  const employer = fact.text
    .slice(0, comma)
    .replace(/^At\s+/iu, '')
    .trim();
  const title = fact.text
    .slice(comma + 1, dates.index)
    .replace(/\bfrom\s*$/iu, '')
    .replace(/[\s,|–—-]+$/u, '')
    .trim();
  if (!employer || !title || title.length > 150) return null;
  if (
    /^Education(?:\s*:|$)/iu.test(employer) ||
    /\b(?:degree|bachelor|master['’]s|certification)\b/iu.test(title) ||
    !/\b(?:manager|lead|analyst|architect|director|head|engineer|developer|designer|researcher|scientist|founder|owner|consultant|specialist|officer|executive|coordinator|accountant|teacher|instructor|professor|PM)\b/iu.test(
      title.split(/[—|]/u)[0],
    )
  )
    return null;
  return {
    factId: fact.id,
    employer,
    titles: title
      .split(/[—|]/u)[0]
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean),
    dateRange: dates[0],
    start:
      Number(dates[2]) * 12 +
      monthNames.findIndex((x) => x.toLowerCase() === dates[1].toLowerCase()),
    quote: fact.text,
  };
}
export function preparationEvidencePlan(profile, job) {
  const roles = profile.facts
    .map(roleFromFact)
    .filter(Boolean)
    .sort((a, b) => b.start - a.start || a.factId.localeCompare(b.factId));
  if (roles.length > 10)
    throw Object.assign(
      Error('The source profile has more dated roles than one bounded CV can contain.'),
      { status: 502 },
    );
  const jobWords = words((job?.title ?? '') + ' ' + (job?.text ?? ''));
  const achievements = profile.facts
    .flatMap((f) =>
      sentences(f.text)
        .filter((q) => action.test(q) && !contextOnly.test(q) && metrics(q).length)
        .map((quote) => ({
          factId: f.id,
          quote,
          metrics: [...new Set(metrics(quote).map((x) => x.value))],
          relevance: overlap(words(quote), jobWords),
        })),
    )
    .filter((x) => x.relevance >= 2)
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        a.factId.localeCompare(b.factId) ||
        a.quote.localeCompare(b.quote),
    )
    .slice(0, 8);
  for (const achievement of achievements) {
    const direct = roles.find((r) => r.factId === achievement.factId);
    const candidates = roles.filter((r) => namesEmployer(achievement.quote, r.employer));
    achievement.roleFactId =
      direct?.factId ?? (candidates.length === 1 ? candidates[0].factId : null);
    achievement.placement = achievement.roleFactId
      ? 'role'
      : candidates.length > 1
        ? 'unattributed'
        : 'unspecified';
  }
  return { roles, achievements };
}
const normalizeHeading = (text) =>
  norm(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const namesEmployer = (text, employer) =>
  (' ' + normalizeHeading(text) + ' ').includes(' ' + normalizeHeading(employer) + ' ');
export function preparationCoverageIssues(proposal, profile, job) {
  if (
    !job ||
    !Array.isArray(proposal?.cv?.experience) ||
    proposal.cv.experience.some(
      (g) =>
        typeof g?.heading?.text !== 'string' ||
        !Array.isArray(g.heading.citations) ||
        !Array.isArray(g.bullets) ||
        g.bullets.some((c) => typeof c?.text !== 'string' || !Array.isArray(c.citations)),
    )
  )
    return [];
  const plan = preparationEvidencePlan(profile, job),
    issues = [];
  let previous = Infinity;
  const matches = new Map();
  for (const role of plan.roles) {
    const index = proposal.cv.experience.findIndex((g) => {
      const heading = normalizeHeading(g.heading.text),
        d = range(g.heading.text),
        expected = range(role.dateRange);
      return (
        g.heading.citations.some((c) => c.factId === role.factId) &&
        (' ' + heading + ' ').includes(' ' + normalizeHeading(role.employer) + ' ') &&
        role.titles.some((t) => heading.includes(normalizeHeading(t))) &&
        d &&
        norm(d[0])
          .replace(/\bto\b/gu, '-')
          .replace(/\s/gu, '') ===
          norm(expected[0])
            .replace(/\bto\b/gu, '-')
            .replace(/\s/gu, '')
      );
    });
    const employerRoles = plan.roles.filter(
      (r) => normalizeHeading(r.employer) === normalizeHeading(role.employer),
    );
    const related = profile.facts.filter(
      (f) =>
        f.id === role.factId ||
        (employerRoles.length === 1 && namesEmployer(f.text, role.employer)),
    );
    const contributions = related.flatMap((f) =>
      sentences(f.text)
        .filter((q) => action.test(q))
        .map((q) => ({ factId: f.id, quote: q })),
    );
    const meaningful =
      index >= 0 &&
      proposal.cv.experience[index].bullets.some(
        (c) =>
          action.test(c.text) &&
          contributions.some(
            (s) =>
              c.citations.some((x) => x.factId === s.factId && x.quote.includes(s.quote)) &&
              overlap(words(c.text), words(s.quote)) >= 2,
          ),
      );
    if (index < 0 || !meaningful || (index < previous && previous !== Infinity))
      issues.push({
        claimId: null,
        code: 'CV_ROLE_COVERAGE',
        message:
          'A confirmed role needs its named dated heading, meaningful contribution and correct chronology.',
        factId: role.factId,
      });
    if (index >= 0) {
      previous = index;
      matches.set(role.factId, index);
    }
  }
  for (const requirement of plan.achievements) {
    const sourceRole = plan.roles.find((r) => r.factId === requirement.roleFactId);
    const present = proposal.cv.experience.some(
      (g, i) =>
        (!sourceRole || matches.get(sourceRole.factId) === i) &&
        (requirement.placement !== 'unattributed' || ![...matches.values()].includes(i)) &&
        g.bullets.some(
          (c) =>
            c.citations.some(
              (x) => x.factId === requirement.factId && x.quote.includes(requirement.quote),
            ) &&
            requirement.metrics.every((value) => metrics(c.text).some((x) => x.value === value)) &&
            overlap(words(c.text), words(requirement.quote)) >= 2,
        ),
    );
    if (!present)
      issues.push({
        claimId: null,
        code: 'CV_ACHIEVEMENT_COVERAGE',
        message:
          'A job-relevant quantitative source achievement is absent from the CV narrative under its confirmed role.',
        factId: requirement.factId,
        metrics: requirement.metrics,
      });
  }
  return issues;
}
