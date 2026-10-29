// Synthetic process-death probe; only runs inside the parent's bounded Docker job.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setup, bundle, stage, commit, vacancy, message } from './import-fixtures.mjs';
const h = await setup({ after() {} }),
  a = await h.account('crash-import@example.test'),
  b = bundle(a, [vacancy(), message(a)]),
  p = await stage(h, a, b);
process.send({
  directory: h.dir,
  accountId: a.user.id,
  batchId: b.batchId,
  itemId: b.items[0].itemId,
});
const rename = fs.renameSync;
fs.renameSync = function (source, target) {
  const result = rename(source, target);
  if (String(target).endsWith('/users/' + a.user.id + '/state.json'))
    process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
await commit(h, a, b, p, [b.items[0].itemId]);
throw Error('Expected process death during protected workspace publication');
