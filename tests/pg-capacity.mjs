// Synthetic fixture precondition only. Never used by application/worker runtime.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openPostgresCatalog as openActualCatalog } from '../app/postgres-catalog.mjs';
export async function readCapacityObservation() {
  if (process.env.ROLEMORROW_PG_SYNTHETIC !== '1' || !process.env.RM_CAPACITY_FILE)
    throw Error('INFRA: explicit trusted physical-capacity observation required');
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const value = JSON.parse(await readFile(process.env.RM_CAPACITY_FILE, 'utf8'));
      const keys = Object.keys(value).sort().join(',');
      if (
        keys !== 'database,freeBytes,observedAt,storeId,totalBytes' ||
        value.database !== 'rolemorrow_synthetic' ||
        value.storeId !== 'synthetic-pgdata' ||
        !Number.isSafeInteger(value.observedAt) ||
        !Number.isSafeInteger(value.totalBytes) ||
        value.totalBytes <= 0 ||
        !Number.isSafeInteger(value.freeBytes) ||
        value.freeBytes < 0 ||
        value.freeBytes > value.totalBytes
      )
        throw Error('Invalid observation');
      const age = Date.now() - value.observedAt;
      if (age >= -1000 && age <= 55000) return value;
    } catch {}
    await delay(250);
  }
  throw Error('INFRA: trusted physical-capacity observation missing, invalid or stale');
}
export async function openPostgresCatalog(options = {}) {
  if (options.role === 'operator')
    return openActualCatalog({
      ...options,
      capacityObservation: options.capacityObservation ?? (await readCapacityObservation()),
    });
  return openActualCatalog(options);
}
