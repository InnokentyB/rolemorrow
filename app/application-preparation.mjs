import { hash } from './domain.mjs';
import { MailError } from './mail.mjs';
import { preparationMetricIssues, preparationCoverageIssues } from './preparation-evidence.mjs';
const fail = (status, message) => {
  throw new MailError(status, message);
};
const object = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export const preparationSnapshotHash = (snapshot) => hash(snapshot);
export function validatePreparationRequest(body) {
  if (
    !object(body, [
      'baseRevision',
      'revision',
      'profileVersion',
      'questions',
      'consent',
      'requestId',
    ])
  )
    fail(400, 'Use the saved profile and vacancy; unsupported preparation input.');
  if (
    !Number.isInteger(body.baseRevision) ||
    body.baseRevision < 0 ||
    !Number.isInteger(body.revision) ||
    body.revision < 0 ||
    typeof body.profileVersion !== 'string' ||
    !body.profileVersion ||
    body.profileVersion.length > 100
  )
    fail(400, 'Saved workspace, profile and packet revisions are required.');
  if (body.consent !== true) fail(400, 'Confirm use of your saved facts to prepare this draft.');
  if (
    typeof body.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.requestId,
    )
  )
    fail(400, 'A unique preparation request ID is required.');
  if (
    !Array.isArray(body.questions) ||
    body.questions.length > 10 ||
    body.questions.some((q) => typeof q !== 'string' || !q.trim() || q.length > 1000) ||
    new Set(body.questions.map((q) => q.trim())).size !== body.questions.length
  )
    fail(400, 'Supply at most ten distinct employer questions of at most 1000 characters.');
  return { ...body, questions: [...body.questions] };
}

const plainText = (value, max) =>
  typeof value === 'string' && !!value.trim() && value.length <= max;
const numericTokens = (text) => text.match(/(?:[$€£]\s*)?\d+(?:[.,]\d+)*(?:\s*[%+])?/gu) ?? [];
const dateTokens = (text) =>
  text.match(
    /\b(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/giu,
  ) ?? [];
const currencyTokens = (text) => text.match(/\b(?:USD|EUR|GBP|dollars?|euros?|pounds?)\b/giu) ?? [];
const token = (value) => value.replace(/\s+/gu, '').toLowerCase();

// The canonical job may establish the target employer's literal brand in a
// cover letter. It never establishes candidate outcomes, employment or tools.
function candidateNumericText(text, job, cover = false) {
  const company = job?.company;
  if (
    !cover ||
    typeof company !== 'string' ||
    company.length > 200 ||
    company !== company.trim() ||
    !/\p{L}/u.test(company) ||
    !/\d/u.test(company) ||
    /[\u0000-\u001f\u007f%+€$£]/u.test(company)
  )
    return text;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}%+]|[.,]\\d)', 'giu'),
    ' ',
  );
}

const protectedTerms = [
  'SQL',
  'Amplitude',
  'Mixpanel',
  'Claude Code',
  'MCP',
  'RAG',
  'Snowflake',
  'Looker',
  'Kubernetes',
  'Python',
  'JavaScript',
  'TypeScript',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'React',
  'AWS',
  'Azure',
  'GCP',
  'CISSP',
  'PMP',
  'Scrum',
  'ISO27001',
];
function unsupportedTools(text, citations) {
  const cited = citations
    .map((c) => c.quote)
    .join('\n')
    .toLowerCase();
  return protectedTerms.filter((term) => {
    const re = new RegExp('(?:^|[^a-z0-9])' + term.toLowerCase() + '(?:$|[^a-z0-9])', 'i');
    return re.test(text) && !re.test(cited);
  });
}

const metricQuestion = (text) =>
  /measur|impact|results?|improv|reduc|increas|metrics?|эффект|результат|метрик/iu.test(text);
const metricEvidence = (text) =>
  /\d+(?:[.,]\d+)?\s*(?:%|\+)|[$€£]\s*\d|\d+\s*(?:integrations?|customers?|users?|teams?|projects?|percent|million|billion)/iu.test(
    text,
  );

export function preparationEvidenceCatalog(profile) {
  if (!profile || !Array.isArray(profile.facts) || !profile.facts.length)
    fail(502, 'Saved profile facts are required for source references.');
  const result = [],
    ids = new Set();
  for (const fact of profile.facts) {
    if (
      !fact ||
      typeof fact.id !== 'string' ||
      !fact.id ||
      ids.has(fact.id) ||
      typeof fact.text !== 'string' ||
      !fact.text.trim()
    )
      fail(502, 'Invalid canonical source fact.');
    ids.add(fact.id);
    const segments =
      fact.text.length <= 1500
        ? [fact.text]
        : [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(fact.text)]
            .map((row) => row.segment.trim())
            .filter(Boolean);
    if (
      segments.some(
        (q) => q.length > 1500 || (fact.text.length > 1500 && !/[.!?]["'’”\)\]]*$/u.test(q)),
      )
    )
      fail(502, 'A source fact has an unquotable sentence.');
    const quotes = [...new Set(segments)];
    if (!quotes.length) fail(502, 'A source fact has no bounded complete quotation.');
    for (const quote of quotes) {
      if (result.length >= 256) fail(502, 'The canonical evidence catalog exceeds 256 entries.');
      // Wire identities are exact source identities, never profile-array positions.
      result.push({
        ref: 'src_' + hash([fact.id, quote]),
        factId: fact.id,
        quote,
      });
    }
  }
  return result;
}
export function resolvePreparationReferences(wire, profile, { onNormalization } = {}) {
  const invalid = () => {
    const error = new MailError(502, 'The model must select valid canonical evidence references.');
    error.code = 'PREPARATION_REFERENCE_INVALID';
    throw error;
  };
  let duplicateReferencesRemoved = 0;
  const array = (value, min, max) =>
    Array.isArray(value) && value.length >= min && value.length <= max;
  if (
    !object(wire, ['version', 'cv', 'coverLetter', 'answers']) ||
    wire.version !== 2 ||
    !object(wire.cv, ['summary', 'skills', 'experience']) ||
    !array(wire.cv.summary, 1, 4) ||
    !array(wire.cv.skills, 0, 12) ||
    !array(wire.cv.experience, 1, 10) ||
    !array(wire.coverLetter, 2, 5) ||
    !array(wire.answers, 0, 10)
  )
    invalid();
  const catalog = new Map(preparationEvidenceCatalog(profile).map((row) => [row.ref, row]));
  const claim = (value) => {
    if (
      !object(value, ['text', 'citations']) ||
      typeof value.text !== 'string' ||
      !value.text.trim() ||
      value.text.length > 1500 ||
      !array(value.citations, 1, 4)
    )
      invalid();
    for (const ref of value.citations) if (typeof ref !== 'string' || !catalog.has(ref)) invalid();
    const unique = [...new Set(value.citations)];
    duplicateReferencesRemoved += value.citations.length - unique.length;
    const citations = unique.map((ref) => {
      if (typeof ref !== 'string' || !catalog.has(ref)) invalid();
      const source = catalog.get(ref);
      return { factId: source.factId, quote: source.quote };
    });
    return { text: value.text, citations };
  };
  const seen = new Set();
  const projection = {
    version: 2,
    cv: {
      summary: wire.cv.summary.map(claim),
      skills: wire.cv.skills.map(claim),
      experience: wire.cv.experience.map((group) => {
        if (!object(group, ['heading', 'bullets']) || !array(group.bullets, 1, 8)) invalid();
        return {
          heading: claim(group.heading),
          bullets: group.bullets.map(claim),
        };
      }),
    },
    coverLetter: wire.coverLetter.map(claim),
    answers: wire.answers.map((answer) => {
      if (
        !object(answer, ['questionIndex', 'status', 'claims']) ||
        !Number.isInteger(answer.questionIndex) ||
        answer.questionIndex < 0 ||
        answer.questionIndex > 9 ||
        seen.has(answer.questionIndex) ||
        !['answered', 'unknown'].includes(answer.status) ||
        !array(
          answer.claims,
          answer.status === 'answered' ? 1 : 0,
          answer.status === 'answered' ? 5 : 0,
        )
      )
        invalid();
      seen.add(answer.questionIndex);
      return {
        questionIndex: answer.questionIndex,
        status: answer.status,
        claims: answer.claims.map(claim),
      };
    }),
  };
  if (duplicateReferencesRemoved) onNormalization?.({ duplicateReferencesRemoved });
  return projection;
}

export function preparationClaimInventory(proposal) {
  const result = [];
  const add = (claimId, claim) =>
    result.push({ claimId, text: claim.text, citations: claim.citations });
  proposal.cv.summary.forEach((claim, i) => add('cv.summary.' + i, claim));
  proposal.cv.skills.forEach((claim, i) => add('cv.skills.' + i, claim));
  proposal.cv.experience.forEach((group, i) => {
    add('cv.experience.' + i + '.heading', group.heading);
    group.bullets.forEach((claim, j) => add('cv.experience.' + i + '.bullets.' + j, claim));
  });
  proposal.coverLetter.forEach((claim, i) => add('coverLetter.' + i, claim));
  proposal.answers.forEach((answer, i) =>
    answer.claims.forEach((claim, j) => add('answers.' + i + '.claims.' + j, claim)),
  );
  return result;
}
export function validatePreparationProposal(proposal, profile, questions, job = null) {
  const invalid = (message) => fail(502, 'Invalid grounded application draft: ' + message);
  const array = (value, min, max) =>
    Array.isArray(value) && value.length >= min && value.length <= max;
  if (
    !object(proposal, ['version', 'cv', 'coverLetter', 'answers']) ||
    proposal.version !== 2 ||
    !object(proposal.cv, ['summary', 'skills', 'experience'])
  )
    invalid('structured version 2 required.');
  const facts = profile.facts;
  function claim(value, max, narrative = true, cover = false) {
    if (
      !object(value, ['text', 'citations']) ||
      !plainText(value.text, max) ||
      !array(value.citations, 1, 4)
    )
      invalid('every statement requires bounded text and citations.');
    if (
      /please review|review required|saved evidence relevant|factId|\bsource IDs?\b/iu.test(
        value.text,
      )
    )
      invalid('submission text contains preparation instructions.');

    if (narrative) {
      if (!/[.!?]["'’”\)\]]*$/u.test(value.text.trim()))
        invalid('a prose statement is incomplete.');
      const stack = [];
      for (const char of value.text) {
        if (char === '(' || char === '[') stack.push(char);
        if (char === ')' || char === ']') {
          if (stack.pop() !== (char === ')' ? '(' : '['))
            invalid('a prose statement has unbalanced brackets.');
        }
      }
      if (
        stack.length ||
        /\b(?:and|or|but|with|to|from|for|of|the|a|an|in|on|at|by|as|while|including|across|through|into|than|between|which|that|whose|because)\s*[.!?]["'’”\)\]]*$/iu.test(
          value.text.trim(),
        )
      )
        invalid('a prose statement ends with incomplete wording.');
    }
    const seen = new Set();
    for (const citation of value.citations) {
      if (
        !object(citation, ['factId', 'quote']) ||
        typeof citation.factId !== 'string' ||
        !plainText(citation.quote, 1500)
      )
        invalid('malformed source citation.');
      const source = facts.find((f) => f.id === citation.factId);
      const key = citation.factId + '\u0000' + citation.quote;
      if (!source || !source.text.includes(citation.quote) || seen.has(key))
        invalid('source quote must occur exactly in the cited saved fact.');
      seen.add(key);
    }
    const supported = new Set(value.citations.flatMap((c) => numericTokens(c.quote)).map(token));
    if (
      numericTokens(candidateNumericText(value.text, job, cover)).some(
        (n) => !supported.has(token(n)),
      )
    )
      invalid(
        'a number, date, currency or percentage is not present in this statement’s cited quotes.',
      );
    for (const extract of [dateTokens, currencyTokens]) {
      const allowed = new Set(value.citations.flatMap((c) => extract(c.quote)).map(token));
      if (extract(value.text).some((t) => !allowed.has(token(t))))
        invalid('a date or currency changes the cited source.');
    }
    if (unsupportedTools(value.text, value.citations).length)
      invalid('a named technology or credential is not supported by the cited quotes.');
    if (preparationMetricIssues([{ claimId: null, ...value }], profile).length)
      invalid('a metric changes or obscures its source project or causal scope.');
  }
  if (
    !array(proposal.cv.summary, 1, 4) ||
    !array(proposal.cv.skills, 0, 12) ||
    !array(proposal.cv.experience, 1, 10) ||
    !array(proposal.coverLetter, 2, 5) ||
    !array(proposal.answers, questions.length, questions.length)
  )
    invalid('missing sections or document bounds exceeded.');
  proposal.cv.summary.forEach((c) => claim(c, 700));

  proposal.cv.skills.forEach((c) => {
    claim(c, 120, false);
    if (c.text.trim().split(/\s+/u).length > 5 || /[:;\r\n]/u.test(c.text))
      invalid('skills must be short labels of at most five words.');
  });
  for (const group of proposal.cv.experience) {
    if (!object(group, ['heading', 'bullets']) || !array(group.bullets, 1, 8))
      invalid('experience requires a heading and grounded achievement bullets.');
    claim(group.heading, 250, false);
    group.bullets.forEach((c) => claim(c, 700));
  }

  proposal.coverLetter.forEach((c) => {
    claim(c, 1500, true, true);
    if (c.text.trim().split(/\s+/u).length > 90) invalid('a cover paragraph exceeds 90 words.');
  });
  const seen = new Set();
  for (const answer of proposal.answers) {
    if (
      !object(answer, ['questionIndex', 'status', 'claims']) ||
      !Number.isInteger(answer.questionIndex) ||
      answer.questionIndex < 0 ||
      answer.questionIndex >= questions.length ||
      seen.has(answer.questionIndex) ||
      !['answered', 'unknown'].includes(answer.status) ||
      !array(
        answer.claims,
        answer.status === 'answered' ? 1 : 0,
        answer.status === 'answered' ? 5 : 0,
      )
    )
      invalid('every employer question requires one direct answer or explicit unknown.');
    seen.add(answer.questionIndex);
    answer.claims.forEach((c) => claim(c, 1500));
    if (
      answer.status === 'answered' &&
      metricQuestion(questions[answer.questionIndex]) &&
      facts.some((f) => metricEvidence(f.text)) &&
      !answer.claims.some((c) => metricEvidence(c.text))
    )
      invalid('an answer about measurable impact omits available confirmed metrics.');
  }
  const cvTexts = new Set(
    preparationClaimInventory({
      ...proposal,
      coverLetter: [],
      answers: [],
    }).map((c) => c.text.trim().toLowerCase().replace(/\s+/gu, ' ')),
  );
  if (
    proposal.coverLetter.some((c) => cvTexts.has(c.text.trim().toLowerCase().replace(/\s+/gu, ' ')))
  )
    invalid('cover letter copies CV statements instead of a distinct argument.');
  if (preparationCoverageIssues(proposal, profile, job).length)
    invalid('the CV omits or misplaces confirmed roles or relevant quantitative achievements.');
  return proposal;
}

export function inspectPreparationProposal(proposal, profile, questions, job = null) {
  let inventory;
  try {
    inventory = preparationClaimInventory(proposal);
  } catch {
    fail(502, 'Invalid canonical application projection.');
  }
  try {
    validatePreparationProposal(proposal, profile, questions, job);
    if (job !== null)
      renderPreparation(proposal, profile, { snapshot: job }, questions, {
        method: 'nebius-grounded-documents-v2',
      });
    return { issues: [], inventory };
  } catch (error) {
    if (!(error instanceof MailError) || error.status !== 502) throw error;
    // Enumerate every numeric mismatch so one bounded repair sees the entire
    // citation problem, not only whichever statement happened to validate first.
    // Metric meaning/employer attribution remains a separate strict semantic gate.
    const catalog = preparationEvidenceCatalog(profile);
    const numericIssues = inventory.flatMap((row) => {
      if (
        typeof row.text !== 'string' ||
        !Array.isArray(row.citations) ||
        row.citations.some((cite) => typeof cite?.quote !== 'string')
      )
        return [];
      const supported = new Set(
        row.citations.flatMap((cite) => numericTokens(cite.quote)).map(token),
      );
      const numericText = candidateNumericText(
        row.text,
        job,
        row.claimId.startsWith('coverLetter.'),
      );
      const missing = [
        ...new Set(numericTokens(numericText).filter((n) => !supported.has(token(n)))),
      ].slice(0, 8);
      return missing.length
        ? [
            {
              claimId: row.claimId,
              code: 'UNSUPPORTED_NUMERIC_CITATION',
              message:
                'A number is absent from this statement’s exact cited quotes; reselect supported references or rewrite using only confirmed evidence.',
              unsupportedNumericTokens: missing,
              canonicalRefHints: missing.map((n) => ({
                token: n,
                refs: catalog
                  .filter((e) => numericTokens(e.quote).some((value) => token(value) === token(n)))
                  .slice(0, 8)
                  .map((e) => e.ref),
              })),
            },
          ]
        : [];
    });
    const toolIssues = inventory.flatMap((row) => {
      if (
        typeof row.text !== 'string' ||
        !Array.isArray(row.citations) ||
        row.citations.some((c) => typeof c?.quote !== 'string')
      )
        return [];
      const missing = unsupportedTools(row.text, row.citations).slice(0, 8);
      return missing.length
        ? [
            {
              claimId: row.claimId,
              code: 'UNSUPPORTED_TOOL_CITATION',
              message: 'A named tool is absent from this statement’s exact cited quotes.',
              unsupportedTerms: missing,
              canonicalRefHints: missing.map((term) => ({
                term,
                refs: catalog
                  .filter((e) => unsupportedTools(term, [{ quote: e.quote }]).length === 0)
                  .slice(0, 8)
                  .map((e) => e.ref),
              })),
            },
          ]
        : [];
    });
    return {
      issues: [
        { claimId: null, code: 'CONTENT_VALIDATION', message: error.message },
        ...numericIssues,
        ...toolIssues,
        ...preparationMetricIssues(inventory, profile),
        ...preparationCoverageIssues(proposal, profile, job),
      ],
      inventory,
    };
  }
}
export function validatePreparationReviewShape(review, inventory) {
  const invalid = () =>
    fail(502, 'The application draft did not pass grounded-content and completeness review.');
  if (
    !object(review, ['reviews', 'coverage', 'answersComplete', 'distinctCover']) ||
    !Array.isArray(review.reviews) ||
    review.reviews.length !== inventory.length ||
    !object(review.coverage, ['complete', 'reason']) ||
    typeof review.coverage.complete !== 'boolean' ||
    !plainText(review.coverage.reason, 1200) ||
    typeof review.answersComplete !== 'boolean' ||
    typeof review.distinctCover !== 'boolean'
  )
    invalid();
  const ids = new Set(inventory.map((c) => c.claimId)),
    seen = new Set();
  for (const row of review.reviews) {
    if (
      !object(row, ['claimId', 'supported', 'reason']) ||
      !ids.has(row.claimId) ||
      seen.has(row.claimId) ||
      typeof row.supported !== 'boolean' ||
      !plainText(row.reason, 600)
    )
      invalid();
    seen.add(row.claimId);
  }
  return review;
}
export function validatePreparationReview(review, inventory) {
  validatePreparationReviewShape(review, inventory);
  if (
    !review.coverage.complete ||
    !review.answersComplete ||
    !review.distinctCover ||
    review.reviews.some((row) => !row.supported)
  )
    fail(502, 'The application draft did not pass grounded-content and completeness review.');
  return review;
}
export function preparationProposalSchema(profile, questions) {
  const citation = {
    type: 'string',
    enum: preparationEvidenceCatalog(profile).map((row) => row.ref),
  };
  const claim = (max) => ({
    type: 'object',
    additionalProperties: false,
    required: ['text', 'citations'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: max },
      citations: { type: 'array', minItems: 1, maxItems: 4, items: citation },
    },
  });
  const claims = (min, max, length) => ({
    type: 'array',
    minItems: min,
    maxItems: max,
    items: claim(length),
  });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'cv', 'coverLetter', 'answers'],
    properties: {
      version: { type: 'integer', const: 2 },
      cv: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'skills', 'experience'],
        properties: {
          summary: claims(1, 4, 700),
          skills: claims(0, 12, 120),
          experience: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['heading', 'bullets'],
              properties: { heading: claim(250), bullets: claims(1, 8, 700) },
            },
          },
        },
      },
      coverLetter: claims(2, 5, 1500),
      answers: {
        type: 'array',
        minItems: questions.length,
        maxItems: questions.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['questionIndex', 'status', 'claims'],
          properties: {
            questionIndex: {
              type: 'integer',
              minimum: 0,
              maximum: Math.max(0, questions.length - 1),
            },
            status: { type: 'string', enum: ['answered', 'unknown'] },
            claims: claims(0, 5, 1500),
          },
        },
      },
    },
  };
}
export function preparationReviewSchema(inventory) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reviews', 'coverage', 'answersComplete', 'distinctCover'],
    properties: {
      reviews: {
        type: 'array',
        minItems: inventory.length,
        maxItems: inventory.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claimId', 'supported', 'reason'],
          properties: {
            claimId: { type: 'string', enum: inventory.map((c) => c.claimId) },
            supported: { type: 'boolean' },
            reason: { type: 'string', minLength: 1, maxLength: 600 },
          },
        },
      },
      coverage: {
        type: 'object',
        additionalProperties: false,
        required: ['complete', 'reason'],
        properties: {
          complete: { type: 'boolean' },
          reason: { type: 'string', minLength: 1, maxLength: 1200 },
        },
      },
      answersComplete: { type: 'boolean' },
      distinctCover: { type: 'boolean' },
    },
  };
}
/** @param {{method?: string}} [options] */
export function renderPreparation(proposal, profile, opportunity, questions, options = {}) {
  validatePreparationProposal(proposal, profile, questions, opportunity.snapshot);
  const { method } = options;
  const title = String(opportunity.snapshot.title ?? 'Selected vacancy'),
    company = String(opportunity.snapshot.company ?? 'Selected employer');
  const cv = ['Professional Summary', proposal.cv.summary.map((c) => c.text).join('\n\n')];
  if (proposal.cv.skills.length)
    cv.push('Skills', proposal.cv.skills.map((c) => c.text).join(' · '));
  cv.push(
    'Experience',
    proposal.cv.experience
      .map(
        (group) => group.heading.text + '\n' + group.bullets.map((c) => '• ' + c.text).join('\n'),
      )
      .join('\n\n'),
  );
  const answers = [...proposal.answers].sort((a, b) => a.questionIndex - b.questionIndex);
  const draft = {
    cvVersion: ('Adapted CV · ' + title).slice(0, 150),
    cvText: cv.join('\n\n'),
    coverLetter:
      'Re: ' +
      title +
      ' — ' +
      company +
      '\n\nDear hiring team,\n\n' +
      proposal.coverLetter.map((c) => c.text).join('\n\n') +
      '\n\nThank you for considering my application.',
    answers: answers
      .map(
        (a) =>
          'Question: ' +
          questions[a.questionIndex] +
          '\nAnswer: ' +
          (a.status === 'unknown'
            ? 'Not supplied in my saved profile.'
            : a.claims.map((c) => c.text).join('\n')),
      )
      .join('\n\n'),
  };
  if (
    draft.cvText.length > 20000 ||
    draft.coverLetter.length > 10000 ||
    draft.answers.length > 10000
  )
    fail(502, 'The preparation draft exceeds packet limits. Refine the profile or questions.');
  if (draft.coverLetter.trim().split(/\s+/u).length > 350)
    fail(502, 'The complete cover letter exceeds the 350-word limit.');
  const inventory = preparationClaimInventory(proposal);
  const evidence = [
    ...new Map(
      inventory.flatMap((c) => c.citations).map((c) => [c.factId + '\u0000' + c.quote, c]),
    ).values(),
  ];
  const result = {
    draft,
    provenance: {
      profileVersion: profile.version,
      opportunityHash: preparationSnapshotHash(opportunity.snapshot),
      method,
      evidence,
      claims: inventory,
      notes: [
        'Draft wording requires your factual and suitability review. Missing identity, contact, education or chronology is not inferred.',
      ],
    },
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024)
    fail(502, 'The prepared draft and source evidence exceed the 1 MiB result limit.');
  return result;
}
export function fixturePreparation(job, profile, questions) {
  const words = (text) =>
    new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
        (w) =>
          ![
            'the',
            'and',
            'with',
            'you',
            'your',
            'have',
            'what',
            'that',
            'this',
            'from',
            'for',
            'are',
            'our',
            'can',
            'how',
            'experience',
          ].includes(w),
      ),
    );
  const score = (text, fact) => {
    const tokens = words(text);
    return [...words(fact.text)].filter((w) => tokens.has(w)).length;
  };
  const ranked = [...profile.facts].sort(
    (a, b) => score(job.title + ' ' + job.text, b) - score(job.title + ' ' + job.text, a),
  );
  const first = ranked[0],
    second = ranked[1] ?? first;
  const claim = (text, fact) => ({
    text,
    citations: [{ factId: fact.id, quote: fact.text }],
  });

  const complete = (text) => (/[.!?]["'’”\)\]]*$/u.test(text.trim()) ? text : text + '.');
  const concise = (f) => {
    if (f.text.length <= 600) return complete(f.text);
    const sentence = f.text.match(/[^.!?\n]+[.!?]/u)?.[0]?.trim();
    if (sentence && sentence.length <= 600) return sentence;
    fail(502, 'The deterministic fixture needs bounded source sentences.');
  };
  return {
    version: 2,
    cv: {
      summary: [claim(concise(first), first)],
      skills: [
        ...new Map(
          ranked.flatMap((f) =>
            [
              'Python',
              'PostgreSQL',
              'Kubernetes',
              'SQL',
              'JavaScript',
              'TypeScript',
              'MySQL',
              'MongoDB',
              'React',
              'AWS',
              'Azure',
              'GCP',
            ]
              .filter((term) =>
                new RegExp('(?:^|[^a-z0-9])' + term + '(?:$|[^a-z0-9])', 'i').test(f.text),
              )
              .map((term) => [term.toLowerCase(), claim(term, f)]),
          ),
        ).values(),
      ].slice(0, 12),
      experience: ranked.slice(0, 6).map((f) => ({
        heading: claim('Selected experience', f),
        bullets: [claim(concise(f), f)],
      })),
    },
    coverLetter: [
      claim('My background includes this relevant work: ' + concise(second), second),
      claim('I would bring the following experience to the role: ' + concise(first), first),
    ],
    answers: questions.map((question, questionIndex) => {
      const found = [...profile.facts].sort((a, b) => score(question, b) - score(question, a));
      let relevant = found.filter((f) => score(question, f) > 0).slice(0, 2);
      if (/certif|licen[cs]|accredit|degree|qualification/iu.test(question))
        relevant = relevant.filter((f) =>
          /certif|licen[cs]|accredit|degree|qualification/iu.test(f.text),
        );
      if (metricQuestion(question) && profile.facts.some((f) => metricEvidence(f.text))) {
        const quantified = relevant.filter((f) => metricEvidence(f.text));
        relevant = quantified.length ? quantified : [];
      }
      return {
        questionIndex,
        status: relevant.length ? 'answered' : 'unknown',
        claims: relevant.map((f) => claim(complete(f.text), f)),
      };
    }),
  };
}
