import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { organizationDomain, organizationSeed } from './organizations.mjs';
const DAY = 86400000;
export const ORGANIZATION_VERIFIER_VERSION = '2026-10-20-official-homepage-v3';
const attemptTimes = (row) =>
  row.attemptTimes ?? (row.lastAttemptAt === null ? [] : [row.lastAttemptAt]);
export function candidateInput(input) {
  if (input.homepage) {
    if (String(input.homepage).length > 2048 || String(input.careers).length > 2048)
      throw Error('Company URLs must fit within 2048 characters.');
    const seed = organizationSeed({
      ...input,
      name: 'Pending public website verification',
      industry: '',
    });
    return { key: 'domain:' + seed.domain, homepage: seed.homepage, careers: seed.careers };
  }
  const query = String(input.query ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (/^https:\/\//i.test(query)) {
    const u = new URL(query);
    if (u.search || u.hash || u.pathname !== '/' || query.length > 2048)
      throw Error('Search using a company name or homepage origin.');
    organizationDomain(u.origin);
    return { key: 'domain:' + organizationDomain(u.origin), homepage: u.origin };
  }
  if (!/^[\p{L}\p{N} .&()+,'’\-]{2,80}$/u.test(query) || !/[\p{L}]/u.test(query))
    throw Error('Enter only a company name or an HTTPS homepage, without personal details.');
  return {
    key: 'name:' + createHash('sha256').update(query.toLocaleLowerCase('en')).digest('hex'),
    query,
  };
}
export async function createOrganizationCandidates({
  file,
  catalog,
  now = () => Date.now(),
  verificationVersion = ORGANIZATION_VERIFIER_VERSION,
} = {}) {
  let rows = [];
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.schema !== 1 || !Array.isArray(data.candidates) || data.candidates.length > 500)
      throw Error('Invalid company discovery queue.');
    rows = data.candidates;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let tail = Promise.resolve();
  const serial = (work) => {
    const p = tail.then(work);
    tail = p.catch(() => {});
    return p;
  };
  async function commit(next) {
    const tmp = file + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify({ schema: 1, candidates: next }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(tmp, file);
    rows = next;
  }
  return {
    enqueue: (input) =>
      serial(async () => {
        const candidate = candidateInput(input);
        if (candidate.homepage && (await catalog.resolve(candidate))) return { status: 'known' };
        if (candidate.query && (await catalog.list({ query: candidate.query, limit: 1 })).length)
          return { status: 'known' };
        const at = now(),
          live = rows.filter((x) => at - x.createdAt < 30 * DAY);
        const previous = live.find((x) => x.key === candidate.key);
        if (previous) return { status: previous.status === 'published' ? 'known' : 'queued' };
        if (live.length >= 500)
          throw Object.assign(
            Error('Company discovery queue is full. Your saved sources remain usable.'),
            { status: 503 },
          );
        await commit([
          ...live,
          { ...candidate, createdAt: at, attempts: 0, lastAttemptAt: null, status: 'pending' },
        ]);
        return { status: 'queued' };
      }),
    claim: () =>
      serial(async () => {
        const at = now(),
          live = rows.filter((x) => at - x.createdAt < 30 * DAY);
        if (live.length !== rows.length) await commit(live);
        if (
          live.reduce(
            (count, row) => count + attemptTimes(row).filter((time) => at - time < DAY).length,
            0,
          ) >= 5
        )
          return null;
        const row = live
          .filter(
            (x) =>
              x.status !== 'published' &&
              x.attempts < 3 &&
              (x.lastAttemptAt === null ||
                at - x.lastAttemptAt >= DAY ||
                x.verificationVersion !== verificationVersion),
          )
          .sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0))[0];
        if (!row) return null;
        const claimed = {
          ...row,
          attempts: row.attempts + 1,
          lastAttemptAt: at,
          attemptTimes: [...attemptTimes(row), at],
          verificationVersion,
          status: 'checking',
        };
        await commit(live.map((x) => (x.key === row.key ? claimed : x)));
        return structuredClone(claimed);
      }),
    settle: (key, published) =>
      serial(async () => {
        await commit(
          rows.map((x) =>
            x.key === key
              ? published
                ? {
                    key: x.key,
                    createdAt: x.createdAt,
                    attempts: x.attempts,
                    lastAttemptAt: x.lastAttemptAt,
                    attemptTimes: attemptTimes(x),
                    verificationVersion: x.verificationVersion,
                    status: 'published',
                  }
                : { ...x, status: 'review-needed' }
              : x,
          ),
        );
      }),
  };
}
export function createOrganizationCandidateWorker({ queue, catalog, verify } = {}) {
  let running = null,
    stopped = false,
    controller = null;
  function run() {
    if (stopped) return Promise.resolve({ published: 0 });
    if (running) return running;
    controller = new AbortController();
    const parent = controller.signal;
    running = (async () => {
      let published = 0,
        review = 0;
      for (let i = 0; i < 5 && !stopped; i++) {
        const candidate = await queue.claim();
        if (!candidate) break;
        try {
          const result = await verify(candidate, {
            signal: AbortSignal.any([parent, AbortSignal.timeout(45000)]),
          });
          if (stopped) break;
          if (!result) throw Error('Unconfirmed public identity');
          await catalog.importVerified(result);
          await queue.settle(candidate.key, true);
          published++;
        } catch {
          if (stopped) break;
          await queue.settle(candidate.key, false);
          review++;
        }
      }
      return { published, review };
    })().finally(() => {
      running = null;
      controller = null;
    });
    return running;
  }
  return {
    run,
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
