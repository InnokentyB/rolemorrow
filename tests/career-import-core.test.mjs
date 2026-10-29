import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bundle, vacancy, message, syntheticPdf, digest } from './import-fixtures.mjs';
const moduleURL = new URL('../app/career-import.mjs', import.meta.url);
async function harness() {
  const { createCareerImportManager } = await import(moduleURL);
  let now = Date.parse('2026-10-22T12:00:00.000Z');
  const manager = createCareerImportManager({ now: () => now }),
    owner = {
      accountId: randomUUID(),
      generation: 0,
      principalId: 'web:' + randomUUID(),
      email: 'core@example.test',
      actor: { type: 'user', role: 'career-import', id: 'synthetic-owner', mode: 'manual' },
    };
  let current = {
      revision: 0,
      profile: { version: 'confirmed-v1', facts: [] },
      opportunities: [],
      applications: [],
      messages: [],
      notifications: [],
      mailDispatches: [],
      importReceipts: [],
      historicalAttempts: [],
    },
    failCommit = false;
  const commits = [];
  const hooks = {
    getState: () => current,
    assertActive: () => {},
    mutate(change, options) {
      const next = structuredClone(current);
      change(next);
      if (failCommit) throw Object.assign(Error('Synthetic durable failure'), { status: 507 });
      next.revision = current.revision + 1;
      assert.ok(options.careerImport, 'Import must have explicit same-transaction audit metadata');
      commits.push(options);
      current = next;
    },
  };
  return {
    manager,
    owner,
    hooks,
    commits,
    get state() {
      return current;
    },
    set state(s) {
      current = s;
    },
    advance(ms) {
      now += ms;
    },
    fail(value) {
      failCommit = value;
    },
    batch(payloads, opts) {
      return bundle({ user: { email: owner.email } }, payloads, opts);
    },
    async stage(b) {
      await manager.begin(
        owner,
        { batchId: b.batchId, sourceAccount: b.sourceAccount, items: b.items },
        current,
      );
      for (const r of b.records)
        for (let index = 0; index < r.chunks; index++)
          await manager.chunk(
            owner,
            {
              batchId: b.batchId,
              itemId: r.itemId,
              index,
              data: r.payload.subarray(index * 49152, (index + 1) * 49152).toString('base64'),
            },
            current,
          );
      return manager.preview(owner, { batchId: b.batchId }, current);
    },
    async commit(b, p, ids = b.items.map((i) => i.itemId)) {
      return manager.commit(
        owner,
        { batchId: b.batchId, previewHash: p.previewHash, itemIds: ids },
        hooks,
      );
    },
  };
}
const refuses = async (fn, statuses = [400, 401, 403, 404, 409, 410, 413, 429, 503]) => {
  await assert.rejects(
    fn,
    (e) => statuses.includes(e.status),
    'Bounded refusal must carry an explicit status',
  );
};
test('IC01 same begin is idempotent, fixed expiry is not renewed and principal mismatch cannot read staging', async () => {
  const h = await harness(),
    b = h.batch([vacancy()]);
  const body = { batchId: b.batchId, sourceAccount: b.sourceAccount, items: b.items };
  await h.manager.begin(h.owner, body, h.state);
  h.advance(29 * 60000);
  await h.manager.begin(h.owner, body, h.state);
  await refuses(
    () =>
      Promise.resolve().then(() =>
        h.manager.preview(
          { ...h.owner, principalId: 'web:different-session' },
          { batchId: b.batchId },
          h.state,
        ),
      ),
    [404],
  );
  h.advance(61000);
  await refuses(
    () => Promise.resolve().then(() => h.manager.preview(h.owner, { batchId: b.batchId }, h.state)),
    [404, 410],
  );
  assert.equal(h.commits.length, 0);
});
test('IC02 preview counts are bounded per account and globally; cancellation releases capacity', async () => {
  const h = await harness(),
    b1 = h.batch([vacancy()]),
    b2 = h.batch([vacancy()]),
    b3 = h.batch([vacancy()]);
  for (const b of [b1, b2])
    await h.manager.begin(
      h.owner,
      { batchId: b.batchId, sourceAccount: b.sourceAccount, items: b.items },
      h.state,
    );
  await refuses(
    () =>
      Promise.resolve().then(() =>
        h.manager.begin(
          h.owner,
          { batchId: b3.batchId, sourceAccount: b3.sourceAccount, items: b3.items },
          h.state,
        ),
      ),
    [429, 503],
  );
  await h.manager.cancel(h.owner, { batchId: b1.batchId });
  await h.manager.begin(
    h.owner,
    { batchId: b3.batchId, sourceAccount: b3.sourceAccount, items: b3.items },
    h.state,
  );
  for (let i = 0; i < 6; i++) {
    const owner = { ...h.owner, accountId: randomUUID(), principalId: 'web:owner-' + i },
      b = h.batch([vacancy()]);
    await h.manager.begin(
      owner,
      { batchId: b.batchId, sourceAccount: owner.email, items: b.items },
      h.state,
    );
  }
  const owner = { ...h.owner, accountId: randomUUID() },
    b = h.batch([vacancy()]);
  await refuses(
    () =>
      Promise.resolve().then(() =>
        h.manager.begin(
          owner,
          { batchId: b.batchId, sourceAccount: owner.email, items: b.items },
          h.state,
        ),
      ),
    [429, 503],
  );
  assert.equal(h.commits.length, 0);
});
test('IC03 declared byte, total chunk and item caps refuse before any workspace mutation', async () => {
  const h = await harness();
  for (const items of [
    Array.from({ length: 11 }, () => h.batch([vacancy()]).items[0]),
    [{ ...h.batch([vacancy()]).items[0], bytes: 1048577, chunks: 22 }],
    Array.from({ length: 7 }, () => ({
      ...h.batch([vacancy()]).items[0],
      bytes: 1048576,
      chunks: 22,
    })),
  ])
    await refuses(() =>
      Promise.resolve().then(() =>
        h.manager.begin(
          h.owner,
          { batchId: randomUUID(), sourceAccount: h.owner.email, items },
          h.state,
        ),
      ),
    );
  assert.equal(h.state.revision, 0);
  assert.equal(h.commits.length, 0);
});
test('IC04 actual attachment counts across message items, PDF signature and canonical base64 are validated', async () => {
  const h = await harness(),
    a = { user: { email: h.owner.email } };
  const invalid = message(a, {
    attempt: undefined,
    vacancySourceId: undefined,
    files: [
      {
        name: 'invalid.pdf',
        type: 'application/pdf',
        base64: Buffer.from('not a pdf').toString('base64'),
      },
    ],
  });
  const p = await h.stage(h.batch([invalid]));
  assert.equal(p.items[0].status, 'rejected');
  const payloads = Array.from({ length: 11 }, (_, i) =>
    message(a, {
      providerMessageId: 'file-message-' + i,
      attempt: undefined,
      vacancySourceId: undefined,
      files: [
        { name: 'one.pdf', type: 'application/pdf', base64: syntheticPdf.toString('base64') },
        {
          name: 'two.txt',
          type: 'text/plain',
          base64: Buffer.from('Original note').toString('base64'),
        },
      ],
    }),
  );
  const h2 = await harness();
  const preview = await h2.stage(h2.batch(payloads));
  assert.ok(preview.items.some((i) => i.status === 'rejected') || preview.rejected === true);
  assert.equal(h2.commits.length, 0);
});
test('IC05 an indivisible failed durable commit leaves content, receipt, audit metadata and notification absent; deliberate retry succeeds', async () => {
  const h = await harness(),
    b = h.batch([vacancy()]),
    p = await h.stage(b),
    before = structuredClone(h.state);
  h.fail(true);
  try {
    const r = await h.commit(b, p);
    assert.ok(r.items.every((i) => i.status !== 'committed'));
  } catch (e) {
    assert.equal(e.status, 507);
  }
  assert.deepEqual(h.state, before);
  assert.equal(h.commits.length, 0);
  h.fail(false);
  await h.commit(b, p);
  assert.equal(h.state.opportunities.length, 1);
  assert.equal(h.state.importReceipts.length, 1);
  assert.equal(h.commits.length, 1);
});
test('IC06 ordering dependent selected items does not duplicate vacancy and source digest ignores JSON formatting', async () => {
  const h = await harness(),
    a = { user: { email: h.owner.email } },
    payloads = [vacancy(), message(a)],
    b = h.batch(payloads),
    p = await h.stage(b);
  await h.commit(b, p, b.items.map((i) => i.itemId).reverse());
  assert.equal(h.state.opportunities.length, 1);
  assert.equal(h.state.messages[0].opportunityId, h.state.opportunities[0].id);
  assert.equal(h.state.historicalAttempts.length, 1);
  const before = structuredClone(h.state),
    r = await h.stage(h.batch(payloads, { pretty: true }));
  assert.ok(r.items.every((i) => i.status === 'duplicate'));
  assert.deepEqual(h.state, before);
});
test('IC07 missing bytes remain unavailable evidence; explicit false application assertion and unresolved/foreign parent refuse', async () => {
  const h = await harness(),
    a = { user: { email: h.owner.email } },
    m = message(a, {
      files: [],
      missingFiles: [{ name: 'submitted-original.pdf', reason: 'Original attachment unavailable' }],
    }),
    b = h.batch([vacancy(), m]),
    p = await h.stage(b);
  await h.commit(b, p);
  assert.equal(h.state.messages[0].files.length, 0);
  assert.ok(JSON.stringify(h.state.historicalAttempts[0]).includes('unavailable'));
  const invalid = message(a, {
      providerMessageId: 'unknown-parent',
      vacancySourceId: undefined,
      opportunityId: randomUUID(),
      attempt: undefined,
    }),
    next = await h.stage(h.batch([invalid]));
  assert.equal(next.items[0].status, 'rejected');
  assert.equal(h.state.messages.length, 1);
});
test('IC08 same company/title distinct posting URLs stay distinct; HTTP and HTTPS stay distinct; tracker-only variants dedupe', async () => {
  const h = await harness(),
    b = h.batch([
      vacancy(),
      vacancy({ sourceId: 'ja-job-2', url: 'https://careers.example.com/jobs/456' }),
      vacancy({ sourceId: 'ja-job-3', url: 'http://careers.example.com/jobs/123' }),
    ]),
    p = await h.stage(b);
  await h.commit(b, p);
  assert.equal(h.state.opportunities.length, 3);
  const next = h.batch([
      vacancy({
        sourceId: 'other-source-record',
        url: 'https://careers.example.com/jobs/123?utm_campaign=mail#section',
      }),
    ]),
    preview = await h.stage(next);
  assert.ok(['ready', 'duplicate'].includes(preview.items[0].status));
  await h.commit(next, preview);
  assert.equal(h.state.opportunities.length, 3);
  h.manager.cancel(h.owner, { batchId: next.batchId });
  const follow = h.batch([
      message({ user: { email: h.owner.email } }, { vacancySourceId: 'other-source-record' }),
    ]),
    followPreview = await h.stage(follow);
  assert.equal(followPreview.items[0].status, 'ready');
  await h.commit(follow, followPreview);
  assert.equal(h.state.messages[0].opportunityId, h.state.opportunities[0].id);
  assert.equal(h.state.opportunities.length, 3);
});
test('IC09 invalidate and close discard transient content; progress retains committed receipt after manager restart', async () => {
  const h = await harness(),
    b = h.batch([vacancy()]),
    p = await h.stage(b);
  await h.commit(b, p);
  const { createCareerImportManager } = await import(moduleURL),
    fresh = createCareerImportManager();
  const progress = await fresh.progress(h.owner, { batchId: b.batchId }, h.state);
  assert.ok(JSON.stringify(progress).includes(b.items[0].itemId));
  h.manager.invalidate(h.owner.accountId);
  await refuses(
    () => Promise.resolve().then(() => h.manager.preview(h.owner, { batchId: b.batchId }, h.state)),
    [404, 410],
  );
  h.manager.close();
  assert.equal(h.state.opportunities.length, 1);
});
test('IC10 malformed dates and recipient arrays never become fabricated import-time receipt or unowned correspondence', async () => {
  const h = await harness(),
    a = { user: { email: h.owner.email } },
    m = message(a, {
      attempt: undefined,
      sentAt: 'not-a-date',
      to: ['first@example.com'],
      cc: ['second@example.com'],
      bcc: ['third@example.com'],
    }),
    b = h.batch([vacancy(), m]),
    p = await h.stage(b);
  await h.commit(b, p);
  assert.equal(h.state.messages[0].sentAt, null);
  assert.equal(h.state.messages[0].timeStatus, 'invalid');
  const serialized = JSON.stringify(h.state.messages[0]);
  assert.ok(serialized.includes('second@example.com'));
  assert.ok(serialized.includes('third@example.com'));
  assert.ok(
    !serialized.includes(syntheticPdf.toString('base64')) || h.state.messages[0].files.length === 1,
  );
  assert.equal(
    digest(Buffer.from(h.state.messages[0].files[0].base64, 'base64')),
    digest(syntheticPdf),
  );
});
test('IC11 impossible source calendar dates remain invalid with original value retained; real leap-day stays valid', async () => {
  const h = await harness(),
    a = { user: { email: h.owner.email } },
    payloads = [
      vacancy(),
      ...['2026-02-30T10:00:00Z', '2026-02-29T10:00:00Z', '2028-02-29T10:00:00Z'].map((sentAt, i) =>
        message(a, { providerMessageId: 'calendar-' + i, sentAt, attempt: undefined, files: [] }),
      ),
    ],
    b = h.batch(payloads),
    p = await h.stage(b);
  await h.commit(b, p);
  assert.equal(h.state.messages.length, 3);
  for (let i = 0; i < 2; i++) {
    assert.equal(h.state.messages[i].sentAt, null);
    assert.equal(h.state.messages[i].timeStatus, 'invalid');
    assert.ok(
      JSON.stringify(h.state.messages[i]).includes(payloads[i + 1].sentAt),
      'Retain original invalid source date separately from normalized instant',
    );
  }
  assert.equal(h.state.messages[2].sentAt, '2028-02-29T10:00:00.000Z');
  assert.equal(h.state.messages[2].timeStatus, 'verified');
});
test('IC12 known reset and magic-login URLs in neutral career messages are rejected without exposing credentials in preview', async () => {
  for (const text of [
    'Continue at https://accounts.example/reset-password?token=synthetic-secret',
    'Continue at https://accounts.example/magic-login?code=synthetic-secret',
  ]) {
    const h = await harness(),
      a = { user: { email: h.owner.email } },
      b = h.batch([
        message(a, {
          subject: 'Application update',
          text,
          attempt: undefined,
          vacancySourceId: undefined,
          files: [],
        }),
      ]),
      p = await h.stage(b);
    assert.equal(p.items[0].status, 'rejected');
    assert.ok(!JSON.stringify(p).includes('synthetic-secret'));
    assert.equal(h.commits.length, 0);
    h.manager.close();
  }
});
test('IC13 two selected JA aliases for one posting share a vacancy and both support subsequent message links', async () => {
  const h = await harness(),
    b = h.batch([
      vacancy(),
      vacancy({
        sourceId: 'second-alias',
        url: 'https://careers.example.com/jobs/123?utm_medium=alert',
      }),
    ]),
    p = await h.stage(b);
  await h.commit(b, p);
  assert.equal(h.state.opportunities.length, 1);
  assert.equal(h.state.importReceipts.length, 2);
  h.manager.cancel(h.owner, { batchId: b.batchId });
  const m = h.batch([
      message({ user: { email: h.owner.email } }, { vacancySourceId: 'second-alias' }),
    ]),
    preview = await h.stage(m);
  assert.equal(preview.items[0].status, 'ready');
  await h.commit(m, preview);
  assert.equal(h.state.messages[0].opportunityId, h.state.opportunities[0].id);
});
test('IC14 rejected source items remain visibly pending review and are never counted as acknowledged or complete', async () => {
  const h = await harness(),
    a = { user: { email: h.owner.email } },
    b = h.batch([
      message(a, {
        namespace: 'independent-work',
        attempt: undefined,
        vacancySourceId: undefined,
        files: [],
      }),
    ]),
    p = await h.stage(b);
  assert.equal(p.items[0].status, 'rejected');
  const progress = await h.manager.progress(h.owner, { batchId: b.batchId }, h.state);
  assert.ok(
    progress.pending >= 1 || progress.rejected >= 1,
    'Rejected source must remain in reconciled nonterminal inventory',
  );
  assert.equal(progress.committed, 0);
  assert.equal(progress.excluded ?? 0, 0);
  assert.equal(h.state.importReceipts.length, 0);
});
test('IC15 cancellation can interrupt a running multi-item commit between atomic items', async () => {
  const h = await harness(),
    b = h.batch([
      vacancy(),
      vacancy({ sourceId: 'cancel-second', url: 'https://careers.example.com/jobs/999' }),
    ]),
    p = await h.stage(b),
    pending = h.commit(b, p);
  await new Promise((resolve) =>
    setImmediate(() => {
      h.manager.cancel(h.owner, { batchId: b.batchId });
      resolve();
    }),
  );
  const result = await pending;
  assert.ok(
    h.state.opportunities.length < 2,
    'A running batch must yield so cancellation can prevent a not-yet-committed item',
  );
  assert.ok(result.items.some((i) => i.status !== 'committed'));
  assert.equal(h.state.importReceipts.length, h.state.opportunities.length);
});
test('IC16 concurrent commit on one preview refuses overlap without releasing the admitted commit guard', async () => {
  const h = await harness(),
    b = h.batch([vacancy()]),
    p = await h.stage(b),
    first = h.commit(b, p);
  await assert.rejects(
    () => h.commit(b, p),
    (e) => e.status === 409,
  );
  await first;
  assert.equal(h.state.opportunities.length, 1);
  assert.equal(h.state.importReceipts.length, 1);
  assert.equal(h.commits.length, 1);
});
test('IC17 expiration during yielded commit prevents the next atomic item', async () => {
  const h = await harness(),
    b = h.batch([vacancy()]),
    p = await h.stage(b),
    pending = h.commit(b, p);
  h.advance(30 * 60000 + 1);
  try {
    const result = await pending;
    assert.ok(result.items.every((i) => i.status !== 'committed'));
  } catch (e) {
    assert.ok([404, 410].includes(e.status));
  }
  assert.equal(h.state.opportunities.length, 0);
  assert.equal(h.commits.length, 0);
});
