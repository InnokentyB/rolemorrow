import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createPublicServer } from '../app/public-server.mjs';
import { profile, companies } from './fixtures.mjs';
const password = 'Synthetic-MCP-Password-2026!',
  verifier = 'm'.repeat(43),
  challenge = createHash('sha256').update(verifier).digest('base64url');
async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-http-')),
    sock = net.createServer();
  await new Promise((r) => sock.listen(0, '127.0.0.1', r));
  const port = sock.address().port;
  await new Promise((r) => sock.close(r));
  const base = 'http://127.0.0.1:' + port,
    outbox = [];
  const env = {
    PUBLIC_ORIGIN: base,
    PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
    PUBLIC_REGISTRATION_ENABLED: '1',
    MCP_ENABLED: '1',
    ALLOW_LIVE: '0',
    ORGANIZATION_REFRESH_ENABLED: '0',
    ORGANIZATION_DISCOVERY_ENABLED: '0',
    ...(extra.env ?? {}),
  };
  const server = await createPublicServer({
    ...extra,
    storeDir: dir,
    env,
    sendAccountMail: async (m) => outbox.push(m),
    mailProvider: {
      send: async () => {
        throw Error('No live mail');
      },
      receive: async () => {
        throw Error('No live receive');
      },
    },
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  async function call(
    path,
    {
      body,
      method = body === undefined ? 'GET' : 'POST',
      cookie,
      token,
      origin = base,
      form = false,
      headers = {},
    } = {},
  ) {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(origin ? { Origin: origin } : {}),
        Connection: 'close',
        ...(body === undefined
          ? {}
          : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body:
        body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const frames = text
          .split(/\r?\n\r?\n/)
          .map((frame) =>
            frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n'),
          )
          .filter(Boolean)
          .map((raw) => JSON.parse(raw));
        data = frames.find((frame) => frame.id === body?.id) ?? frames.at(-1);
      } else data = text;
    }
    return { status: r.status, data, headers: r.headers, cookies: r.headers.getSetCookie() };
  }
  async function account(email) {
    await call('/api/account/register', { body: { name: 'MCP Candidate', email, password } });
    const mail = outbox.find((m) => m.to === email || m.to?.includes?.(email));
    assert.ok(mail);
    const token = mail.token ?? JSON.stringify(mail).match(/[?&]verify=([^\s"'<>\\]+)/)?.[1];
    assert.ok(token);
    assert.equal((await call('/api/account/verify', { body: { token } })).status, 200);
    const login = await call('/api/account/login', { body: { email, password } });
    assert.equal(login.status, 200);
    return {
      cookie: login.cookies.find((c) => c.startsWith('rm_session=')).split(';')[0],
      user: login.data.user,
    };
  }
  const oauthParams = (scope = 'mcp:read mcp:write mcp:prepare') => ({
    response_type: 'code',
    client_id: 'rolemorrow-codex',
    redirect_uri: 'http://127.0.0.1:41239/callback',
    resource: base + '/mcp',
    scope,
    state: 'state-' + randomUUID(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  async function grant(a, scope) {
    const p = oauthParams(scope);
    const page = await call('/oauth/authorize?' + new URLSearchParams(p), { cookie: a.cookie });
    assert.equal(page.status, 200, JSON.stringify(page.data));
    const requestId = page.data.match(/name=["']requestId["'][^>]*value=["']([^"']+)/)?.[1];
    assert.ok(requestId, 'Consent page must bind a server-held authorization request');
    const consent = await call('/api/connections/authorize', {
      cookie: a.cookie,
      body: { requestId, consent: true },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
    const code = new URL(consent.data.redirectTo).searchParams.get('code');
    assert.ok(code);
    const exchange = await call('/oauth/token', {
      form: true,
      origin: null,
      body: {
        grant_type: 'authorization_code',
        client_id: p.client_id,
        redirect_uri: p.redirect_uri,
        resource: p.resource,
        code,
        code_verifier: verifier,
      },
    });
    assert.equal(exchange.status, 200, JSON.stringify(exchange.data));
    return { ...exchange.data, params: p };
  }
  let rpcId = 0;
  async function rpc(token, method, args = {}, extra = {}) {
    return call('/mcp', {
      token,
      origin: null,
      body: { jsonrpc: '2.0', id: ++rpcId, method, params: args },
      headers: {
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
      },
      ...extra,
    });
  }
  async function tool(token, name, args = {}) {
    const r = await rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.error) return { error: r.data.error };
    const result = r.data.result;
    if (result?.isError) return { error: result };
    return (
      result?.structuredContent ?? JSON.parse(result.content.find((x) => x.type === 'text').text)
    );
  }
  return { base, dir, server, call, account, oauthParams, grant, rpc, tool };
}
test('MH01 discovery, cookie consent and real OAuth exchange; only Bearer enables MCP and web keeps CSRF', async (t) => {
  const h = await setup(t);
  const d = await h.call('/.well-known/oauth-authorization-server');
  assert.equal(d.status, 200);
  assert.equal(d.data.issuer, h.base);
  assert.ok(d.data.code_challenge_methods_supported.includes('S256'));
  const a = await h.account('mcp-one@example.test'),
    g = await h.grant(a);
  const anonymous = await h.rpc(undefined, 'tools/list');
  assert.equal(anonymous.status, 401);
  assert.equal((await h.rpc(undefined, 'tools/list', {}, { cookie: a.cookie })).status, 401);
  const tools = await h.rpc(g.access_token, 'tools/list');
  assert.equal(tools.status, 200);
  assert.ok(tools.data.result.tools.some((x) => x.name === 'get_updates'));
  assert.ok(!tools.data.result.tools.some((x) => /send|dispatch|scan|delete_account/.test(x.name)));
  assert.equal((await h.call('/api/state', { token: g.access_token })).status, 401);
  assert.equal(
    (
      await h.call('/api/profile', {
        cookie: a.cookie,
        origin: 'https://evil.example',
        body: profile,
      })
    ).status,
    403,
  );
  assert.equal(
    (await h.rpc(g.access_token, 'tools/list', {}, { origin: 'https://evil.example' })).status,
    403,
  );
});
test('MH02 browser consent requires verified session and same-origin; scopes never silently expand', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-consent@example.test'),
    p = h.oauthParams('mcp:read');
  assert.equal(
    (await h.call('/api/connections/authorize', { body: { ...p, consent: true } })).status,
    401,
  );
  assert.equal(
    (
      await h.call('/api/connections/authorize', {
        cookie: a.cookie,
        origin: 'https://evil.example',
        body: { ...p, consent: true },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.call('/api/connections/authorize', {
        cookie: a.cookie,
        body: { ...p, consent: false },
      })
    ).status,
    400,
  );
  const g = await h.grant(a, 'mcp:read');
  const before = await h.call('/api/state', { cookie: a.cookie });
  const denied = await h.tool(g.access_token, 'save_vacancy', {
    resultKey: 'forged',
    baseRevision: before.data.revision,
  });
  assert.ok(denied.error);
  const after = await h.call('/api/state', { cookie: a.cookie });
  assert.deepEqual(after.data, before.data);
});
test('MH03 same account profile and saved vacancies, explicit delegated packet writes and no foreign data', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-owner@example.test'),
    b = await h.account('mcp-foreign@example.test');
  await h.call('/api/profile', { cookie: a.cookie, body: profile });
  await h.call('/api/companies', { cookie: a.cookie, body: { companies } });
  assert.equal(
    (await h.call('/api/scans', { cookie: a.cookie, body: { mode: 'fixture' } })).status,
    202,
  );
  let s;
  for (let i = 0; i < 100; i++) {
    s = (await h.call('/api/state', { cookie: a.cookie })).data;
    if (s.run?.status === 'complete') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(s.run.status, 'complete');
  const g = await h.grant(a),
    foreign = await h.grant(b);
  const p = await h.tool(g.access_token, 'get_profile');
  assert.equal(p.profile.version, s.profile.version);
  assert.ok(
    !JSON.stringify(await h.tool(foreign.access_token, 'get_profile')).includes(
      'AI product evaluation',
    ),
  );
  const saved = await h.tool(g.access_token, 'save_vacancy', {
    resultKey: s.run.results[0].key,
    baseRevision: s.revision,
  });
  assert.ok(!saved.error, JSON.stringify(saved));
  s = (await h.call('/api/state', { cookie: a.cookie })).data;
  const o = s.opportunities[0];
  assert.ok(o);
  const packet = await h.tool(g.access_token, 'save_application', {
    opportunityId: o.id,
    revision: 0,
    cvVersion: 'MCP reviewed',
    cvText: 'Confirmed synthetic profile facts.',
    coverLetter: 'Separate letter.',
    answers: 'Unknown remains unknown.',
  });
  assert.ok(!packet.error, JSON.stringify(packet));
  const audit = (await h.call('/api/audit', { cookie: a.cookie })).data;
  assert.ok(
    audit.events.some(
      (e) =>
        e.action === 'packet-save' && e.actor.type === 'agent' && /delegated/.test(e.actor.role),
    ),
  );
  assert.ok((await h.tool(foreign.access_token, 'get_application', { opportunityId: o.id })).error);
  assert.equal((await h.call('/api/state', { cookie: b.cookie })).data.opportunities.length, 0);
});
test('MH04 updates persist cursor without marking read, are account-bound and invalidate after workspace clear', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-updates@example.test'),
    b = await h.account('mcp-updates-b@example.test'),
    g = await h.grant(a),
    f = await h.grant(b);
  await h.call('/api/profile', { cookie: a.cookie, body: profile });
  const first = await h.tool(g.access_token, 'get_updates', { limit: 100 });
  assert.ok(first.nextCursor);
  const second = await h.tool(g.access_token, 'get_updates', { cursor: first.nextCursor });
  assert.equal(second.events.length, 0);
  assert.ok((await h.tool(f.access_token, 'get_updates', { cursor: first.nextCursor })).error);
  const cleared = await h.call('/api/data', {
    cookie: a.cookie,
    method: 'DELETE',
    body: { confirm: true },
  });
  assert.equal(cleared.status, 200);
  const reset = await h.tool(g.access_token, 'get_updates', { cursor: first.nextCursor });
  assert.equal(reset.reset, true);
  assert.ok(reset.nextCursor);
});
test('MH05 connection list/revoke scoped to account; revoked MCP cannot execute or expose tokens', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-revoke@example.test'),
    b = await h.account('mcp-revoke-b@example.test'),
    g = await h.grant(a);
  const list = await h.call('/api/connections', { cookie: a.cookie });
  assert.equal(list.status, 200);
  assert.ok(list.data.connections.length);
  assert.ok(!JSON.stringify(list.data).includes(g.access_token));
  const id = list.data.connections[0].id;
  assert.equal(
    (await h.call('/api/connections/' + id + '/revoke', { cookie: b.cookie, body: {} })).status,
    404,
  );
  assert.equal(
    (await h.call('/api/connections/' + id + '/revoke', { cookie: a.cookie, body: {} })).status,
    200,
  );
  assert.equal((await h.rpc(g.access_token, 'tools/list')).status, 401);
});
test('MH06 authorization nonce is one-use and bound to the signed-in account and requested rights', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-nonce-a@example.test'),
    b = await h.account('mcp-nonce-b@example.test'),
    p = h.oauthParams('mcp:read');
  const page = await h.call('/oauth/authorize?' + new URLSearchParams(p), { cookie: a.cookie });
  assert.equal(page.status, 200);
  const requestId = page.data.match(/name=["']requestId["'][^>]*value=["']([^"']+)/)?.[1];
  assert.ok(requestId);
  assert.equal(
    (
      await h.call('/api/connections/authorize', {
        cookie: b.cookie,
        body: { requestId, consent: true },
      })
    ).status,
    404,
  );
  const accepted = await h.call('/api/connections/authorize', {
    cookie: a.cookie,
    body: { requestId, consent: true },
  });
  assert.equal(accepted.status, 200);
  assert.ok(
    [400, 404, 409].includes(
      (
        await h.call('/api/connections/authorize', {
          cookie: a.cookie,
          body: { requestId, consent: true },
        })
      ).status,
    ),
  );
  assert.equal((await h.call('/api/connections', { cookie: a.cookie })).data.connections.length, 1);
});
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
test('MH07 official MCP client connects over real HTTP to the same owned business tools', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-sdk@example.test'),
    g = await h.grant(a, 'mcp:read');
  const client = new Client({ name: 'Rolemorrow independent SDK oracle', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(h.base + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + g.access_token } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'get_updates'));
  const result = await client.callTool({ name: 'get_profile', arguments: {} });
  assert.ok(!result.isError);
  assert.ok(result.content.some((x) => x.type === 'text'));
});

import { fixturePreparation } from '../app/application-preparation.mjs';
async function candidate(h, a) {
  assert.equal((await h.call('/api/profile', { cookie: a.cookie, body: profile })).status, 200);
  await h.call('/api/companies', { cookie: a.cookie, body: { companies } });
  assert.equal(
    (await h.call('/api/scans', { cookie: a.cookie, body: { mode: 'fixture' } })).status,
    202,
  );
  let s;
  for (let i = 0; i < 100; i++) {
    s = (await h.call('/api/state', { cookie: a.cookie })).data;
    if (s.run?.status === 'complete') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(s.run.status, 'complete');
  assert.equal(
    (
      await h.call('/api/opportunities', {
        cookie: a.cookie,
        body: { resultKey: s.run.results[0].key, baseRevision: s.revision },
      })
    ).status,
    200,
  );
  s = (await h.call('/api/state', { cookie: a.cookie })).data;
  return {
    opportunityId: s.opportunities[0].id,
    baseRevision: s.revision,
    revision: 0,
    profileVersion: s.profile.version,
    questions: [],
    consent: true,
    requestId: randomUUID(),
  };
}
test('MH08 preparation shares web quota and durable replay identity, preserves packet and attributes delegated actor', async (t) => {
  let calls = 0;
  const h = await setup(t, {
      env: { PUBLIC_PREPARATIONS_PER_DAY: '1' },
      preparationProvider: async (...args) => {
        calls++;
        return fixturePreparation(...args);
      },
    }),
    a = await h.account('mcp-prepare@example.test'),
    args = await candidate(h, a),
    g = await h.grant(a);
  const prepared = await h.tool(g.access_token, 'prepare_application', args);
  assert.ok(!prepared.error, JSON.stringify(prepared));
  assert.ok(prepared.draft.cvText);
  assert.equal(calls, 1);
  const { opportunityId, ...body } = args;
  const replay = await h.call('/api/applications/' + opportunityId + '/prepare', {
    cookie: a.cookie,
    body,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.equal(calls, 1);
  const denied = await h.tool(g.access_token, 'prepare_application', {
    ...args,
    requestId: randomUUID(),
  });
  assert.ok(denied.error);
  assert.equal(calls, 1);
  const state = (await h.call('/api/state', { cookie: a.cookie })).data;
  assert.equal(state.applications.length, 0);
  const events = (await h.call('/api/audit', { cookie: a.cookie })).data.events;
  const starts = events.filter((e) => e.action === 'preparation:request' && e.status === 'start');
  assert.equal(starts.length, 2);
  assert.ok(
    starts.every((e) => e.actor.type === 'agent' && /delegated/.test(e.actor.role) && e.actor.id),
  );
  for (const start of starts)
    assert.ok(
      events.some((e) => e.spanId === start.spanId && e.status !== 'start'),
      'Every admission span must close',
    );
});
test('MH09 revocation during provider execution rejects late output and leaves saved documents unchanged', async (t) => {
  let entered, release;
  const started = new Promise((r) => (entered = r)),
    pending = new Promise((r) => (release = r));
  const h = await setup(t, {
      preparationProvider: async (...args) => {
        entered();
        await pending;
        return fixturePreparation(...args);
      },
    }),
    a = await h.account('mcp-late@example.test'),
    args = await candidate(h, a),
    g = await h.grant(a);
  const result = h.tool(g.access_token, 'prepare_application', args);
  await started;
  const list = await h.call('/api/connections', { cookie: a.cookie });
  assert.equal(
    (
      await h.call('/api/connections/' + list.data.connections[0].id + '/revoke', {
        cookie: a.cookie,
        body: {},
      })
    ).status,
    200,
  );
  release();
  const output = await result;
  assert.ok(output.error);
  assert.equal((await h.call('/api/state', { cookie: a.cookie })).data.applications.length, 0);
  const events = (await h.call('/api/audit', { cookie: a.cookie })).data.events;
  assert.ok(!events.some((e) => e.action === 'preparation:request' && e.status === 'accepted'));
  assert.ok(
    events.some(
      (e) =>
        e.action === 'preparation:request' && ['cancelled', 'failed', 'stale'].includes(e.status),
    ),
  );
});
test('MH10 explicit clear invalidates even empty history cursors repeatedly', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-empty-clear@example.test'),
    g = await h.grant(a);
  let previous = await h.tool(g.access_token, 'get_updates', {});
  for (let i = 0; i < 2; i++) {
    assert.equal(
      (await h.call('/api/data', { cookie: a.cookie, method: 'DELETE', body: { confirm: true } }))
        .status,
      200,
    );
    const next = await h.tool(g.access_token, 'get_updates', { cursor: previous.nextCursor });
    assert.equal(next.reset, true);
    assert.notEqual(next.nextCursor, previous.nextCursor);
    previous = next;
  }
});
test('MH11 expired bearer supplies resource challenge and strict tool schemas reject injected fields', async (t) => {
  let now = Date.now();
  const h = await setup(t, { accountNow: () => now }),
    a = await h.account('mcp-expiry@example.test'),
    g = await h.grant(a);
  assert.ok((await h.tool(g.access_token, 'get_profile', { untrustedCommand: 'send mail' })).error);
  const subscription = await h.rpc(g.access_token, 'subscriptions/listen');
  assert.ok(subscription.status >= 400 || subscription.data.error);
  now += 601000;
  const expired = await h.rpc(g.access_token, 'tools/list');
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate'), /invalid_token/);
  assert.match(expired.headers.get('www-authenticate'), /resource_metadata/);
});
test('MH12 downscoping during preparation discards output without accepting or saving a draft', async (t) => {
  let entered, release;
  const started = new Promise((r) => (entered = r)),
    pending = new Promise((r) => (release = r));
  const h = await setup(t, {
      preparationProvider: async (...args) => {
        entered();
        await pending;
        return fixturePreparation(...args);
      },
    }),
    a = await h.account('mcp-downscope@example.test'),
    args = await candidate(h, a),
    g = await h.grant(a);
  const result = h.tool(g.access_token, 'prepare_application', args);
  await started;
  const rotated = await h.call('/oauth/token', {
    form: true,
    origin: null,
    body: {
      grant_type: 'refresh_token',
      client_id: g.params.client_id,
      resource: g.params.resource,
      refresh_token: g.refresh_token,
      scope: 'mcp:read',
    },
  });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
  release();
  assert.ok((await result).error);
  const events = (await h.call('/api/audit', { cookie: a.cookie })).data.events;
  assert.ok(!events.some((e) => e.action === 'preparation:request' && e.status === 'accepted'));
  assert.equal((await h.call('/api/state', { cookie: a.cookie })).data.applications.length, 0);
});
test('MH13 oversized MCP bodies are refused before tool execution', async (t) => {
  const h = await setup(t),
    a = await h.account('mcp-body-bound@example.test'),
    g = await h.grant(a);
  const before = (await h.call('/api/state', { cookie: a.cookie })).data;
  const denied = await h.rpc(g.access_token, 'tools/call', {
    name: 'save_application',
    arguments: { cvText: 'x'.repeat(140000) },
  });
  assert.equal(denied.status, 413);
  assert.deepEqual((await h.call('/api/state', { cookie: a.cookie })).data, before);
});
