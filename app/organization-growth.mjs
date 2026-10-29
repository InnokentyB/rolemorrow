// Directory hints are untrusted. Only independently verified employer sites are published.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeFetch, validatePublicUrl } from './network.mjs';
import { verifyOrganizationCandidate } from './organization-verification.mjs';
export const GROWTH_SOURCE = 'https://github.com/remoteintech/remote-jobs';
const TREE = 'https://api.github.com/repos/remoteintech/remote-jobs/git/trees/main?recursive=1';
const RAW = 'https://raw.githubusercontent.com/remoteintech/remote-jobs/main/';
const DAY = 86400000,
  HOUR = 3600000,
  validPath = (p) => typeof p === 'string' && /^src\/companies\/[a-z0-9_-]+\.md$/.test(p);
export function directoryHomepage(markdown) {
  const front = String(markdown)
    .slice(0, 32768)
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const value = front?.match(/^website:\s*["']?(https:\/\/[^\s"']+)["']?\s*$/m)?.[1];
  if (!value) return null;
  let u;
  try {
    u = validatePublicUrl(value);
  } catch {
    return null;
  }
  if (u.search || u.hash || u.pathname !== '/') return null;
  return u.origin;
}
export async function createOrganizationGrowth({
  file,
  catalog,
  now = () => Date.now(),
  fetchPage = safeFetch,
  verify = verifyOrganizationCandidate,
} = {}) {
  let state = {
    schema: 1,
    nextBatchAt: 0,
    nextSourceAt: 0,
    paths: [],
    cursor: '',
    attemptTimes: [],
    lastResult: null,
  };
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (
      state.schema !== 1 ||
      !Array.isArray(state.paths) ||
      state.paths.length > 5000 ||
      !state.paths.every(validPath) ||
      !Array.isArray(state.attemptTimes) ||
      state.attemptTimes.length > 10 ||
      !state.attemptTimes.every(Number.isFinite) ||
      !Number.isFinite(state.nextBatchAt) ||
      !Number.isFinite(state.nextSourceAt)
    )
      throw Error('Invalid company growth state.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let running = null,
    stopped = false,
    controller = null;
  async function commit(patch) {
    const next = { ...state, ...patch };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
    state = next;
  }
  const read = (url, signal, maxBytes) =>
    fetchPage(url, {
      signal,
      timeoutMs: 12000,
      maxBytes,
      headers: {
        'User-Agent': 'RolemorrowCatalog/1.0 (+https://app.rolemorrow.com/privacy)',
        Accept: 'application/vnd.github+json',
      },
      beforeRedirect: () => {
        throw Error('Directory redirect outside fixed source.');
      },
    });
  async function collect() {
    const at = now();
    if (stopped || at < state.nextBatchAt) return { attempted: 0, added: 0 };
    // Reserve before any external read; restart cannot bypass hourly or daily caps.
    await commit({
      nextBatchAt: at + HOUR,
      attemptTimes: state.attemptTimes.filter((t) => at - t < DAY),
    });
    if (at >= state.nextSourceAt) {
      await commit({ nextSourceAt: at + DAY });
      try {
        const page = await read(TREE, controller.signal, 1024 * 1024),
          tree = JSON.parse(page.text);
        if (tree.truncated || !Array.isArray(tree.tree))
          throw Error('Incomplete public directory.');
        const paths = [
          ...new Set(
            tree.tree.filter((x) => x.type === 'blob' && validPath(x.path)).map((x) => x.path),
          ),
        ]
          .sort()
          .slice(0, 5000);
        if (!paths.length) throw Error('Empty public directory.');
        await commit({ paths });
      } catch {
        controller.signal.throwIfAborted();
        await commit({ lastResult: { at, status: 'source-unavailable' } });
      }
    }
    if (!state.paths.length) return { attempted: 0, added: 0 };
    let attempted = 0,
      added = 0;
    const paths = [
      ...state.paths.filter((p) => p > state.cursor),
      ...state.paths.filter((p) => p <= state.cursor),
    ];
    for (const path of paths.slice(0, Math.min(2, 10 - state.attemptTimes.length))) {
      if (stopped) break;
      await commit({ cursor: path, attemptTimes: [...state.attemptTimes, now()] });
      attempted++;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
          page = await read(RAW + path, signal, 32768),
          homepage = directoryHomepage(page.text);
        if (!homepage || (await catalog.resolve({ homepage }))) continue;
        const result = await verify({ homepage }, { signal });
        if (stopped) break;
        if (result) {
          const imported = await catalog.importVerified(result);
          if (imported.added) added++;
        }
      } catch {
        controller.signal.throwIfAborted();
      }
    }
    await commit({ lastResult: { at: now(), status: 'checked', attempted, added } });
    return { attempted, added };
  }
  return {
    run() {
      if (stopped) return Promise.resolve({ attempted: 0, added: 0 });
      if (running) return running;
      controller = new AbortController();
      running = collect().finally(() => {
        running = null;
        controller = null;
      });
      return running;
    },
    status: () => ({
      source: GROWTH_SOURCE,
      batchSize: 2,
      maxPerDay: 10,
      nextBatchAt: state.nextBatchAt,
      directoryEntries: state.paths.length,
      lastResult: structuredClone(state.lastResult),
    }),
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
