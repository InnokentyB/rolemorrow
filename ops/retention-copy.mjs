#!/usr/bin/env node
import { createVerifiedRetentionCopy } from '../app/retention-restore.mjs';

// Offline operator tool; not imported by web, worker or scheduler.
try {
  const args = process.argv.slice(2);
  const values = {};
  const names = new Map([
    ['--source', 'source'],
    ['--destination', 'destination'],
    ['--ledger', 'ledgerPath'],
    ['--ledger-digest', 'ledgerDigest'],
    ['--original-created-at', 'originalCreatedAt'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--attest-current-ledger') {
      if (values.currentSnapshot) throw Error();
      values.currentSnapshot = true;
      continue;
    }
    const name = names.get(arg);
    if (!name || Object.hasOwn(values, name) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw Error();
    values[name] = args[++i];
  }
  if ([...names.values()].some((name) => !Object.hasOwn(values, name))) throw Error();
  console.log(JSON.stringify(await createVerifiedRetentionCopy(values)));
} catch {
  console.error(
    JSON.stringify({
      ok: false,
      error:
        'Retention copy refused: check paths, current ledger attestation/digest, dates, permissions and storage integrity.',
    }),
  );
  process.exitCode = 1;
}
