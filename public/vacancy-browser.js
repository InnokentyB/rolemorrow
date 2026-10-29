// Shared discovery is read-only; personal saving uses the existing vacancy-link form.
export function initVacancyBrowser({ request, onChoose }) {
  const root = document.querySelector('#vacancy-browser'),
    form = root.querySelector('form'),
    status = root.querySelector('[role="status"]'),
    results = root.querySelector('.vacancy-results'),
    more = root.querySelector('[data-more]'),
    details = root.querySelector('details');
  let busy = false,
    loaded = false,
    next = null,
    filters = '';
  const el = (tag, text) => {
    const e = document.createElement(tag);
    e.textContent = text;
    return e;
  };
  async function load(append = false) {
    if (busy) return;
    busy = true;
    const button = form.querySelector('button');
    button.disabled = true;
    form.querySelector('[type=reset]').disabled = true;
    more.disabled = true;
    status.textContent = 'Searching saved public vacancies…';
    try {
      if (!append) {
        filters = new URLSearchParams(new FormData(form)).toString();
        results.replaceChildren();
      }
      const data = await request(
        '/api/vacancies?' + filters + (append ? '&offset=' + next : ''),
        undefined,
        'GET',
      );
      for (const job of data.vacancies) {
        const article = el('article', ''),
          heading = el('h3', job.title),
          company = el('p', job.companyName + (job.location ? ' · ' + job.location : '')),
          labels = job.classification;
        const info = el(
          'p',
          'Specialization: ' +
            (labels?.roles ?? ['unknown'])
              .map((x) => (x === 'unknown' ? 'Not specified' : x))
              .join(', ') +
            ' · Level: ' +
            (labels?.levels ?? ['unknown'])
              .map((x) => (x === 'unknown' ? 'Not specified' : x))
              .join(', ') +
            ' · Work format: ' +
            (labels?.workModes ?? ['unknown'])
              .map((x) => (x === 'unknown' ? 'Not specified' : x))
              .join(', '),
        );
        info.className = 'help';
        const freshness = {
          active: 'Listed at last check',
          'not-listed': 'No longer in checked feed',
          expired: 'Source deadline passed',
          unknown: 'Availability unconfirmed',
          unavailable: 'Source check failed',
        };
        const checked = el(
          'p',
          (freshness[job.status] ?? 'Availability unconfirmed') +
            ' · checked ' +
            new Date(job.checkedAt).toLocaleString(),
        );
        checked.className = 'help';
        const link = el('a', 'Official posting');
        link.href = job.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const choose = el('button', 'Save link for ' + job.title);
        choose.type = 'button';
        choose.className = 'secondary';
        choose.onclick = () => {
          if (onChoose(job) === false)
            status.textContent =
              'A vacancy link draft is already open in Saved jobs. Save or clear that draft, then choose this vacancy again.';
        };
        const description = el('details', ''),
          summary = el('summary', 'Saved description' + (job.textTruncated ? ' (excerpt)' : '')),
          body = el('p', job.text);
        body.className = 'vacancy-snapshot';
        description.append(summary, body);
        const salary = el(
          'p',
          (job.facts?.salary ?? [])
            .map((s) => s.currency + ' ' + s.min + '–' + s.max + ' / ' + s.interval.toLowerCase())
            .join(' · ') || 'Structured salary not supplied',
        );
        salary.className = 'help';
        if (data.collection?.mode === 'sequential-rounds') {
          const save = el('button', 'Review and save vacancy');
          save.type = 'button';
          save.onclick = async () => {
            try {
              const state = await request('/api/state', undefined, 'GET');
              await request('/api/catalog-opportunities', {
                vacancyId: job.id,
                baseRevision: state.revision,
              });
              location.reload();
            } catch (error) {
              status.textContent = error.message;
            }
          };
          article.append(save);
        }
        article.append(heading, company, info, salary, checked, link, choose, description);
        results.append(article);
      }
      next = data.nextOffset;
      more.hidden = next === null;
      status.textContent = data.matching
        ? results.children.length +
          ' shown of ' +
          data.matching +
          ' matching vacancies (' +
          data.total +
          ' saved). Check the official posting before applying.'
        : 'No saved vacancies match. Remove a filter or try different keywords; source coverage is partial.';
      loaded = true;
    } catch {
      status.textContent = 'Could not search saved vacancies. Try Search vacancies again.';
      more.hidden = true;
    } finally {
      busy = false;
      button.disabled = false;
      form.querySelector('[type=reset]').disabled = false;
      more.disabled = false;
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    void load();
  };
  form.onreset = () => {
    setTimeout(() => void load(), 0);
  };
  more.onclick = () => void load(true);
  details.ontoggle = () => {
    if (details.open && !loaded) void load();
  };
  return {
    show(enabled) {
      root.hidden = !enabled;
    },
  };
}
