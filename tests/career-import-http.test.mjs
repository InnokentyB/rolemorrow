import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  setup,
  bundle,
  stage,
  commit,
  state,
  vacancy,
  message,
  syntheticPdf,
  digest,
} from './import-fixtures.mjs';
import { profile } from './fixtures.mjs';
test('CI01 preview is private and read-only; explicit commit preserves original sent CV, chronology and application evidence', async (t) => {
  const h = await setup(t),
    a = await h.account('import-owner@example.test');
  await h.call('/api/profile', { cookie: a.cookie, body: profile });
  const before = await state(h, a),
    b = bundle(a, [vacancy(), message(a)]),
    p = await stage(h, a, b);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.ok(p.data.previewHash);
  assert.equal(p.data.items.filter((i) => i.status === 'ready').length, 2);
  assert.deepEqual(await state(h, a), before);
  const r = await commit(h, a, b, p);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.items.filter((i) => i.status === 'committed').length, 2);
  const s = await state(h, a);
  assert.equal(s.opportunities.length, 1);
  assert.equal(s.opportunities[0].stage, 'saved');
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].origin, 'gmail-import');
  assert.equal(s.messages[0].direction, 'outbound');
  assert.equal(s.messages[0].sentAt, '2026-10-20T10:15:00.000Z');
  assert.equal(s.historicalAttempts.length, 1);
  assert.equal(s.mailDispatches.length, 0);
  assert.deepEqual(s.profile, before.profile);
  assert.equal(s.applications.length, 0);
  assert.equal(s.importReceipts.length, 2);
  assert.equal(s.notifications.length, 1);
  const m = s.messages[0],
    f = m.files[0];
  const downloaded = await fetch(h.base + '/api/message-files/' + m.id + '/' + f.id, {
    headers: { Cookie: a.cookie },
    redirect: 'manual',
  });
  assert.equal(downloaded.status, 200);
  assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())), digest(syntheticPdf));
  const audit = (await h.call('/api/audit', { cookie: a.cookie })).data.events;
  assert.ok(audit.some((e) => e.action === 'career-import'));
  assert.ok(!audit.some((e) => e.action === 'inbound-match'));
  assert.ok(!JSON.stringify(audit).includes(syntheticPdf.toString('base64')));
});
test('CI02 identical batch and cross-batch normalized replays create no duplicate entities, attempts, notifications or audit', async (t) => {
  const h = await setup(t),
    a = await h.account('import-repeat@example.test'),
    payloads = [vacancy(), message(a)],
    b = bundle(a, payloads),
    p = await stage(h, a, b);
  assert.equal((await commit(h, a, b, p)).status, 200);
  const first = await state(h, a),
    audit = (await h.call('/api/audit', { cookie: a.cookie })).data;
  const again = await commit(h, a, b, p);
  assert.equal(again.status, 200);
  assert.deepEqual(await state(h, a), first);
  const next = bundle(a, payloads, { pretty: true }),
    preview = await stage(h, a, next);
  assert.equal(preview.status, 200);
  assert.ok(preview.data.items.every((i) => i.status === 'duplicate'));
  assert.equal((await commit(h, a, next, preview)).status, 200);
  assert.deepEqual(await state(h, a), first);
  assert.deepEqual((await h.call('/api/audit', { cookie: a.cookie })).data, audit);
});
test('CI03 changed source message identity conflicts without replacing historical bytes', async (t) => {
  const h = await setup(t),
    a = await h.account('import-conflict@example.test'),
    b = bundle(a, [vacancy(), message(a)]),
    p = await stage(h, a, b);
  await commit(h, a, b, p);
  const before = await state(h, a),
    changed = bundle(a, [
      message(a, { text: 'Changed content cannot overwrite submitted history.' }),
    ]),
    preview = await stage(h, a, changed);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.items[0].status, 'conflict');
  const r = await commit(h, a, changed, preview);
  assert.ok(r.status >= 400 || r.data.items.every((i) => i.status !== 'committed'));
  assert.deepEqual(await state(h, a), before);
});
test('CI04 foreign preview access, forged selection/hash and cross-origin writes refuse with unchanged durable state', async (t) => {
  const h = await setup(t),
    a = await h.account('import-private@example.test'),
    foreign = await h.account('import-foreign@example.test'),
    b = bundle(a, [vacancy()]),
    p = await stage(h, a, b),
    before = await state(h, a);
  for (const action of ['preview', 'progress', 'cancel'])
    assert.equal(
      (
        await h.call('/api/imports/' + action, {
          cookie: foreign.cookie,
          body: { batchId: b.batchId },
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await h.call('/api/imports/commit', {
        cookie: foreign.cookie,
        body: { batchId: b.batchId, previewHash: p.data.previewHash, itemIds: [b.items[0].itemId] },
      })
    ).status,
    404,
  );
  assert.ok((await commit(h, a, b, { data: { previewHash: '0'.repeat(64) } })).status >= 400);
  assert.ok((await commit(h, a, b, p, [randomUUID()])).status >= 400);
  assert.equal(
    (
      await h.call('/api/imports/commit', {
        cookie: a.cookie,
        origin: 'https://evil.example',
        body: { batchId: b.batchId, previewHash: p.data.previewHash, itemIds: [b.items[0].itemId] },
      })
    ).status,
    403,
  );
  assert.deepEqual(await state(h, a), before);
  assert.equal((await state(h, foreign)).opportunities.length, 0);
});
test('CI05 an unrelated edit or clear invalidates a preview; no stale source reappears', async (t) => {
  const h = await setup(t),
    a = await h.account('import-stale@example.test'),
    b = bundle(a, [vacancy()]),
    p = await stage(h, a, b);
  await h.call('/api/profile', { cookie: a.cookie, body: profile });
  const before = await state(h, a);
  assert.equal((await commit(h, a, b, p)).status, 409);
  assert.deepEqual(await state(h, a), before);
  const fresh = bundle(a, [vacancy({ sourceId: 'another' })]),
    preview = await stage(h, a, fresh);
  assert.equal(
    (await h.call('/api/data', { cookie: a.cookie, method: 'DELETE', body: { confirm: true } }))
      .status,
    200,
  );
  const cleared = await state(h, a);
  assert.ok((await commit(h, a, fresh, preview)).status >= 400);
  assert.deepEqual(await state(h, a), cleared);
});
test('CI06 partial selection and cancellation preserve committed receipts and do not claim whole-batch success', async (t) => {
  const h = await setup(t),
    a = await h.account('import-partial@example.test'),
    b = bundle(a, [
      vacancy(),
      vacancy({ sourceId: 'ja-job-2', url: 'https://careers.example.com/jobs/456' }),
    ]),
    p = await stage(h, a, b);
  const r = await commit(h, a, b, p, [b.items[0].itemId]);
  assert.equal(r.status, 200);
  assert.equal((await state(h, a)).opportunities.length, 1);
  assert.equal(
    (await h.call('/api/imports/cancel', { cookie: a.cookie, body: { batchId: b.batchId } }))
      .status,
    200,
  );
  const progress = await h.call('/api/imports/progress', {
    cookie: a.cookie,
    body: { batchId: b.batchId },
  });
  assert.equal(progress.status, 200);
  assert.ok(JSON.stringify(progress.data).includes(b.items[0].itemId));
  assert.equal((await state(h, a)).importReceipts.length, 1);
  assert.ok((await commit(h, a, b, p, [b.items[1].itemId])).status >= 400);
});
test('CI07 historical incoming rejection remains evidence, never regresses the saved stage or marks a new live reply', async (t) => {
  const h = await setup(t),
    a = await h.account('import-incoming@example.test'),
    incoming = message(a, {
      providerMessageId: 'received-1',
      from: 'talent@example.com',
      to: [a.user.email],
      subject: 'Application update',
      text: 'We regret to advise we will not be progressing your application.',
      sentAt: null,
      receivedAt: '2026-10-19T10:00:00.000Z',
      attempt: undefined,
      files: [],
    }),
    b = bundle(a, [vacancy(), incoming]),
    p = await stage(h, a, b);
  assert.equal((await commit(h, a, b, p)).status, 200);
  const s = await state(h, a);
  assert.equal(s.messages[0].direction, 'inbound');
  assert.equal(s.messages[0].receivedAt, '2026-10-19T10:00:00.000Z');
  assert.equal(s.historicalAttempts.length, 0);
  assert.equal(s.opportunities[0].stage, 'saved');
  assert.equal(s.notifications.length, 1);
  assert.ok(
    !s.notifications.some((n) => /new reply|recruiter reply/i.test(n.title ?? n.text ?? '')),
  );
});
test('CI08 outbound scheduling mail with a file does not invent an application attempt; unknown source time stays unknown', async (t) => {
  const h = await setup(t),
    a = await h.account('import-scheduling@example.test'),
    m = message(a, {
      subject: 'Interview availability',
      text: 'Thank you; Tuesday works for me.',
      attempt: undefined,
      sentAt: null,
    }),
    b = bundle(a, [vacancy(), m]),
    p = await stage(h, a, b);
  assert.equal((await commit(h, a, b, p)).status, 200);
  const s = await state(h, a);
  assert.equal(s.historicalAttempts.length, 0);
  assert.equal(s.messages[0].sentAt, null);
  assert.equal(s.messages[0].timeStatus, 'unknown');
});
test('CI09 historical live actions refuse and preserve source mail, packet, stages and outbox', async (t) => {
  const h = await setup(t),
    a = await h.account('import-no-send@example.test'),
    b = bundle(a, [vacancy(), message(a)]),
    p = await stage(h, a, b);
  await commit(h, a, b, p);
  const before = await state(h, a),
    id = before.messages[0].id;
  for (const action of ['replies', 'tasks', 'proposals', 'analysis', 'link']) {
    const r = await h.call('/api/mail/' + action + '/' + id, {
      cookie: a.cookie,
      body: { revision: 0, body: 'Do not send', done: true, decisionRevision: 0 },
    });
    assert.ok(r.status >= 400, action);
  }
  assert.deepEqual(await state(h, a), before);
});
test('CI10 chunk retry idempotence, conflicting data, wrong lengths and digest mismatch cannot become ready', async (t) => {
  const h = await setup(t),
    a = await h.account('import-chunks@example.test'),
    b = bundle(a, [vacancy()]);
  const begin = { batchId: b.batchId, sourceAccount: b.sourceAccount, items: b.items };
  assert.equal((await h.call('/api/imports/begin', { cookie: a.cookie, body: begin })).status, 200);
  assert.equal((await h.call('/api/imports/begin', { cookie: a.cookie, body: begin })).status, 200);
  const chunk = {
    batchId: b.batchId,
    itemId: b.items[0].itemId,
    index: 0,
    data: b.records[0].payload.toString('base64'),
  };
  assert.equal((await h.call('/api/imports/chunk', { cookie: a.cookie, body: chunk })).status, 200);
  assert.equal((await h.call('/api/imports/chunk', { cookie: a.cookie, body: chunk })).status, 200);
  assert.equal(
    (
      await h.call('/api/imports/chunk', {
        cookie: a.cookie,
        body: { ...chunk, data: Buffer.alloc(b.records[0].payload.length, 120).toString('base64') },
      })
    ).status,
    409,
  );
  assert.ok(
    (await h.call('/api/imports/chunk', { cookie: a.cookie, body: { ...chunk, index: 8 } }))
      .status >= 400,
  );
  const wrong = bundle(a, [vacancy()]);
  wrong.items[0].sha256 = '0'.repeat(64);
  const p = await stage(h, a, wrong);
  assert.ok(p.status >= 400 || p.data.items[0].status === 'rejected');
  assert.equal((await state(h, a)).opportunities.length, 0);
});
test('CI11 scoped MCP import requires separately consented authority and preserves agent attribution', async (t) => {
  const h = await setup(t),
    a = await h.account('import-mcp@example.test'),
    ordinary = await h.grant(a, 'mcp:read mcp:write'),
    b = bundle(a, [vacancy()]);
  const input = { batchId: b.batchId, sourceAccount: b.sourceAccount, items: b.items };
  assert.ok((await h.tool(ordinary.access_token, 'begin_import', input)).error);
  const authorized = await h.grant(a, 'mcp:read mcp:write mcp:import');
  assert.ok(!(await h.tool(authorized.access_token, 'begin_import', input)).error);
  const item = b.records[0];
  assert.ok(
    !(
      await h.tool(authorized.access_token, 'stage_import_chunk', {
        batchId: b.batchId,
        itemId: item.itemId,
        index: 0,
        data: item.payload.toString('base64'),
      })
    ).error,
  );
  const p = await h.tool(authorized.access_token, 'preview_import', { batchId: b.batchId });
  assert.ok(p.previewHash);
  assert.ok(
    !(
      await h.tool(authorized.access_token, 'commit_import', {
        batchId: b.batchId,
        previewHash: p.previewHash,
        itemIds: [item.itemId],
      })
    ).error,
  );
  const events = (await h.call('/api/audit', { cookie: a.cookie })).data.events;
  assert.ok(
    events.some(
      (e) =>
        e.action === 'career-import' && e.actor.type === 'agent' && /delegated/.test(e.actor.role),
    ),
  );
  assert.equal((await state(h, a)).mailDispatches.length, 0);
});
test('CI12 revoked originating MCP grant cannot commit a staged import', async (t) => {
  const h = await setup(t),
    a = await h.account('import-revoked@example.test'),
    g = await h.grant(a, 'mcp:read mcp:write mcp:import'),
    b = bundle(a, [vacancy()]);
  await h.tool(g.access_token, 'begin_import', {
    batchId: b.batchId,
    sourceAccount: b.sourceAccount,
    items: b.items,
  });
  const item = b.records[0];
  await h.tool(g.access_token, 'stage_import_chunk', {
    batchId: b.batchId,
    itemId: item.itemId,
    index: 0,
    data: item.payload.toString('base64'),
  });
  const p = await h.tool(g.access_token, 'preview_import', { batchId: b.batchId });
  const list = await h.call('/api/connections', { cookie: a.cookie });
  await h.call('/api/connections/' + list.data.connections[0].id + '/revoke', {
    cookie: a.cookie,
    body: {},
  });
  assert.equal(
    (
      await h.rpc(g.access_token, 'tools/call', {
        name: 'commit_import',
        arguments: { batchId: b.batchId, previewHash: p.previewHash, itemIds: [item.itemId] },
      })
    ).status,
    401,
  );
  assert.equal((await state(h, a)).opportunities.length, 0);
});
test('CI13 private source account, Independent Work, authentication mail and unsupplied URLs cannot be silently imported', async (t) => {
  const h = await setup(t),
    a = await h.account('import-excluded@example.test'),
    wrong = bundle(a, [vacancy()]);
  assert.ok(
    (
      await h.call('/api/imports/begin', {
        cookie: a.cookie,
        body: {
          batchId: wrong.batchId,
          sourceAccount: 'someone-else@example.test',
          items: wrong.items,
        },
      })
    ).status >= 400,
  );
  for (const payload of [
    vacancy({ namespace: 'independent-work' }),
    message(a, {
      subject: 'Security code for your application',
      text: 'Your authentication code is 123456',
      attempt: undefined,
      vacancySourceId: undefined,
    }),
  ]) {
    const b = bundle(a, [payload]);
    const begin = await h.call('/api/imports/begin', {
      cookie: a.cookie,
      body: { batchId: b.batchId, sourceAccount: b.sourceAccount, items: b.items },
    });
    if (begin.status === 200) {
      const p = await stage(h, a, b);
      assert.ok(p.status >= 400 || p.data.items.every((i) => i.status === 'rejected'));
    } else assert.ok(begin.status >= 400);
  }
  assert.equal((await state(h, a)).messages.length, 0);
  const stub = bundle(a, [vacancy({ sourceId: 'email-only', url: null })]),
    p = await stage(h, a, stub);
  assert.equal((await commit(h, a, stub, p)).status, 200);
  assert.equal((await state(h, a)).opportunities[0].snapshot.url, null);
});
test('CI14 same account different session or grant cannot take over another principal preview; logout invalidates session staging', async (t) => {
  const h = await setup(t),
    a = await h.account('import-session@example.test'),
    b = bundle(a, [vacancy()]),
    p = await stage(h, a, b);
  const login = await h.call('/api/account/login', {
      body: { email: a.user.email, password: 'Synthetic-MCP-Password-2026!' },
    }),
    other = { ...a, cookie: login.cookies.find((c) => c.startsWith('rm_session=')).split(';')[0] };
  assert.equal((await commit(h, other, b, p)).status, 404);
  assert.equal((await state(h, a)).opportunities.length, 0);
  await h.call('/api/account/logout', { cookie: a.cookie, body: {} });
  assert.equal((await commit(h, a, b, p)).status, 401);
  assert.equal((await state(h, other)).opportunities.length, 0);
});
test('CI15 selected child without its parent cannot materialize an attempt, notification or false receipt', async (t) => {
  const h = await setup(t),
    a = await h.account('import-child@example.test'),
    b = bundle(a, [vacancy(), message(a)]),
    p = await stage(h, a, b),
    before = await state(h, a);
  const result = await commit(h, a, b, p, [b.items[1].itemId]);
  assert.ok(result.status >= 400 || result.data.items.every((i) => i.status !== 'committed'));
  assert.deepEqual(await state(h, a), before);
});
test('CI16 attachment-only source changes conflict and retain the original submitted bytes', async (t) => {
  const h = await setup(t),
    a = await h.account('import-file-conflict@example.test'),
    b = bundle(a, [vacancy(), message(a)]),
    p = await stage(h, a, b);
  await commit(h, a, b, p);
  const before = await state(h, a),
    modified = message(a, {
      files: [
        {
          name: 'submitted-original.pdf',
          type: 'application/pdf',
          base64: Buffer.from('%PDF-1.4\nA different submitted version\n%%EOF').toString('base64'),
        },
      ],
    }),
    newBatch = bundle(a, [modified]),
    preview = await stage(h, a, newBatch);
  assert.equal(preview.data.items[0].status, 'conflict');
  const result = await commit(h, a, newBatch, preview);
  assert.ok(result.status >= 400 || result.data.items.every((i) => i.status !== 'committed'));
  assert.deepEqual(await state(h, a), before);
});
test('CI17 a second grant cannot own another grant preview; downscoping removes import commit authority', async (t) => {
  const h = await setup(t),
    a = await h.account('import-grant-owner@example.test'),
    g = await h.grant(a, 'mcp:read mcp:write mcp:import'),
    other = await h.grant(a, 'mcp:read mcp:write mcp:import'),
    b = bundle(a, [vacancy()]);
  await h.tool(g.access_token, 'begin_import', {
    batchId: b.batchId,
    sourceAccount: b.sourceAccount,
    items: b.items,
  });
  const item = b.records[0];
  await h.tool(g.access_token, 'stage_import_chunk', {
    batchId: b.batchId,
    itemId: item.itemId,
    index: 0,
    data: item.payload.toString('base64'),
  });
  const p = await h.tool(g.access_token, 'preview_import', { batchId: b.batchId });
  assert.ok(
    (
      await h.tool(other.access_token, 'commit_import', {
        batchId: b.batchId,
        previewHash: p.previewHash,
        itemIds: [item.itemId],
      })
    ).error,
  );
  const rotated = await h.call('/oauth/token', {
    form: true,
    origin: null,
    body: {
      grant_type: 'refresh_token',
      client_id: g.params.client_id,
      resource: g.params.resource,
      refresh_token: g.refresh_token,
      scope: 'mcp:read mcp:write',
    },
  });
  assert.equal(rotated.status, 200);
  assert.ok(
    (
      await h.tool(rotated.data.access_token, 'commit_import', {
        batchId: b.batchId,
        previewHash: p.previewHash,
        itemIds: [item.itemId],
      })
    ).error,
  );
  assert.equal((await state(h, a)).opportunities.length, 0);
});
test('CI18 HTTP cancellation of an admitted multi-item batch preserves exact partial receipts without importing the remaining items', async (t) => {
  const h = await setup(t),
    a = await h.account('import-http-cancel@example.test'),
    payloads = Array.from({ length: 50 }, (_, i) =>
      message(a, {
        providerMessageId: 'http-cancel-' + i,
        subject: 'Career correspondence ' + i,
        text: 'A historical career message. ' + 'Evidence only. '.repeat(700),
        vacancySourceId: undefined,
        attempt: undefined,
        files: [],
      }),
    ),
    b = bundle(a, payloads),
    p = await stage(h, a, b);
  assert.equal(p.status, 200);
  const pending = commit(h, a, b, p);
  await new Promise((r) => setTimeout(r, 1));
  const cancelled = await h.call('/api/imports/cancel', {
    cookie: a.cookie,
    body: { batchId: b.batchId },
  });
  assert.equal(cancelled.status, 200);
  const result = await pending;
  assert.ok(result.status === 200 || [404, 409, 410].includes(result.status));
  const s = await state(h, a);
  assert.ok(s.messages.length < 50);
  assert.equal(s.importReceipts.length, s.messages.length);
  assert.equal(s.mailDispatches.length, 0);
  assert.ok(s.notifications.length <= 1);
});
