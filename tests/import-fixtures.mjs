import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createPublicServer } from '../app/public-server.mjs';
const password = 'Synthetic-MCP-Password-2026!',
  verifier = 'm'.repeat(43),
  challenge = createHash('sha256').update(verifier).digest('base64url');
export async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-http-')),
    sock = net.createServer();
  await new Promise((r) => sock.listen(0, '127.0.0.1', r));
  const port = sock.address().port;
  await new Promise((r) => sock.close(r));
  const base = 'http://127.0.0.1:' + port,
    outbox = [];
  const mailCalls = { send: 0, receive: 0 };
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
        mailCalls.send++;
        throw Error('No live mail');
      },
      receive: async () => {
        mailCalls.receive++;
        throw Error('No live receive');
      },
    },
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(
      mailCalls,
      { send: 0, receive: 0 },
      'Import cannot attempt external mail calls',
    );
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
  return { base, dir, server, call, account, oauthParams, grant, rpc, tool, mailCalls };
}
export const digest = (data) => createHash('sha256').update(data).digest('hex');
export const syntheticPdf = Buffer.from(
  '%PDF-1.4\nSynthetic submitted CV; exact original bytes.\n%%EOF\n',
);
export const vacancy = (extra = {}) => ({
  kind: 'vacancy',
  namespace: 'ja-permanent',
  sourceId: 'ja-job-1',
  company: 'Example Products',
  title: 'Senior Product Manager',
  url: 'https://careers.example.com/jobs/123?utm_source=ja',
  description: 'A specific product vacancy, not an inferred job description.',
  ...extra,
});
export const message = (a, extra = {}) => ({
  kind: 'message',
  namespace: 'ja-permanent',
  sourceKind: 'gmail',
  providerMessageId: 'gmail-source-1',
  providerThreadId: 'thread-source-1',
  from: a.user.email,
  to: ['recruiting@example.com'],
  subject: 'Application for Senior Product Manager',
  text: 'Please consider my application; the submitted CV is attached.',
  sentAt: '2026-10-20T10:15:00.000Z',
  vacancySourceId: 'ja-job-1',
  files: [
    {
      name: 'submitted-original.pdf',
      type: 'application/pdf',
      base64: syntheticPdf.toString('base64'),
    },
  ],
  attempt: { kind: 'application', channel: 'gmail', evidenceMessageId: 'gmail-source-1' },
  ...extra,
});
export function bundle(a, payloads, { batchId = randomUUID(), pretty = false } = {}) {
  const records = payloads.map((payload) => {
    const bytes = Buffer.from(JSON.stringify(payload, null, pretty ? 2 : undefined));
    return {
      itemId: randomUUID(),
      kind: payload.kind,
      bytes: bytes.length,
      sha256: digest(bytes),
      chunks: Math.ceil(bytes.length / 49152),
      ...(payload.kind === 'message' ? { subject: payload.subject } : {}),
      payload: bytes,
    };
  });
  return {
    batchId,
    sourceAccount: a.user.email,
    items: records.map(({ payload: _payload, ...m }) => m),
    records,
  };
}
export async function stage(h, a, b) {
  let r = await h.call('/api/imports/begin', {
    cookie: a.cookie,
    body: { batchId: b.batchId, sourceAccount: b.sourceAccount, items: b.items },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const item of b.records)
    for (let index = 0; index < item.chunks; index++) {
      r = await h.call('/api/imports/chunk', {
        cookie: a.cookie,
        body: {
          batchId: b.batchId,
          itemId: item.itemId,
          index,
          data: item.payload.subarray(index * 49152, (index + 1) * 49152).toString('base64'),
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
  return h.call('/api/imports/preview', { cookie: a.cookie, body: { batchId: b.batchId } });
}
export const commit = (h, a, b, p, ids = b.items.map((i) => i.itemId)) =>
  h.call('/api/imports/commit', {
    cookie: a.cookie,
    body: { batchId: b.batchId, previewHash: p.data.previewHash, itemIds: ids },
  });
export const state = async (h, a) => (await h.call('/api/state', { cookie: a.cookie })).data;
