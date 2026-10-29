import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { openPrivateStorage } from '../app/private-storage.mjs';
test('IR01 actual process death after imported workspace publication recovers matching audit and receipt atomically', async (t) => {
  let evidence,
    output = '';
  const child = fork(new URL('./import-crash-child.mjs', import.meta.url), { silent: true });
  t.after(() => child.kill('SIGKILL'));
  child.on('message', (m) => (evidence = m));
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('Synthetic import crash timed out: ' + output));
    }, 15000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(exit.signal, 'SIGKILL', output);
  assert.ok(evidence);
  t.after(() => rm(evidence.directory, { recursive: true, force: true }));
  const storage = await openPrivateStorage({ directory: evidence.directory });
  try {
    const workspace = storage.readSync('workspace:' + evidence.accountId),
      audit = storage.readSync('audit:' + evidence.accountId);
    assert.equal(workspace.opportunities.length, 1);
    assert.equal(workspace.importReceipts.length, 1);
    assert.equal(workspace.importReceipts[0].itemId, evidence.itemId);
    assert.equal(workspace.messages.length, 0);
    assert.equal(workspace.mailDispatches.length, 0);
    assert.ok(audit.events.some((e) => e.action === 'career-import'));
    assert.equal(audit.events.filter((e) => e.action === 'career-import').length, 1);
  } finally {
    await storage.close();
  }
});
