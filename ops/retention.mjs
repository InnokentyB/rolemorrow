#!/usr/bin/env node
import { planRetention, executeRetention, finalizeRetention } from '../app/retention.mjs';
const args = process.argv.slice(2),
  options = {};
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--execute' || key === '--finalize') {
      if (options.execute || options.finalize) throw Error('duplicate flag');
      options[key.slice(2)] = true;
      continue;
    }
    if (
      !['--root', '--now', '--approve'].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      Object.hasOwn(options, key.slice(2))
    )
      throw Error('invalid arguments');
    options[key.slice(2)] = args[++i];
  }
  if (!options.root) throw Error('--root required');
  const report = options.finalize
    ? finalizeRetention({ ...options, enabled: process.env.ROLEMORROW_RETENTION_ENABLE === '1' })
    : options.execute
      ? executeRetention({ ...options, enabled: process.env.ROLEMORROW_RETENTION_ENABLE === '1' })
      : planRetention(options);
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'refused-or-partial',
      error: error.message.startsWith('Retention:')
        ? error.message
        : 'Retention: operation failed; inspect protected repository before retry',
    }),
  );
  process.exitCode = 1;
}
