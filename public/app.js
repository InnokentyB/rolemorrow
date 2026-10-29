import { compareResults, evidenceSummary } from './matching.js';
import { initMail } from './mail.js';
import { initOrganizationCatalog } from './organization-catalog.js';
const $ = (s) => document.querySelector(s);
let state = null,
  dirty = false,
  loading = false,
  poll = null,
  reauthNeeded = false,
  workspaceAccountId = null;
const expandedJobs = new Set();
const decisionDrafts = new Map();
const organizationUI = initOrganizationCatalog({
  request: (...args) => api(...args),
  onChoose: (organization) => {
    const input = $('#company-sources'),
      lines = input.value
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    const domain = (value) => {
      try {
        return new URL(value).hostname.replace(/^www\./, '');
      } catch {
        return null;
      }
    };
    if (lines.some((line) => domain(line.split('|')[1]?.trim()) === organization.domain)) {
      notice('This company is already in your source draft.');
      return false;
    }
    if (lines.length >= 5) {
      notice('Choose at most five companies for each check.', true);
      return false;
    }
    lines.push(
      `${organization.name} | ${organization.homepage} | ${organization.careers} | ${organization.industry}`,
    );
    input.value = lines.join('\n');
    dirty = true;
    $('#consent').checked = false;
    updateScanReadiness();
    input.focus();
    return true;
  },
});
const example = {
  facts: [
    { id: 'f1', text: 'Led AI product evaluation and API platform launches.' },
    { id: 'f2', text: 'Built B2B fintech onboarding.' },
  ],
  goal: {
    roles: 'Product Manager',
    industries: 'AI, fintech',
    country: 'Portugal',
    workMode: 'remote',
  },
};
const exampleCompanies = [
  {
    name: 'Northstar',
    homepage: 'https://northstar.example',
    careers: 'https://northstar.example/careers',
    industry: 'AI',
  },
  {
    name: 'Fieldwork',
    homepage: 'https://fieldwork.example',
    careers: 'https://fieldwork.example/careers',
    industry: 'fintech',
  },
  {
    name: 'Meridian',
    homepage: 'https://meridian.example',
    careers: 'https://meridian.example/careers',
    industry: 'AI',
  },
];
function notice(text, error = false) {
  $('#notice').textContent = text;
  $('#notice').classList.toggle('error', error);
  if (reauthNeeded) {
    const link = document.createElement('a');
    link.href = '/account';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Sign in in a new tab';
    $('#notice').append(document.createTextNode(' '), link);
  }
}
async function api(path, body, method = 'POST') {
  if (workspaceAccountId && reauthNeeded) {
    const identityResponse = await fetch('/api/account/me', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (identityResponse.status === 401)
      throw Error('Please sign in in a new tab, then retry this action.');
    if (!identityResponse.ok)
      throw Error('Could not confirm your account. Keep this tab open and retry.');
    let identity;
    try {
      identity = await identityResponse.json();
    } catch {
      throw Error('Could not confirm your account. Keep this tab open and retry.');
    }
    if (identity.user?.id !== workspaceAccountId) {
      resetAudit();
      throw Error(
        'A different account is signed in. Sign in to the original account to keep these drafts, or reload this tab to discard them and open the other workspace.',
      );
    }
  }
  const r = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(workspaceAccountId ? { 'X-Rolemorrow-Account-ID': workspaceAccountId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.status === 401) {
    if (!state) {
      location.assign('/account');
      throw Error('Please sign in again.');
    }
    reauthNeeded = true;
    resetAudit();
    throw Error(
      'Your session expired. Keep this tab open to preserve your edits. Sign in in a new tab, then retry this action.',
    );
  }
  if (r.status === 409 && r.headers.get('X-Rolemorrow-Account-Mismatch') === '1') {
    reauthNeeded = true;
    resetAudit();
    throw Error(
      'A different account is signed in. Sign in to the original account to keep these drafts, or reload this tab to discard them and open the other workspace.',
    );
  }
  if (r.ok) reauthNeeded = false;
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error('Could not read the server response. Retry.');
  }
  if (!r.ok) throw Error(data.error ?? 'Action failed.');
  if (data.publicService && !workspaceAccountId) {
    workspaceAccountId = r.headers.get('X-Rolemorrow-Account-ID');
    if (!workspaceAccountId) {
      const identityResponse = await fetch('/api/account/me', { cache: 'no-store' });
      if (!identityResponse.ok)
        throw Error('Could not confirm your account. Reload after signing in.');
      const identity = await identityResponse.json();
      if (!identity.user?.id)
        throw Error('Could not confirm your account. Reload after signing in.');
      workspaceAccountId = identity.user.id;
    }
  }
  return data;
}
function activate(next) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== next + '-view';
  for (const b of document.querySelectorAll('[data-tab]')) {
    if (b.dataset.tab === next) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const heading = $('#' + next + '-view h2');
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}
function renderJourney() {
  let next, title, description, label;
  if (!state.profile) {
    next = 'profile';
    title = 'Start with your experience';
    description = 'Save confirmed facts and a target role, or explore the fictional example.';
    label = 'Build your profile';
  } else if (!state.companies.length) {
    next = 'companies';
    title = 'Choose where to look';
    description = 'Add official employer careers pages to build your shortlist.';
    label = 'Choose employers';
  } else if (!state.run || state.run.stale) {
    next = 'companies';
    title = state.run ? 'Refresh your shortlist' : 'Ready to check employers';
    description = state.run
      ? 'Your inputs or assessment rules changed. Saved decisions remain available.'
      : 'Your profile and employers are saved. Choose a search mode and start the check.';
    label = 'Check employers';
  } else if (state.run.status === 'running') {
    next = 'results';
    title = 'Employer check in progress';
    description = 'Review incoming results or cancel the check in Results.';
    label = 'View progress';
  } else if (!state.run.results.length) {
    next = 'companies';
    title = 'Review the check before trying again';
    description = 'Source coverage explains what was checked and what remains unavailable.';
    label = 'Review employer sources';
  } else if (!state.opportunities.length) {
    next = 'results';
    title = 'Find a role worth exploring';
    description =
      'Compare cited experience and missing evidence, then save a role to keep your next steps.';
    label = 'Review your matches';
  } else if (!state.applications.length) {
    next = 'applications';
    title = 'Prepare a saved opportunity';
    description =
      'Keep a CV version, cover letter and answers together. Saving a packet does not submit it.';
    label = 'Prepare an application';
  } else {
    next = 'inbox';
    title = 'Keep the conversation with the role';
    description =
      'Review correspondence and next actions. Received replies and saved drafts stay with your opportunity.';
    label = 'Review your inbox';
  }
  $('#journey-title').textContent = title;
  $('#journey-description').textContent = description;
  const button = $('#journey-action');
  button.textContent = label;
  button.disabled = loading;
  button.onclick = () => activate(next);
}
function fillInputs() {
  const p = state.profile;
  $('#facts').value = p?.facts.map((f) => f.text).join('\n') ?? '';
  $('#roles').value = p?.goal.roles ?? '';
  $('#industries').value = p?.goal.industries ?? '';
  $('#country').value = p?.goal.country ?? '';
  $('#work-mode').value = p?.goal.workMode ?? 'remote';
  const pref = p?.preferences;
  $('#career-priority').value = pref?.careerPriority ?? 'content';
  $('#leadership-required').checked = pref?.leadershipRequired === true;
  $('#relocations').value =
    pref?.relocations?.map((r) => r.country + (r.tentative ? '?' : '')).join('\n') ?? '';
  $('#office-policy').value = pref?.officePolicy ?? 'neutral';
  $('#salary-country').value = pref?.salary?.country ?? p?.goal.country ?? '';
  $('#salary-currency').value = pref?.salary?.currency ?? 'EUR';
  $('#salary-min').value = pref?.salary?.targetMin ?? '';
  $('#salary-max').value = pref?.salary?.targetMax ?? '';
  $('#salary-basis').value = pref?.salary?.basis ?? 'pending';
  $('#salary-policy').value = pref?.salary?.policy ?? 'pending';
  $('#salary-unknown').value = pref?.salary?.unknownPolicy ?? 'pending';
  $('#preferred-themes').value = pref?.preferredThemes?.join(', ') ?? '';
  $('#preferred-industries').value = pref?.preferredIndustries?.join(', ') ?? '';
  $('#disfavored-industries').value = pref?.disfavoredIndustries?.join(', ') ?? '';
  $('#themes-confirmed').checked = pref?.themesConfirmed === true;
  $('#industries-confirmed').checked = pref?.industriesConfirmed === true;
  $('#company-sources').value = state.companies
    .map((c) => `${c.name} | ${c.homepage} | ${c.careers} | ${c.industry}`)
    .join('\n');
  dirty = false;
}
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== null && text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function evidenceRow(item, requirement, saved = false) {
  const row = node('div', null, 'evidence-row');
  const label =
    item.status === 'supported'
      ? 'Supported'
      : item.status === 'partial'
        ? 'Partial evidence'
        : item.status === 'gap'
          ? 'Gap'
          : 'Unknown';
  row.append(
    node(
      'strong',
      saved
        ? label
        : `${label} · ${requirement?.core ? 'Core requirement' : 'Additional requirement'}`,
    ),
    node('p', 'Job requirement', 'evidence-label'),
    node('blockquote', requirement?.text ?? item.jobQuote),
  );
  if (item.status === 'partial')
    row.append(
      node('p', 'Supported part', 'evidence-label'),
      node('blockquote', item.jobQuote),
      node('p', 'Not yet established', 'evidence-label'),
      node('blockquote', item.unconfirmedQuote),
    );
  if (item.profileQuote)
    row.append(
      node(
        'p',
        `${saved ? 'Profile at assessment' : 'Your profile'} · ${item.factId}`,
        'evidence-label',
      ),
      node('blockquote', item.profileQuote),
    );
  else row.append(node('p', 'No confirmed profile fact establishes this requirement.', 'help'));
  return row;
}
function renderResults() {
  const run = state.run;
  $('#stale').hidden = !run?.stale;
  $('#coverage').replaceChildren();
  $('#results').replaceChildren();
  $('#run-state').replaceChildren();
  $('#result-tools').hidden = !run?.results.length;
  if (!run) {
    $('#mode-label').textContent = 'No check yet · choose a search mode';
    $('#run-summary').textContent = 'Save a profile and select companies to begin.';
    $('#results').append(
      node('p', 'Your shortlist will appear here, with sources and reasons.', 'empty'),
    );
    const start = node(
      'button',
      state.profile ? 'Choose employer sources' : 'Build a search profile',
      'secondary',
    );
    start.onclick = () => activate(state.profile ? 'companies' : 'profile');
    $('#results').append(start);
    return;
  }
  $('#run-summary').textContent =
    `${run.mode === 'fixture' ? 'Fictional example' : run.mode === 'manual' ? 'User-supplied descriptions' : 'Live check'} · ${run.results.length} listings · ${new Date(run.startedAt).toLocaleString()}`;
  $('#mode-label').textContent =
    run.mode === 'fixture'
      ? 'Fictional example · no external requests'
      : run.mode === 'manual'
        ? 'User-supplied text · no external requests'
        : 'Live provider check · external requests';
  const boundedOnly =
    run.mode === 'live' &&
    run.coverage.length > 0 &&
    run.coverage.every((c) => c.measurement && c.measurement.failures === 0) &&
    run.results.every((r) => !r.error);
  const statuses = {
    running: `Checking companies… ${run.completedCompanies} of ${run.coverage.length} finished.`,
    complete: 'Check complete.',
    partial: boundedOnly
      ? 'Bounded check complete. Employer-wide coverage remains partial; review the source counts and any uninspected listings.'
      : 'Partial check. Some sources or assessments need attention.',
    failed: 'Check failed. Review source coverage and retry.',
    cancelled: 'Check cancelled. Only completed results are shown.',
  };
  $('#run-state').append(node('p', statuses[run.status] ?? run.status, 'run-status'));
  if (run.note) $('#run-state').append(node('p', run.note, 'help'));
  for (const c of run.coverage) {
    const row = node('div', null, 'coverage-row');
    row.append(
      node('strong', c.company),
      node('span', `${c.status} · ${c.count} listings`),
      node(
        'p',
        c.note ||
          (c.status === 'pending'
            ? 'Waiting to check this company.'
            : c.status === 'checked'
              ? 'Source checked. Review the evidence below.'
              : 'Check incomplete. Review source coverage.'),
      ),
    );
    $('#coverage').append(row);
  }
  const filter = $('#filter').value;
  const search = $('#result-search').value.trim().toLowerCase();
  const rows = run.results.filter(
    (r) =>
      (filter === 'all' || (filter === 'unassessed' && !r.assessment) || r.category === filter) &&
      (!search || `${r.title} ${r.company}`.toLowerCase().includes(search)),
  );
  rows.sort(compareResults);
  for (const r of rows) {
    const article = node('article', null, 'vacancy');
    const top = node('div', null, 'job-top');
    const cls =
      r.category === 'Worth reviewing'
        ? 'strong'
        : r.category === 'Conditional'
          ? 'conditional'
          : r.assessment
            ? 'low'
            : 'error';
    top.append(
      node('span', r.company, 'employer'),
      node('span', r.category ?? 'Assessment unavailable', `category ${cls}`),
    );
    article.append(top, node('h3', r.title));
    const overview = node('p', r.salary ?? 'Salary not stated', 'job-overview');
    article.append(overview);
    const toggle = node(
      'button',
      expandedJobs.has(r.key) ? 'Hide job details' : 'Show job details',
      'text-button job-toggle',
    );
    const detailBody = node('div', null, 'job-detail');
    detailBody.id = 'job-' + run.results.indexOf(r);
    detailBody.hidden = !expandedJobs.has(r.key);
    toggle.setAttribute('aria-controls', detailBody.id);
    toggle.setAttribute('aria-expanded', String(!detailBody.hidden));
    toggle.onclick = () => {
      detailBody.hidden = !detailBody.hidden;
      if (detailBody.hidden) expandedJobs.delete(r.key);
      else expandedJobs.add(r.key);
      toggle.textContent = detailBody.hidden ? 'Show job details' : 'Hide job details';
      toggle.setAttribute('aria-expanded', String(!detailBody.hidden));
    };
    article.append(toggle);
    const save = node(
      'button',
      r.opportunityId ? 'View saved job' : 'Save job',
      'secondary save-job',
    );
    save.disabled = loading;
    save.onclick = () =>
      r.opportunityId
        ? openSaved(r.opportunityId)
        : action(async () => {
            state = await api('/api/opportunities', {
              resultKey: r.key,
              baseRevision: state.revision,
            });
            notice('Job saved. Your decisions will stay between searches.');
          });
    article.append(save);
    const audit = node('button', 'Decision history', 'text-button');
    audit.onclick = () => openAudit({ vacancyKey: r.auditVacancyKey });
    article.append(audit);
    if (r.assessment) {
      const fit = r.evidenceFit ?? evidenceSummary(r);
      detailBody.append(node('p', fit.level, 'evidence-level'));
      if (r.clarifications?.length) {
        const clarify = node('details', null, 'clarifications');
        clarify.append(node('summary', `What to clarify (${r.clarifications.length})`));
        const list = node('ul');
        for (const question of r.clarifications) list.append(node('li', question.question));
        clarify.append(list);
        detailBody.append(clarify);
      }
      const dimensions = node('div', null, 'dimensions');
      for (const [label, text] of [
        ['Experience', r.experience],
        ['Career goal', r.direction],
        ['Role level', r.levelReview?.text ?? 'Earlier assessment: role level was not reviewed.'],
        ['Conditions', r.constraints],
      ]) {
        const line = node('div', null, 'dimension');
        line.append(node('strong', label), node('p', text));
        dimensions.append(line);
      }
      detailBody.append(dimensions);
    } else detailBody.append(node('p', r.error, 'warning'));
    const meta = node('div', null, 'job-meta');
    meta.append(
      node('span', r.salary ?? 'Salary not stated'),
      node('span', new Date(r.source.checkedAt).toLocaleDateString()),
    );
    if (r.source.authority === 'user-supplied unverified') {
      meta.append(node('span', 'User-supplied · unverified'));
      const link = node('a', 'Open supplied URL (unverified)');
      link.href = r.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      meta.append(link);
    } else if (run.mode === 'fixture')
      meta.append(node('span', 'Fictional source · not a live vacancy'));
    else {
      const link = node('a', 'Open employer source');
      link.href = r.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      meta.append(link);
    }
    detailBody.append(meta);
    if (r.preferenceBand) {
      detailBody.append(node('p', r.preferenceBand, 'preference-band'));
      for (const note of r.preferenceNotes ?? []) detailBody.append(node('p', note, 'help'));
    }
    article.append(detailBody);
    if (r.assessment) {
      const detail = node('details');
      detail.append(node('summary', 'Review evidence'));
      detail.addEventListener('toggle', () => {
        if (detail.open && detailBody.hidden) toggle.click();
      });
      for (const item of r.assessment.rows)
        detail.append(
          evidenceRow(
            item,
            r.requirements.find((q) => q.id === item.requirementId),
          ),
        );
      detail.append(node('p', `Source: ${r.source.url}`, 'help'));
      article.append(detail);
    }
    if (r.source.authority === 'user-supplied unverified') {
      const detail = node('details');
      detail.append(node('summary', 'Read supplied text'), node('p', r.text));
      article.append(detail);
    }
    $('#results').append(article);
  }
  if (!rows.length)
    $('#results').append(
      node(
        'p',
        run.status === 'running'
          ? 'Results will appear as each company finishes.'
          : run.results.length
            ? 'No results match these filters. Clear the search or choose All recommendations.'
            : 'No verified listings to assess. Review coverage above; unavailable sources are not empty searches.',
        'empty',
      ),
    );
  if (!rows.length && run.results.length) {
    const reset = node('button', 'Clear result filters', 'secondary');
    reset.onclick = () => {
      $('#result-search').value = '';
      $('#filter').value = 'all';
      renderResults();
    };
    $('#results').append(reset);
  }
}
const stageLabels = {
  saved: 'Saved',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  archived: 'Archived',
};
function openSaved(id) {
  $('#saved-search').value = '';
  $('#saved-stage').value = 'all';
  activate('saved');
  renderSaved(true);
  document.getElementById('saved-' + id)?.scrollIntoView({ block: 'nearest' });
}
function renderSaved(force = false) {
  if (decisionDrafts.size && !force) return;
  const root = $('#saved-jobs');
  const opened = new Set(
    [...root.querySelectorAll('.saved-job')]
      .filter((a) => a.querySelector('.decision-detail')?.open)
      .map((a) => a.id),
  );
  root.replaceChildren();
  const all = state.opportunities ?? [];
  const query = $('#saved-search').value.trim().toLowerCase(),
    stage = $('#saved-stage').value;
  const items = all
    .filter(
      (o) =>
        (stage === 'all' || o.stage === stage) &&
        (!query || `${o.snapshot.title} ${o.snapshot.company}`.toLowerCase().includes(query)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!items.length) {
    root.append(
      node(
        'p',
        all.length
          ? 'No saved jobs match these filters.'
          : 'Save a vacancy link above or a job from Results to keep your decisions between searches.',
        'empty',
      ),
    );
    return;
  }
  for (const o of items) {
    const r = o.snapshot;
    const article = node('article', null, 'saved-job');
    article.id = 'saved-' + o.id;
    const top = node('div', null, 'job-top');
    top.append(
      node('span', r.company, 'employer'),
      node('span', stageLabels[o.stage], 'category low'),
    );
    article.append(top, node('h3', r.title));
    const source =
      o.runMode === 'fixture'
        ? node('span', 'Fictional source · not a live vacancy')
        : node(
            'a',
            r.source.authority === 'user-supplied unverified'
              ? 'Open supplied URL (unverified)'
              : 'Open employer source',
          );
    if (o.runMode !== 'fixture') {
      source.href = r.url;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
    }
    const meta = node('div', null, 'job-meta');
    meta.append(
      source,
      node(
        'span',
        o.runMode === 'fixture'
          ? 'Fictional example'
          : r.source.authority === 'user-supplied unverified'
            ? 'User-supplied · unverified'
            : 'Employer source',
      ),
      node('span', `Observed ${new Date(o.latestObservedAt).toLocaleDateString()}`),
    );
    article.append(meta);
    article.append(
      node(
        'p',
        o.nextAction
          ? `Next: ${o.nextAction}${o.dueDate ? ' · ' + o.dueDate : ''}`
          : 'No next action yet.',
        'saved-next',
      ),
    );
    const sourceCheck = node('section', null, 'saved-source-check');
    const check = node('button', 'Check vacancy source', 'secondary');
    check.disabled = loading || r.source.authority === 'user-supplied unverified';
    check.onclick = () =>
      action(async () => {
        notice('Checking saved vacancy source… No profile is transmitted.');
        state = await api('/api/opportunities/' + o.id + '/recheck', { consent: true });
        notice('Source check saved. Original assessment and your decision are unchanged.');
      });
    sourceCheck.append(
      check,
      node(
        'p',
        o.runMode === 'fixture'
          ? 'Fictional source check; no external requests.'
          : 'Checks only the saved public URL. No profile or packet is transmitted.',
        'help',
      ),
    );
    if (o.sourceCheck) {
      sourceCheck.append(
        node(
          'p',
          `${o.sourceCheck.status} · ${new Date(o.sourceCheck.checkedAt).toLocaleString()}`,
          'source-check-status',
        ),
        node('p', o.sourceCheck.note, 'help'),
      );
      const history = node('details');
      history.append(node('summary', 'Source check history'));
      for (const observation of [...(o.sourceCheckHistory ?? [])].reverse())
        history.append(
          node(
            'p',
            `${new Date(observation.checkedAt).toLocaleString()} · ${observation.status} · ${observation.note}`,
            'help',
          ),
        );
      sourceCheck.append(history);
      if (o.sourceReviewRequired) {
        const reviewed = node('button', 'Mark source reviewed', 'text-button');
        reviewed.disabled = loading;
        reviewed.onclick = () =>
          action(async () => {
            state = await api('/api/opportunities/' + o.id + '/source-review', {
              sourceCheckRevision: o.sourceCheckRevision,
            });
            notice('Source marked reviewed. Fit assessment and packet are unchanged.');
          });
        sourceCheck.append(
          reviewed,
          node(
            'p',
            'Acknowledges this source observation only; the assessment and packet are unchanged.',
            'help',
          ),
        );
      }
      if (o.sourceCheck.missingSavedRequirements?.length) {
        const missing = node('details');
        missing.append(node('summary', 'Saved requirement wording not found'));
        for (const text of o.sourceCheck.missingSavedRequirements)
          missing.append(node('blockquote', text));
        sourceCheck.append(missing);
      }
      if (o.sourceCheck.excerpt) {
        const excerpt = node('details');
        excerpt.append(
          node('summary', 'Latest readable page excerpt'),
          node('blockquote', o.sourceCheck.excerpt),
          node(
            'p',
            'Page changes may include navigation or benefits. Compare the employer requirements before revising your packet.',
            'help',
          ),
        );
        sourceCheck.append(excerpt);
      }
    }
    article.append(sourceCheck);
    if (r.source.intakeMethod) {
      article.append(node('p', r.error, 'help'));
      if (r.text) {
        const description = node('details');
        description.append(node('summary', 'Saved public description'), node('p', r.text));
        article.append(description);
      }
    }
    article.append(
      node(
        'p',
        `Last assessment: ${r.category ?? 'Unavailable'} · ${r.salary ?? 'Salary not stated'}`,
        'help',
      ),
    );
    if (r.assessment && (o.assessmentStale ?? r.profileVersion !== state.profile?.version))
      article.append(
        node(
          'p',
          'Saved assessment uses earlier inputs or assessment rules. Run a new check before relying on it.',
          'warning',
        ),
      );
    if (r.levelReview) article.append(node('p', `Role level: ${r.levelReview.text}`, 'help'));
    if (r.assessment) {
      const evidence = node('details');
      evidence.append(node('summary', 'Saved assessment evidence'));
      for (const row of r.assessment.rows)
        evidence.append(
          evidenceRow(
            row,
            r.requirements.find((q) => q.id === row.requirementId),
            true,
          ),
        );
      article.append(evidence);
    } else article.append(node('p', r.error ?? 'Assessment unavailable.', 'help'));
    const detail = node('details', null, 'decision-detail');
    detail.open = decisionDrafts.has(o.id) || opened.has('saved-' + o.id);
    detail.append(node('summary', 'Your decision & next action'));
    const form = node('form', null, 'decision-form');
    const draft = decisionDrafts.get(o.id) ?? {
      stage: o.stage,
      note: o.note,
      nextAction: o.nextAction,
      dueDate: o.dueDate,
      decisionRevision: o.decisionRevision,
    };
    for (const [key, labelText, type] of [
      ['stage', 'Application stage', 'select'],
      ['note', 'Private note', 'textarea'],
      ['nextAction', 'Next action', 'input'],
      ['dueDate', 'Action date', 'input'],
    ]) {
      const group = node('div');
      const input = node(type);
      input.id = `${o.id}-${key}`;
      input.name = key;
      if (type === 'select')
        for (const [value, label] of Object.entries(stageLabels)) {
          const option = node('option', label);
          option.value = value;
          input.append(option);
        }
      if (key === 'dueDate') input.type = 'date';
      if (key === 'note') {
        input.rows = 3;
        input.maxLength = 4000;
      }
      if (key === 'nextAction') input.maxLength = 500;
      input.value = draft[key];
      const label = node('label', labelText);
      label.htmlFor = input.id;
      input.oninput = () => {
        draft[key] = input.value;
        decisionDrafts.set(o.id, draft);
      };
      group.append(label, input);
      form.append(group);
    }
    const controls = node('div', null, 'decision-actions');
    const save = node('button', 'Save decision');
    save.type = 'submit';
    save.disabled = loading;
    const reload = node('button', 'Discard draft and reload', 'text-button');
    reload.type = 'button';
    reload.onclick = () =>
      action(async () => {
        const fresh = await api('/api/state', undefined, 'GET');
        decisionDrafts.delete(o.id);
        state = fresh;
        renderSaved(true);
        notice('Saved jobs reloaded. Draft discarded.');
      });
    controls.append(save, reload);
    form.append(controls);
    form.onsubmit = (e) => {
      e.preventDefault();
      const body = { decisionRevision: draft.decisionRevision };
      for (const input of form.elements) if (input.name) body[input.name] = input.value;
      decisionDrafts.set(o.id, { ...body });
      action(async () => {
        state = await api('/api/opportunities/' + o.id, body);
        decisionDrafts.delete(o.id);
        notice('Decision saved.');
        renderSaved(true);
      });
    };
    detail.append(form);
    article.append(detail);
    const conversation = node('button', 'Prepare application / correspondence', 'text-button');
    conversation.onclick = () => {
      mailUI.select(o.id);
      activate('applications');
    };
    article.append(conversation);
    const audit = node('button', 'Decision history', 'text-button');
    audit.onclick = () => openAudit({ opportunityId: o.id });
    article.append(audit);
    const history = node('details');
    history.append(node('summary', 'Stage history'));
    for (const event of o.events)
      history.append(
        node(
          'p',
          `${new Date(event.at).toLocaleString()} · ${stageLabels[event.stage]} · reported by you`,
          'help',
        ),
      );
    article.append(history);
    root.append(article);
  }
}
function renderNextActions() {
  const root = $('#next-actions');
  root.replaceChildren();
  const items = (state.nextActions ?? []).filter((item) => item.kind !== 'message');
  for (const item of items) {
    const row = node('article', null, 'attention-item');
    row.append(node('h3', item.title), node('p', `${item.company} · ${item.role}`));
    const open = node(
      'button',
      item.target === 'saved' ? 'Review saved role' : 'Open application packet',
      'secondary',
    );
    open.onclick = () => {
      if (item.target === 'saved') openSaved(item.opportunityId);
      else if (mailUI.select(item.opportunityId)) activate('applications');
    };
    row.append(open);
    root.append(row);
  }
  if (!items.length)
    root.append(node('p', 'No saved-role actions. Correspondence actions appear below.', 'empty'));
}
function render() {
  if (!state) return;
  organizationUI.show(Boolean(state.publicService));
  $('#account-link').hidden = !state.publicService;
  $('#workspace-storage').textContent = state.publicService
    ? 'Account workspace · saved on the server'
    : 'Local workspace · synthetic examples by default';
  if (state.publicService) {
    $('#delete').textContent = 'Clear workspace';
    $('#delete-confirm p').textContent =
      'Clear the profile, saved jobs, correspondence and files in your account? Your sign-in account remains. Receiving is paused after clearing.';
  }
  $('#brief-role').textContent = state.profile?.goal.roles ?? 'Not set';
  $('#brief-country').textContent = state.profile?.goal.country ?? 'Not set';
  $('#brief-companies').textContent = state.companies.length
    ? state.companies.map((c) => c.name).join(', ')
    : 'None selected';
  renderJourney();
  const questions = state.intakeQuestions ?? [];
  $('#intake-questions').hidden = !questions.length;
  $('#intake-questions ul').replaceChildren(...questions.map((q) => node('li', q)));
  const live = $('#mode option[value=live]');
  live.disabled = !state.config.liveReady;
  live.textContent = state.config.liveReady
    ? 'Live sources + NVIDIA — sends saved profile'
    : 'Live sources + NVIDIA — not configured';
  $('#live-note').textContent = state.config.liveReady
    ? 'Live checks send the saved profile and goal to Nebius. Public-source search queries go to Tavily.'
    : 'Live checking is disabled until server access, API keys and an explicit NVIDIA model are configured.';
  const manual = $('#manual-company');
  if (
    [...manual.options].map((o) => o.value).join('|') !==
    state.companies.map((c) => c.name).join('|')
  )
    manual.replaceChildren(
      ...state.companies.map((c) => {
        const o = node('option', c.name);
        o.value = c.name;
        return o;
      }),
    );
  for (const b of document.querySelectorAll(
    'form button,#example,#confirm-delete,.saved-source-check button',
  ))
    b.disabled = loading || b.dataset.locked === 'true';
  const running = state.run?.status === 'running';
  updateScanReadiness();
  $('#cancel').hidden = !running;
  renderResults();
  renderSaved();
  mailUI.render();
  renderNextActions();
  clearTimeout(poll);
  if (running) poll = setTimeout(refresh, 350);
}
function updateScanReadiness() {
  if (!state) return;
  const reason = loading
    ? 'Please wait for the current action.'
    : state.run?.status === 'running'
      ? 'A check is running. View progress in Results.'
      : !state.profile
        ? 'Save your profile before checking employers.'
        : !state.companies.length
          ? 'Save at least one employer source before checking.'
          : dirty
            ? 'Save your edited profile or employer sources before checking.'
            : $('#mode').value === 'live' && !state.config.liveReady
              ? 'Live checking is unavailable. Choose the fictional example or try again later.'
              : $('#mode').value === 'live' && !$('#consent').checked
                ? 'Approve profile sharing above to start a live check.'
                : '';
  $('#scan').disabled = Boolean(reason);
  $('#scan-help').textContent =
    reason || 'Ready to check your saved profile against these employer sources.';
  $('#search-budget').textContent =
    `Live checks assess up to ${state.config.liveMaxJobsPerCompany ?? 20} listings per company. A limit does not mean all open roles were assessed.`;
}
async function refresh() {
  try {
    const previous = state?.run;
    state = await api('/api/state', undefined, 'GET');
    if (
      previous?.status === 'running' &&
      state.run?.status !== 'running' &&
      previous.id === state.run?.id
    )
      notice(
        state.run.status === 'complete'
          ? 'Check complete. Review your opportunities.'
          : state.run.status === 'partial'
            ? 'Check finished with incomplete coverage. Review source status.'
            : state.run.status === 'failed'
              ? 'Check failed. Review source coverage and retry.'
              : 'Check cancelled. Completed results retained.',
        state.run.status === 'failed',
      );
    render();
  } catch (e) {
    notice(e.message, true);
  }
}
async function action(fn) {
  try {
    loading = true;
    render();
    await fn();
  } catch (e) {
    notice(e.message, true);
  } finally {
    loading = false;
    render();
  }
}
$('#application-find-job').onclick = () => activate('results');
for (const b of document.querySelectorAll('[data-tab]'))
  b.onclick = () => {
    activate(b.dataset.tab);
    if (b.dataset.tab === 'audit') openAudit();
  };
for (const el of document.querySelectorAll(
  '#profile-form input,#profile-form textarea,#profile-form select,#companies-form textarea',
))
  el.addEventListener('input', () => {
    dirty = true;
    updateScanReadiness();
  });
$('#profile-form').onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const facts = $('#facts')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text, i) => ({ id: `f${i + 1}`, text }));
    const goal = {
      roles: $('#roles').value,
      industries: $('#industries').value,
      country: $('#country').value,
      workMode: $('#work-mode').value,
    };
    const terms = (id) =>
      $(id)
        .value.split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const preferences = {
      careerPriority: $('#career-priority').value,
      leadershipRequired: $('#leadership-required').checked,
      officePolicy: $('#office-policy').value,
      relocations: $('#relocations')
        .value.split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((v) => ({ country: v.replace(/\?$/, '').trim(), tentative: v.endsWith('?') })),
      preferredThemes: terms('#preferred-themes'),
      preferredIndustries: terms('#preferred-industries'),
      disfavoredIndustries: terms('#disfavored-industries'),
      themesConfirmed: $('#themes-confirmed').checked,
      industriesConfirmed: $('#industries-confirmed').checked,
      workAuthorizations: state.profile?.preferences?.workAuthorizations ?? [],
    };
    if ($('#salary-min').value !== '' || $('#salary-max').value !== '')
      preferences.salary = {
        country: $('#salary-country').value || goal.country,
        currency: $('#salary-currency').value,
        targetMin: Number($('#salary-min').value),
        targetMax: Number($('#salary-max').value),
        period: 'year',
        basis: $('#salary-basis').value,
        policy: $('#salary-policy').value,
        unknownPolicy: $('#salary-unknown').value,
      };
    state = await api('/api/profile', { facts, goal, preferences, baseRevision: state.revision });
    dirty = false;
    $('#consent').checked = false;
    notice('Profile and career goal saved. Select your companies next.');
  });
};
$('#companies-form').onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const companies = $('#company-sources')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, homepage, careers, industry = ''] = line.split('|').map((s) => s.trim());
        return { name, homepage, careers, industry };
      });
    state = await api('/api/companies', { companies, baseRevision: state.revision });
    dirty = false;
    $('#consent').checked = false;
    notice('Company sources saved. Ready to check.');
  });
};
$('#example').onclick = () =>
  action(async () => {
    state = await api('/api/profile', { ...example, baseRevision: state.revision });
    state = await api('/api/companies', {
      companies: exampleCompanies,
      baseRevision: state.revision,
    });
    fillInputs();
    $('#consent').checked = false;
    activate('companies');
    notice('Fictional profile and companies loaded. No real candidate data or vacancies are used.');
  });
$('#mode').onchange = () => {
  $('#sharing').hidden = $('#mode').value !== 'live';
  $('#consent').checked = false;
  updateScanReadiness();
};
$('#consent').onchange = updateScanReadiness;
$('#scan').onclick = () =>
  action(async () => {
    if (dirty) throw Error('Save your edited profile or company sources before checking.');
    state = await api('/api/scans', {
      mode: $('#mode').value,
      consent: $('#consent').checked,
      baseRevision: state.revision,
    });
    notice('Check started. You can cancel while companies are being checked.');
    activate('results');
  });
$('#cancel').onclick = () =>
  action(async () => {
    state = await api('/api/cancel', {});
    notice('Check cancelled. Completed results retained.');
  });
$('#url-form').onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const before = new Set(state.opportunities.map((o) => o.id));
    state = await api('/api/intake/url', {
      url: $('#external-url').value,
      title: $('#external-title').value,
      company: $('#external-company').value,
      text: $('#external-text').value,
      readSource: $('#external-read').checked,
      consent: $('#external-read').checked,
      baseRevision: state.revision,
    });
    $('#url-form').reset();
    const added = state.opportunities.find((o) => !before.has(o.id));
    notice(
      added
        ? 'Vacancy saved as unverified. Review the source before relying on it.'
        : 'This vacancy is already saved. Your decision is unchanged.',
    );
    if (added) openSaved(added.id);
  });
};
$('#manual-form').onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    state = await api('/api/manual', {
      company: $('#manual-company').value,
      title: $('#manual-title').value,
      url: $('#manual-url').value,
      text: $('#manual-text').value,
      baseRevision: state.revision,
    });
    $('#manual-form').reset();
    notice('Public description saved as unverified. No provider request was made.');
  });
};
$('#back-results').onclick = () => activate('results');
$('#saved-search').oninput = () => renderSaved(true);
$('#saved-stage').onchange = () => renderSaved(true);
$('#review-sources').onclick = () => activate('companies');
$('#filter').onchange = renderResults;
$('#result-search').oninput = renderResults;
$('#delete').onclick = () => {
  $('#delete-confirm').hidden = false;
};
$('#keep-data').onclick = () => {
  $('#delete-confirm').hidden = true;
};
$('#confirm-delete').onclick = () =>
  action(async () => {
    state = await api('/api/data', {}, 'DELETE');
    decisionDrafts.clear();
    resetAudit();
    mailUI.reset();
    fillInputs();
    $('#delete-confirm').hidden = true;
    $('#mode-label').textContent = 'Fictional example · no external requests';
    activate('profile');
    notice(
      state.publicService
        ? 'Workspace cleared. Your sign-in account remains. Receiving is paused.'
        : 'Local profile and search data deleted.',
    );
  });
const mailUI = initMail({
  getState: () => state,
  setState: (s) => {
    state = s;
  },
  api,
  action,
  notice,
  activate,
  openAudit,
});

let auditScope = {},
  auditCursor = 0,
  auditRows = [],
  auditRequest = 0;
function resetAudit() {
  auditRequest++;
  auditScope = {};
  auditCursor = 0;
  auditRows = [];
  $('#audit-events').replaceChildren();
  $('#audit-status').textContent = '';
  $('#audit-error').textContent = '';
  $('#audit-capacity').textContent = '';
  $('#audit-empty').textContent = '';
  $('#audit-empty').hidden = true;
  $('#audit-agent').value = '';
  $('#audit-attempt').value = '';
  $('#audit-errors').checked = false;
  $('#audit-export').disabled = true;
  $('#audit-more').hidden = true;
}
async function openAudit(scope = {}) {
  auditScope = scope;
  auditCursor = 0;
  auditRows = [];
  $('#audit-events').replaceChildren();
  $('#audit-attempt').value = '';
  $('#audit-agent').value = '';
  $('#audit-errors').checked = false;
  activate('audit');
  await loadAudit(true);
}
function auditQuery(after = 0) {
  const query = new URLSearchParams({ ...auditScope, after: String(after), limit: '100' });
  if ($('#audit-attempt').value.trim())
    query.set('applicationAttemptId', $('#audit-attempt').value.trim());
  if ($('#audit-agent').value.trim()) query.set('actorRole', $('#audit-agent').value.trim());
  if ($('#audit-errors').checked) query.set('errorsOnly', 'true');
  return query;
}

function readableAuditSnapshot(snapshot) {
  const root = node('div'),
    data = snapshot.data ?? snapshot;
  const labels = {
    profileVersion: 'Saved profile version',
    facts: 'Confirmed profile facts',
    goal: 'Career goal',
    requirements: 'Vacancy requirements',
    text: 'Recorded text',
    profileQuote: 'Quoted profile evidence',
    jobQuote: 'Quoted vacancy evidence',
    unconfirmedQuote: 'Unconfirmed requirement',
    directionReason: 'Role direction explanation',
    rows: 'Requirement assessment',
    status: 'Recorded result',
    factId: 'Source fact',
    requirementId: 'Requirement',
    reason: 'Recorded explanation',
    claims: 'Document claims',
    citations: 'Evidence citations',
    document: 'Prepared documents or recorded decision',
    assessment: 'Agent assessment',
    verification: 'Independent verification',
    issues: 'Validation findings',
    coverage: 'Coverage check',
    complete: 'Complete',
    answersComplete: 'Questions answered',
    distinctCover: 'Distinct cover letter',
    supported: 'Evidence supports this claim',
    reviews: 'Claim reviews',
    cvText: 'CV text',
    coverLetter: 'Cover letter',
    answers: 'Employer question answers',
    cvVersion: 'CV version',
    files: 'Attachment metadata',
    summary: 'Professional summary',
    experience: 'Experience',
    skills: 'Skills',
    quote: 'Exact source quotation',
    name: 'Name',
    title: 'Title',
    stage: 'Recorded step',
    note: 'Candidate note',
    nextAction: 'Next action',
    dueDate: 'Action date',
  };
  root.append(
    node(
      'h3',
      {
        profile: 'Saved master profile',
        job: 'Saved vacancy evidence',
        packet: 'Recorded application documents',
        proposal: 'Recorded proposal and checks',
      }[snapshot.kind] ?? 'Recorded evidence',
    ),
  );
  function display(value, key, depth = 0) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length) root.append(node('h4', labels[key] ?? key));
      for (const item of value) display(item, '', depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) display(item, name, depth + 1);
      return;
    }
    const label = labels[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2');
    root.append(
      node(
        'p',
        (label ? label + ': ' : '') +
          (typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)),
        key === 'text' || key === 'quote' || key.endsWith('Quote') ? 'audit-quote' : null,
      ),
    );
  }
  display(data, '');
  return root;
}

function renderAuditRows() {
  const root = $('#audit-events');
  root.replaceChildren();
  const role = $('#audit-agent').value.trim().toLowerCase(),
    errors = $('#audit-errors').checked;
  const rows = auditRows.filter(
    (event) =>
      (!role ||
        String(event.actor?.role ?? '')
          .toLowerCase()
          .includes(role)) &&
      (!errors ||
        ['failed', 'rejected', 'cancelled', 'stale', 'interrupted', 'unknown'].includes(
          event.status,
        )),
  );
  for (const event of rows) {
    const row = node('li', null, 'audit-event');
    row.append(node('h3', event.action.replace(/[:-]/g, ' ') + ' · ' + event.status));
    row.append(
      node(
        'p',
        String(event.serverRecordedAt ?? event.at ?? 'Time unavailable') +
          ' · sequence ' +
          event.sequence +
          (event.durationMs === undefined ? '' : ' · ' + event.durationMs + ' ms'),
        'help',
      ),
    );
    row.append(
      node(
        'p',
        [
          event.actor?.type,
          event.actor?.role,
          event.actor?.mode,
          event.actor?.provider,
          event.actor?.model,
        ]
          .filter(Boolean)
          .join(' · '),
        'help',
      ),
    );
    row.append(node('p', event.reason));
    if (event.applicationAttemptId)
      row.append(node('p', 'Attempt: ' + event.applicationAttemptId, 'help'));
    if (event.packetRevision !== undefined && event.packetRevision !== null)
      row.append(node('p', 'Packet revision: ' + event.packetRevision, 'help'));
    if (event.actor?.codeRevision || event.actor?.promptHash) {
      const versions = node('details');
      versions.append(
        node('summary', 'Agent implementation versions'),
        node(
          'p',
          'Code: ' +
            (event.actor.codeRevision ?? 'unknown') +
            ' · prompt: ' +
            (event.actor.promptHash ?? 'unknown'),
          'help',
        ),
      );
      row.append(versions);
    }
    for (const evidence of event.evidenceRefs ?? [])
      row.append(node('p', evidence.factId + ': ' + evidence.quote, 'help'));
    for (const digest of event.snapshotRefs ?? []) {
      const details = node('details'),
        summary = node('summary', 'Input / decision snapshot');
      details.append(summary);
      details.addEventListener('toggle', async () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = '1';
        const requestSerial = auditRequest;
        const output = node('div', 'Loading recorded evidence…');
        details.append(output);
        try {
          const snapshot = await api(
            '/api/audit/snapshots/' + encodeURIComponent(digest),
            undefined,
            'GET',
          );
          if (requestSerial !== auditRequest) return;
          output.replaceChildren(readableAuditSnapshot(snapshot));
        } catch {
          output.textContent = 'Snapshot unavailable. Retry by reopening decision history.';
        }
      });
      row.append(details);
    }
    root.append(row);
  }
  $('#audit-empty').hidden = rows.length !== 0;
  $('#audit-empty').textContent = auditRows.length
    ? 'No loaded events match these filters. Load more history or clear the filters.'
    : 'No recorded events in this scope. Events from before tracking was enabled are unavailable; they are not reconstructed.';
}
async function loadAudit(reset = false) {
  const serial = ++auditRequest;
  $('#audit-error').textContent = '';
  $('#audit-status').textContent = 'Loading decision history…';
  $('#audit-more').disabled = true;
  if (!state?.audit?.available) {
    $('#audit-status').textContent =
      'Decision history is unavailable in this legacy workspace. Existing work is untracked.';
    $('#audit-more').hidden = true;
    $('#audit-export').disabled = true;
    return;
  }
  try {
    const data = await api('/api/audit?' + auditQuery(reset ? 0 : auditCursor), undefined, 'GET');
    if (serial !== auditRequest) return;
    auditRows = reset ? data.events : [...auditRows, ...data.events];
    auditCursor = data.cursor;
    $('#audit-status').textContent =
      auditRows.length +
      ' recorded events loaded. Agent judgements, candidate actions and transport observations are separate records.';
    $('#audit-capacity').textContent = data.capacity?.full
      ? 'History capacity reached. New tracked actions are stopped; reading and exporting remain available.'
      : '';
    $('#audit-more').hidden = !auditCursor;
    $('#audit-export').disabled = false;
    renderAuditRows();
  } catch {
    if (serial === auditRequest) {
      $('#audit-status').textContent = '';
      $('#audit-error').textContent =
        'Could not read decision history. Your saved work is unchanged. Retry.';
    }
  } finally {
    if (serial === auditRequest) $('#audit-more').disabled = false;
  }
}
$('#audit-more').onclick = () => loadAudit();
$('#audit-refresh').onclick = () => loadAudit(true);
$('#audit-agent').onchange = () => loadAudit(true);
$('#audit-errors').onchange = () => loadAudit(true);
$('#audit-attempt').onchange = () => loadAudit(true);
$('#audit-export').onclick = async () => {
  $('#audit-error').textContent = '';
  const requestSerial = auditRequest;
  try {
    const query = auditQuery(0);
    query.delete('after');
    query.delete('limit');
    const response = await fetch('/api/audit/export?' + query, {
      headers: workspaceAccountId ? { 'X-Rolemorrow-Account-ID': workspaceAccountId } : {},
      cache: 'no-store',
    });
    if (response.status === 401 || response.status === 409) {
      resetAudit();
      throw Error('Export session changed');
    }
    if (!response.ok) throw Error('Export unavailable');
    const payload = await response.blob();
    if (requestSerial !== auditRequest) return;
    const url = URL.createObjectURL(payload),
      link = node('a');
    link.href = url;
    link.download = 'rolemorrow-decision-history.jsonl';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#audit-status').textContent =
      'Decision history exported. Export contains private source snapshots; share it deliberately.';
  } catch {
    $('#audit-error').textContent =
      'Could not export this history. Check your session, then retry.';
  }
};

await refresh();
if (state) {
  fillInputs();
  activate(state.run ? 'results' : 'profile');
}
