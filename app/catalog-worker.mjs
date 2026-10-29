// One bounded pass only. No scheduler, live fetch or provider default is constructed.
/** @typedef {{runId:string,roundId:string,organizationId:string,leaseToken:string,epoch:number}} WorkerClaim */
/** @typedef {{id:string,careers:string,[key:string]:unknown}} PublicOrganization */
/** @typedef {{postings?:unknown[],inventory?:{urls:string[],sources:string[],complete:boolean},status?:string,openingCount?:number,sources?:string[],ats?:string[]}} CollectionObservation */
/** @typedef {{checked:number,failed?:number,stopped?:boolean,interrupted?:boolean,category?:string}} WorkerPassResult */
/** @typedef {{organizations:{entries:()=>Promise<PublicOrganization[]>},worker:{startRound:()=>Promise<unknown>,claim:()=>Promise<WorkerClaim|null>,heartbeat:(claim:WorkerClaim)=>Promise<boolean>,publish:(claim:WorkerClaim,result:unknown)=>Promise<unknown>,fail:(claim:WorkerClaim,result:{category:string,retryAfter?:string})=>Promise<unknown>}}} WorkerCatalog */
/**
 * @param {{catalog?:WorkerCatalog,inspect?:(company:PublicOrganization,context:{signal:AbortSignal})=>Promise<CollectionObservation>,deadlineMs?:number,heartbeatMs?:number}} [options]
 */
export function createCatalogWorker({
  catalog,
  inspect,
  deadlineMs = 60000,
  heartbeatMs = 20000,
} = {}) {
  if (!catalog?.worker || typeof inspect !== 'function')
    throw Error('Explicit catalog and restricted inspection adapter required');
  const selectedCatalog = catalog,
    selectedInspect = inspect;
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 60000 ||
    !Number.isInteger(heartbeatMs) ||
    heartbeatMs < 1 ||
    heartbeatMs > 20000
  )
    throw Error('Invalid worker budgets');
  /** @type {Promise<WorkerPassResult>|null} */ let running = null;
  let stopped = false;
  /** @type {AbortController|null} */ let active = null;
  const stop = () => {
    stopped = true;
    active?.abort(Error('Worker stopped'));
  };
  /** @returns {Promise<WorkerPassResult>} */
  async function run() {
    if (stopped) return { checked: 0, stopped: true };
    if (running) return running;
    running = (async () => {
      await selectedCatalog.worker.startRound();
      const claim = await selectedCatalog.worker.claim();
      if (!claim) return { checked: 0 };
      const company = (await selectedCatalog.organizations.entries()).find(
        (row) => row.id === claim.organizationId,
      );
      if (!company) throw Error('Claim company missing');
      const controller = new AbortController();
      active = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)]);
      let timer,
        authority = true;
      const beat = async () => {
        try {
          authority = await selectedCatalog.worker.heartbeat(claim);
          if (!authority) controller.abort(Error('Collection authority lost'));
        } catch {
          authority = false;
          controller.abort(Error('Collection heartbeat unavailable'));
        }
        if (authority && !signal.aborted) timer = setTimeout(beat, heartbeatMs);
      };
      timer = setTimeout(beat, heartbeatMs);
      try {
        const outcome = await Promise.race([
          selectedInspect(company, { signal }),
          /** @type {Promise<never>} */ (
            new Promise((_, reject) => {
              const abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            })
          ),
        ]);
        if (stopped || !authority || signal.aborted) throw Error('Collection interrupted');
        await selectedCatalog.worker.publish(claim, {
          postings: outcome.postings ?? [],
          inventory: outcome.inventory ?? { urls: [], sources: [], complete: false },
          organizationOutcome: {
            status: outcome.status ?? 'unknown',
            openingCount: outcome.openingCount ?? outcome.postings?.length ?? 0,
            sources: outcome.sources ?? [company.careers],
            ats: outcome.ats ?? [],
          },
        });
        return { checked: 1, failed: 0 };
      } catch (problem) {
        if (authority && !stopped)
          await selectedCatalog.worker.fail(claim, {
            category: signal.aborted ? 'source-timeout' : 'source-unavailable',
            ...(typeof problem?.retryAfter === 'string' ? { retryAfter: problem.retryAfter } : {}),
          });
        if (stopped || !authority) return { checked: 0, interrupted: true };
        return {
          checked: 0,
          failed: 1,
          category: problem?.name === 'TimeoutError' ? 'source-timeout' : 'source-unavailable',
        };
      } finally {
        controller.abort(Error('Collection attempt finished'));
        clearTimeout(timer);
        active = null;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }
  return { run, stop };
}
