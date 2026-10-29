import { AI_PERMISSION_VERSION } from '../app/policies.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../app/server.mjs';
test('SJ05 workspace exposes its configured inspection budget before approving a live check', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'search-budget-'));
  const server = createServer({
    legacyUntracked: true,
    storeFile: join(dir, 'state.json'),
    env: { PUBLIC_SERVICE: '1', LIVE_MAX_JOBS_PER_COMPANY: '6' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.config.liveMaxJobsPerCompany, 6);
  assert.equal(state.config.liveReady, false);
  assert.equal(state.run, null);
});
test('PE06 AI approval is versioned and profile-bound; declined checks create no approval or provider calls', async (t) => {
  const { profile, companies } = await import('./fixtures.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'search-approval-'));
  let calls = 0;
  const server = createServer({
    storeFile: join(dir, 'state.json'),
    env: {
      ALLOW_LIVE: '1',
      NEBIUS_API_KEY: 'synthetic',
      TAVILY_API_KEY: 'synthetic',
      NEBIUS_MODEL: 'nvidia/test',
    },
    providers: {
      discover: async () => {
        calls++;
        return { jobs: [], coverage: 'partial', note: 'Synthetic provider' };
      },
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: base },
      body: JSON.stringify(body),
    });
  assert.equal((await post('/api/profile', profile)).status, 200);
  assert.equal((await post('/api/companies', { companies })).status, 200);
  assert.equal((await post('/api/scans', { mode: 'live', consent: false })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await (await fetch(base + '/api/state')).json()).run, null);
  const response = await post('/api/scans', { mode: 'live', consent: true });
  assert.equal(response.status, 202);
  const state = await response.json();
  assert.equal(state.run.authorization.version, AI_PERMISSION_VERSION);
  assert.equal(state.run.authorization.profileVersion, state.profile.version);
  assert.equal(state.run.authorization.status, 'approved-request');
  assert.match(state.run.authorization.approvedAt, /^2026|^20/);
});
test('public workspace does not publish the operator personal test-recipient address', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'public-mail-policy-'));
  const server = createServer({
    legacyUntracked: true,
    storeFile: join(dir, 'state.json'),
    env: { PUBLIC_SERVICE: '1', MAIL_RECIPIENT_ALLOWLIST: 'private-operator@example.com' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const state = await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json();
  assert.deepEqual(state.mailTransport.recipientAllowlist, []);
  assert.equal(state.mailTransport.recipientRestricted, true);
  assert(!JSON.stringify(state).includes('private-operator@example.com'));
});
