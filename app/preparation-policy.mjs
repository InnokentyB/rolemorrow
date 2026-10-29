import { MailError } from './mail.mjs';
export const PREPARATION_TIMING = Object.freeze({
  generation: 45000,
  'semantic-review': 30000,
  repair: 45000,
  'fresh-review': 30000,
  total: 155000,
  http: 160000,
});
export function preparationTiming(input = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => k === 'http' || !Object.hasOwn(PREPARATION_TIMING, k)) ||
    Object.entries(input).some(
      ([k, v]) => !Number.isSafeInteger(v) || v < 1 || v > PREPARATION_TIMING[k],
    )
  )
    throw Error('Invalid bounded preparation timing.');
  return { ...PREPARATION_TIMING, ...input };
}
export function preparationDeadline(ms, code, stage) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        Object.assign(
          new MailError(
            504,
            'Application preparation exceeded its bounded time budget. Your saved packet is unchanged.',
          ),
          { code, status: 504, ...(stage ? { stage } : {}) },
        ),
      ),
    ms,
  );
  timer.unref?.();
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}
export async function preparationAwait(signal, operation) {
  signal.throwIfAborted();
  let aborted;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      new Promise((_resolve, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', aborted);
  }
}
