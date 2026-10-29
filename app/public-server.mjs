import { delegatedContext } from './mcp-context.mjs';
import { openPostgresCatalog } from './postgres-catalog.mjs';
import { openPrivateStorage } from './private-storage.mjs';
import { seedControlledCatalog } from './controlled-local.mjs';
import { openCatalogDatabase } from './catalog-database.mjs';
import { pageOffset } from './catalog-query.mjs';
import { createOrganizationGrowth } from './organization-growth.mjs';
import { sourceRevision } from './source-revision.mjs';
import { createPrivacyContact } from './privacy-contact.mjs';
import { createVacancyCatalog } from './vacancy-catalog.mjs';
import { createOrganizationCatalog } from './organizations.mjs';
import { createOrganizationRefresh } from './organization-refresh.mjs';
import { ORGANIZATION_SEEDS } from './organization-seeds.mjs';
import {
  createOrganizationCandidates,
  createOrganizationCandidateWorker,
} from './organization-candidates.mjs';
import { verifyOrganizationCandidate, organizationSearch } from './organization-verification.mjs';
import { policyMetadata } from './policies.mjs';
import { policyPage } from './policy-pages.mjs';
// Account gateway: authentication precedes delegation into separate private stores.
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from './server.mjs';
import { createCareerImportManager } from './career-import.mjs';
import { createMcpAccess } from './mcp-access.mjs';
import { handleMcp } from './mcp-server.mjs';
import { createAccountStore } from './accounts.mjs';
import { createResendAdapter, verifyResendWebhook } from './resend.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const digest = (s) => createHash('sha256').update(s).digest('hex');
function replay(req, body, local = false) {
  const copy = Readable.from(body.length ? [body] : []);
  copy.method = req.method;
  copy.url = req.url;
  copy.headers = {
    ...req.headers,
    ...(local ? { host: 'localhost', origin: 'http://localhost' } : {}),
  };
  copy.socket = req.socket;
  return copy;
}
async function readBody(req, limit = 1048576) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(Error('Request too large.'), { status: 413 });
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export async function createPublicServer({
  storeDir,
  env = process.env,
  sendAccountMail,
  mailProvider,
  organizationVerifier,
  organizationInspector,
  capacityObservation,
  accountNow,
  preparationProvider,
} = {}) {
  const revision = await sourceRevision(fileURLToPath(new URL('../', import.meta.url)));
  if (!storeDir) throw Error('A dedicated account store directory is required.');
  const origin = new URL(env.PUBLIC_ORIGIN ?? '');
  const localTest =
    env.PUBLIC_ALLOW_HTTP_LOOPBACK === '1' &&
    origin.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !localTest) throw Error('Public origin must use HTTPS.');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw Error('Use an origin without path or credentials.');
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  const controlled = env.CONTROLLED_LOCAL_MODE === '1',
    isPg = env.CATALOG_BACKEND === 'postgres';
  if (env.CATALOG_BACKEND && !['postgres', 'sqlite'].includes(env.CATALOG_BACKEND))
    throw Error('Unsupported catalog backend.');
  if (
    controlled &&
    (!localTest ||
      ['RESEND_API_KEY', 'RESEND_RECEIVE_API_KEY', 'NEBIUS_API_KEY', 'TAVILY_API_KEY'].some(
        (key) => env[key],
      ) ||
      env.ALLOW_LIVE === '1')
  )
    throw Error('Controlled local mode requires loopback, no live keys and no live access.');
  if (
    isPg &&
    (env.ORGANIZATION_REFRESH_ENABLED === '1' || env.ORGANIZATION_DISCOVERY_ENABLED === '1')
  )
    throw Error('PostgreSQL collection requires the separate worker; web timers are disabled.');
  // Public account isolation and atomic decision history are independent of the public catalog backend.
  const privateStorage = await openPrivateStorage({ directory: storeDir });
  let catalogDatabase;
  try {
    catalogDatabase = isPg
      ? await openPostgresCatalog({
          connectionString: env.CATALOG_DATABASE_URL,
          namespace: env.CATALOG_NAMESPACE ?? 'rolemorrow',
          role: controlled ? 'operator' : 'web',
          ...(controlled ? { capacityObservation } : {}),
        })
      : await openCatalogDatabase({
          file: join(storeDir, 'catalog.sqlite'),
          organizationsFile: join(storeDir, 'organizations.json'),
          vacanciesFile: join(storeDir, 'vacancies.json'),
        });
  } catch (error) {
    await privateStorage?.close();
    throw error;
  }
  const organizationCatalog = isPg
    ? catalogDatabase.organizations
    : await createOrganizationCatalog({ database: catalogDatabase });
  if (controlled) await seedControlledCatalog(catalogDatabase);
  else if (!isPg) await organizationCatalog.importSeeds(ORGANIZATION_SEEDS);
  const organizationCandidates = await createOrganizationCandidates({
    file: join(storeDir, 'organization-candidates.json'),
    catalog: organizationCatalog,
  });
  const organizationDiscovery = createOrganizationCandidateWorker({
    queue: organizationCandidates,
    catalog: organizationCatalog,
    verify:
      organizationVerifier ??
      ((input, options) =>
        verifyOrganizationCandidate(input, { ...options, search: organizationSearch(env) })),
  });
  const discover = () =>
    env.ORGANIZATION_DISCOVERY_ENABLED === '1'
      ? organizationDiscovery.run().catch(() => console.error('Company discovery unavailable.'))
      : Promise.resolve();
  const organizationGrowth = await createOrganizationGrowth({
    file: join(storeDir, 'organization-growth.json'),
    catalog: organizationCatalog,
  });
  const vacancyCatalog = isPg
    ? catalogDatabase.vacancies
    : await createVacancyCatalog({ database: catalogDatabase });
  const organizationRefresh = createOrganizationRefresh({
    catalog: organizationCatalog,
    vacancies: vacancyCatalog,
    inspect: organizationInspector,
    batchSize: 10,
    batchIntervalMs: 3600000,
  });
  let organizationTimer = null,
    organizationStopped = false;
  if (env.ORGANIZATION_REFRESH_ENABLED === '1') {
    const tick = async () => {
      let failed = false;
      try {
        if (env.ORGANIZATION_DISCOVERY_ENABLED === '1') {
          try {
            const growth = await organizationGrowth.run();
            console.log('Company growth', JSON.stringify(growth));
          } catch {
            console.error('Automatic company growth unavailable.');
          }
        }
        await discover();
        if (organizationStopped) return;
        const result = await organizationRefresh.run();
        console.log('Organization refresh', JSON.stringify(result));
      } catch {
        failed = true;
        console.error('Organization refresh failed.');
      } finally {
        if (!organizationStopped) {
          const delay = failed
            ? 86400000
            : Math.max(
                60000,
                Math.min(
                  3600000,
                  vacancyCatalog.nextPassAtForCatalog(organizationCatalog) - Date.now(),
                ),
              );
          organizationTimer = setTimeout(() => void tick(), delay);
          organizationTimer.unref();
        }
      }
    };
    void tick();
  }
  const provider =
    mailProvider ??
    createResendAdapter({ sendKey: env.RESEND_API_KEY, receiveKey: env.RESEND_RECEIVE_API_KEY });
  const accountMail =
    sendAccountMail ??
    (async (message) => {
      if (!env.RESEND_API_KEY) throw Error('Account email is not configured.');
      await provider.send(
        {
          from: env.ACCOUNT_MAIL_FROM ?? env.MAIL_FROM,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        },
        { idempotencyKey: 'account-' + randomUUID() },
      );
    });
  const privacyContact = env.PRIVACY_FORWARD_TO
    ? await createPrivacyContact({
        file: join(storeDir, 'privacy-receipts.json'),
        provider,
        from: env.MAIL_FROM,
        to: env.PRIVACY_FORWARD_TO,
      })
    : null;
  const accounts = createAccountStore({
    file: join(storeDir, 'accounts.json'),
    sendAccountMail: accountMail,
    origin: origin.origin,
    requirePolicyAcceptance: env.PUBLIC_POLICY_ENFORCEMENT === '1',
    storage: privateStorage,
    ...(typeof accountNow === 'function' ? { now: accountNow } : {}),
  });
  const importManager = createCareerImportManager({
    ...(typeof accountNow === 'function' ? { now: accountNow } : {}),
  });
  const tenants = new Map(),
    rates = new Map(),
    inflight = new Set(),
    deletedUsers = new Set();
  let activeAuth = 0,
    closed = false;
  const pendingConsents = new Map(),
    mcpCounts = new Map();
  let mcpActive = 0;
  const mcpAccess =
    env.MCP_ENABLED === '1'
      ? createMcpAccess({
          storage: privateStorage,
          origin: origin.origin,
          ...(typeof accountNow === 'function' ? { now: accountNow } : {}),
          redirectUri: env.MCP_REDIRECT_URI ?? 'http://127.0.0.1/callback',
          onRevoke: (grantId) => {
            for (const [accountId, inner] of tenants) {
              inner.cancelDelegation?.(grantId);
              importManager.invalidate(accountId, 'grant:' + grantId);
            }
          },
        })
      : null;
  function limit(bucket, max, windowMs) {
    const now = Date.now(),
      old = rates.get(bucket);
    if (!old || now - old.start >= windowMs) {
      if (rates.size > 10000) {
        for (const [k, v] of rates) if (now - v.start > 86400000) rates.delete(k);
        if (rates.size > 10000) throw Object.assign(Error('Service busy.'), { status: 429 });
      }
      rates.set(bucket, { start: now, count: 1 });
      return;
    }
    if (old.count >= max)
      throw Object.assign(Error('Too many attempts. Try again later.'), { status: 429 });
    old.count++;
  }
  const cookie = (token = '', clear = false) =>
    `rm_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 86400}${localTest ? '' : '; Secure'}`;
  const token = (req) => {
    const matches = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('rm_session='));
    if (matches.length !== 1) return '';
    try {
      return decodeURIComponent(matches[0].slice(11));
    } catch {
      return '';
    }
  };
  const userPath = (user) => {
    if (!/^[a-f0-9-]{36}$/.test(user.id) || !/^[a-f0-9]{12}$/.test(user.mailboxTag))
      throw Error('Invalid account identity.');
    return join(storeDir, 'users', user.id, 'state.json');
  };
  function tenant(user) {
    if (deletedUsers.has(user.id))
      throw Object.assign(Error('Account no longer exists.'), { status: 401 });
    if (!tenants.has(user.id)) {
      if (tenants.size >= 1000)
        throw Object.assign(Error('Workspace capacity reached.'), { status: 503 });
      tenants.set(
        user.id,
        createServer({
          storeFile: userPath(user),
          storage: privateStorage,
          accountId: user.id,
          accountGeneration:
            privateStorage?.readSync('lifecycle')?.records?.[user.id]?.generation ?? 0,
          applicationPreparer: preparationProvider,
          importManager,
          preparationQuota: (requestId) =>
            accounts.consumePreparationQuota(user.id, requestId, {
              accountMax: Number(env.PUBLIC_PREPARATIONS_PER_DAY) || 3,
              globalMax: Number(env.PUBLIC_PREPARATIONS_GLOBAL_PER_DAY) || 20,
              windowMs: 86400000,
            }),
          catalogVacancies: vacancyCatalog,
          mailProvider: provider,
          organizationCatalog,
          onCompaniesSaved: async (companies) => {
            const unknown = [];
            for (const company of companies)
              if (!(await organizationCatalog.resolve(company))) unknown.push(company);
            if (!unknown.length) return;
            await accounts.consumeQuota(user.id, 'catalog-suggestion', 10, 86400000);
            await accounts.consumeQuota('global', 'catalog-suggestion', 50, 86400000);
            for (const company of unknown) {
              try {
                await organizationCandidates.enqueue(company);
              } catch {
                console.error('Company suggestion could not be queued.');
              }
            }
            void discover();
          },
          env: { ...env, PUBLIC_SERVICE: '1', MAIL_ALIAS_PREFIX: user.mailboxTag + '-' },
        }),
      );
    }
    return tenants.get(user.id);
  }
  function headers(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!localTest) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  const server = http.createServer(async (req, res) => {
    headers(res);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && req.url === '/health')
      return send(200, { ok: !closed, revision, ...(isPg ? { catalogBackend: 'postgres' } : {}) });
    if (req.headers.host !== origin.host) return send(403, { error: 'Unexpected host.' });
    // A single HTTPS edge can expose the signed ingress without opening private routes.
    if (controlled && req.method === 'POST' && req.url === '/hooks/resend')
      return send(404, { error: 'Connected mail ingress is disabled in controlled mode.' });
    if (req.method === 'POST' && req.url === '/hooks/resend')
      return server.ingress.emit('request', req, res);
    let path;
    try {
      path = new URL(req.url, origin).pathname;
    } catch {
      return send(400, { error: 'Invalid request.' });
    }
    try {
      if (
        mcpAccess &&
        (path.startsWith('/.well-known/oauth-') || path.startsWith('/oauth/') || path === '/mcp')
      ) {
        if (req.headers.origin !== undefined && req.headers.origin !== origin.origin)
          return send(403, { error: 'Unexpected origin.' });
        if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET')
          return send(200, mcpAccess.metadata());
        if (
          (path === '/.well-known/oauth-protected-resource' ||
            path === '/.well-known/oauth-protected-resource/mcp') &&
          req.method === 'GET'
        )
          return send(200, {
            resource: origin.origin + '/mcp',
            authorization_servers: [origin.origin],
            scopes_supported: ['mcp:read', 'mcp:write', 'mcp:prepare', 'mcp:import'],
            bearer_methods_supported: ['header'],
          });
        if (['/oauth/token', '/oauth/revoke'].includes(path) && req.method === 'POST') {
          limit('mcp-token:' + digest(req.socket.remoteAddress ?? 'unknown'), 30, 60000);
          limit('mcp-token-global', 120, 60000);
          if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded'))
            return send(400, { error: 'invalid_request' });
          const form = new URLSearchParams((await readBody(req, 16384)).toString());
          if (new Set(form.keys()).size !== [...form.keys()].length)
            return send(400, { error: 'invalid_request' });
          const body = Object.fromEntries(form);
          return send(
            200,
            path === '/oauth/token'
              ? await mcpAccess.token(body, req.headers)
              : await mcpAccess.revokeToken(body),
          );
        }
        if (path === '/oauth/authorize' && req.method === 'GET') {
          const session = await accounts.authenticate(token(req));
          if (!session) {
            res.writeHead(302, { location: '/account?returnTo=' + encodeURIComponent(req.url) });
            return res.end();
          }
          if (!session.user.verified) return send(403, { error: 'Verify your email first.' });
          if (policyMetadata(env, session.user).required)
            return send(403, { error: 'Review the current service policies first.' });
          const params = new URL(req.url, origin).searchParams,
            p = Object.fromEntries(params);
          const keys = [
            'response_type',
            'client_id',
            'redirect_uri',
            'resource',
            'scope',
            'state',
            'code_challenge',
            'code_challenge_method',
          ];
          const callback = new URL(env.MCP_REDIRECT_URI ?? 'http://127.0.0.1/callback');
          let redirect;
          try {
            redirect = new URL(p.redirect_uri);
          } catch {}
          const scopes = String(p.scope ?? '').split(' ');
          if (
            [...params.keys()].length !== keys.length ||
            keys.some((k) => !params.has(k)) ||
            p.response_type !== 'code' ||
            p.client_id !== 'rolemorrow-codex' ||
            p.resource !== origin.origin + '/mcp' ||
            p.code_challenge_method !== 'S256' ||
            !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? '') ||
            !p.state ||
            p.state.length > 512 ||
            !redirect ||
            redirect.protocol !== 'http:' ||
            redirect.hostname !== callback.hostname ||
            redirect.pathname !== callback.pathname ||
            redirect.username ||
            redirect.password ||
            redirect.search ||
            redirect.hash ||
            !scopes.length ||
            new Set(scopes).size !== scopes.length ||
            scopes.some(
              (x) => !['mcp:read', 'mcp:write', 'mcp:prepare', 'mcp:import'].includes(x),
            ) ||
            !scopes.includes('mcp:read') ||
            ((scopes.includes('mcp:prepare') || scopes.includes('mcp:import')) &&
              !scopes.includes('mcp:write'))
          )
            return send(400, { error: 'Invalid authorization request.' });
          const now = Date.now();
          for (const [k, v] of pendingConsents) if (v.expiresAt <= now) pendingConsents.delete(k);
          if (
            pendingConsents.size >= 64 ||
            [...pendingConsents.values()].filter((v) => v.accountId === session.user.id).length >= 8
          )
            return send(429, { error: 'Too many pending requests.' });
          const requestId = randomUUID();
          pendingConsents.set(requestId, {
            params: p,
            accountId: session.user.id,
            expiresAt: now + 300000,
          });
          const escape = (x) =>
            x.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
          const rights = scopes
            .map((x) =>
              x === 'mcp:read'
                ? 'Read your profile, saved applications, replies and decision history.'
                : x === 'mcp:write'
                  ? 'Save vacancies and application drafts; mark notifications read.'
                  : x === 'mcp:import'
                    ? 'Import selected vacancies, correspondence and submitted documents after preview. No mailbox access or sending.'
                    : 'Prepare application drafts using your confirmed profile and the configured AI budget.',
            )
            .map((x) => '<li>' + x + '</li>')
            .join('');
          res.setHeader('content-type', 'text/html; charset=utf-8');
          return res.end(
            '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>Connect Codex</title></head><body><main><h1>Connect Codex to Rolemorrow</h1><p>Signed in as ' +
              escape(session.user.email) +
              '.</p><ul>' +
              rights +
              '</ul><p>This connection cannot send applications or email. You can revoke it at any time.</p><form id="consent-form"><input type="hidden" name="requestId" value="' +
              requestId +
              '"><button type="submit">Allow connection</button></form><a href="/connections">Cancel</a><p id="connection-status" role="status"></p><script type="module" src="/connections.js"></script></main></body></html>',
          );
        }
        if (path === '/mcp') {
          if (req.method !== 'POST')
            return send(405, {
              error: 'Subscriptions are not supported. Use active tools requests.',
            });
          const bearer = /^Bearer ([^ ]+)$/.exec(req.headers.authorization ?? '');
          if (!bearer) {
            res.setHeader(
              'WWW-Authenticate',
              'Bearer resource_metadata="' +
                origin.origin +
                '/.well-known/oauth-protected-resource/mcp"',
            );
            return send(401, { error: 'Bearer access required.' });
          }
          let context;
          try {
            context = await mcpAccess.authenticate(bearer[1]);
          } catch (error) {
            if (error.status !== 401) throw error;
            res.setHeader(
              'WWW-Authenticate',
              'Bearer error="invalid_token", resource_metadata="' +
                origin.origin +
                '/.well-known/oauth-protected-resource/mcp"',
            );
            return send(401, { error: 'invalid_token' });
          }
          if (policyMetadata(env, context.user).required)
            return send(403, { error: 'Review the current service policies in your account.' });
          limit('mcp:' + context.accountId, 60, 60000);
          if (mcpActive >= 32 || (mcpCounts.get(context.accountId) ?? 0) >= 4)
            return send(429, { error: 'Too many concurrent requests.' });
          mcpActive++;
          mcpCounts.set(context.accountId, (mcpCounts.get(context.accountId) ?? 0) + 1);
          context.assertActive = () => mcpAccess.assertActive(context);
          try {
            const inner = tenant(context.user);
            return await handleMcp(req, res, {
              access: mcpAccess,
              context,
              storage: privateStorage,
              call: (method, url, body) =>
                inner.businessCall(delegatedContext() ?? context, method, url, body),
              importAction: async (method, body) => {
                const scoped = delegatedContext() ?? context;
                return await inner.importAction(
                  {
                    accountId: context.accountId,
                    email: context.user.email,
                    principalId: 'grant:' + context.grantId,
                  },
                  method,
                  body,
                  { assertActive: scoped.assertActive },
                );
              },
              search: (filters) => vacancyCatalog.list({ ...filters, query: filters.q ?? '' }),
            });
          } finally {
            mcpActive--;
            mcpCounts.set(context.accountId, mcpCounts.get(context.accountId) - 1);
          }
        }
        return send(404, { error: 'Not found.' });
      }
      if (req.method === 'GET' && path === '/health')
        return send(200, {
          ok: !closed,
          revision,
          ...(isPg ? { catalogBackend: 'postgres' } : {}),
        });
      if (req.method === 'GET' && path === '/api/policies') return send(200, policyMetadata(env));
      if (req.method === 'GET' && ['/terms', '/privacy', '/cookies', '/providers'].includes(path)) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(policyPage(path.slice(1)));
        return;
      }
      if (
        req.method === 'GET' &&
        [
          '/welcome',
          '/account',
          '/account.js',
          '/style.css',
          '/entry.css',
          '/connections',
          '/connections.js',
          '/imports',
          '/imports.js',
        ].includes(path)
      ) {
        const name =
          path === '/imports'
            ? 'imports.html'
            : path === '/connections'
              ? 'connections.html'
              : path === '/welcome'
                ? 'landing.html'
                : path === '/account'
                  ? 'account.html'
                  : path.slice(1);
        res.setHeader(
          'content-type',
          name.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : name.endsWith('.js')
              ? 'text/javascript'
              : 'text/css',
        );
        res.end(await readFile(join(publicDir, name)));
        return;
      }
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (
        mutation &&
        (req.headers.origin !== origin.origin ||
          !(req.headers['content-type'] ?? '').startsWith('application/json'))
      )
        return send(403, { error: 'Same-origin JSON request required.' });
      const raw = mutation
        ? await readBody(
            req,
            path === '/api/imports/chunk'
              ? 96 * 1024
              : path.startsWith('/api/imports/')
                ? 64 * 1024
                : 1048576,
          )
        : Buffer.alloc(0);
      if (path.startsWith('/api/account/')) {
        if (path === '/api/account/me' && req.method === 'GET') {
          const session = await accounts.authenticate(token(req));
          return session
            ? send(200, { user: session.user, policies: policyMetadata(env, session.user) })
            : send(401, { error: 'Sign in required.' });
        }
        if (req.method !== 'POST') return send(404, { error: 'Not found.' });
        let input;
        try {
          input = JSON.parse(raw.toString());
        } catch {
          return send(400, { error: 'Invalid JSON.' });
        }
        if (!input || typeof input !== 'object' || Array.isArray(input))
          return send(400, { error: 'Invalid account request.' });
        const action = path.slice('/api/account/'.length),
          ip = digest(req.socket.remoteAddress ?? 'unknown');
        limit('auth-ip:' + ip, 30, 900000);
        limit('auth-global', 120, 900000);
        if (action === 'login') {
          // Durable scopes survive process restart. The caller cannot supply source identity.
          await accounts.consumeQuota('login-source:' + ip, 'login-source-hour', 50, 3600000);
          await accounts.consumeQuota(
            'login-identity:' +
              digest(
                String(input.email ?? '')
                  .trim()
                  .toLowerCase(),
              ),
            'login-identity-hour',
            10,
            3600000,
          );
        }
        if (action === 'verify') {
          // Opaque unknown and expired tokens use the same presented-token budget.
          await accounts.consumeQuota(
            'verify-token:' + digest(typeof input.token === 'string' ? input.token : ''),
            'verify-token-hour',
            5,
            3600000,
          );
        }
        if (['register', 'request-reset'].includes(action)) {
          await accounts.consumeQuota(
            'mail-minute:' +
              digest(
                String(input.email ?? '')
                  .trim()
                  .toLowerCase(),
              ),
            'account-mail-minute:' + action,
            1,
            60000,
          );
          await accounts.consumeQuota(
            'global',
            'account-mail',
            Number(env.ACCOUNT_MAIL_LIMIT_PER_HOUR) || 20,
            3600000,
          );
          await accounts.consumeQuota(
            'mail-hour:' +
              digest(
                String(input.email ?? '')
                  .trim()
                  .toLowerCase(),
              ),
            'account-mail',
            3,
            3600000,
          );
        }
        if (activeAuth >= 4) return send(503, { error: 'Sign-in service busy. Try again.' });
        activeAuth++;
        try {
          if (action === 'register') {
            if (env.PUBLIC_REGISTRATION_ENABLED !== '1')
              return send(503, { error: 'Registration is not open yet.' });
            await accounts.register(input);
            return send(202, { message: 'Check your email for verification instructions.' });
          }
          if (action === 'accept-policies') {
            const current = await accounts.authenticate(token(req));
            if (!current) return send(401, { error: 'Sign in required.' });
            if (
              req.headers['x-rolemorrow-account-id'] &&
              req.headers['x-rolemorrow-account-id'] !== current.user.id
            ) {
              res.setHeader('X-Rolemorrow-Account-Mismatch', '1');
              return send(409, {
                error: 'The signed-in account changed. Reload Your account before continuing.',
              });
            }
            const result = await accounts.acceptPolicies(token(req), input.acceptance ?? input);
            return send(200, { user: result.user, policies: policyMetadata(env, result.user) });
          }
          if (action === 'login') {
            const result = await accounts.login(input);
            res.setHeader('set-cookie', cookie(result.sessionToken));
            return send(200, { user: result.user, policies: policyMetadata(env, result.user) });
          }
          if (action === 'verify') {
            const result = await accounts.verify(input);
            return send(200, {
              user: result.user,
              message: 'Email verified. Sign in with your password.',
            });
          }
          if (action === 'request-reset') {
            await accounts.requestReset(input);
            return send(202, {
              message: 'If this account exists, reset instructions have been sent.',
            });
          }
          if (action === 'reset') {
            await accounts.reset(input);
            res.setHeader('set-cookie', cookie('', true));
            return send(200, { message: 'Password updated. Sign in again.' });
          }
          if (action === 'logout') {
            const existing = await accounts.authenticate(token(req));
            if (existing) importManager.invalidate(existing.user.id, 'web:' + digest(token(req)));
            await accounts.logout(token(req));
            res.setHeader('set-cookie', cookie('', true));
            return send(200, { ok: true });
          }
          return send(404, { error: 'Not found.' });
        } finally {
          activeAuth--;
        }
      }
      const session = await accounts.authenticate(token(req));
      if (!session) {
        if (req.method === 'GET' && path === '/') {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(await readFile(join(publicDir, 'landing.html')));
          return;
        }
        return send(401, { error: 'Sign in required.' });
      }
      if (!session.user.verified)
        return send(403, { error: 'Verify your email before using the workspace.' });
      const user = session.user;
      if (mcpAccess && path.startsWith('/api/connections')) {
        if (req.method === 'GET' && path === '/api/connections')
          return send(200, { connections: await mcpAccess.list(user.id) });
        if (req.method === 'POST' && path === '/api/connections/authorize') {
          if (policyMetadata(env, user).required)
            return send(403, { error: 'Review current service policies first.' });
          const body = JSON.parse(raw.toString()),
            pending = pendingConsents.get(body.requestId);
          if (pending && pending.accountId !== user.id)
            return send(404, { error: 'Authorization request not found.' });
          if (
            Object.keys(body).sort().join(',') !== 'consent,requestId' ||
            body.consent !== true ||
            !pending ||
            pending.accountId !== user.id ||
            pending.expiresAt <= Date.now()
          )
            return send(400, {
              error: 'Authorization request expired or is invalid. Restart the connection.',
            });
          pendingConsents.delete(body.requestId);
          return send(200, await mcpAccess.authorize(user, pending.params));
        }
        const match = /^\/api\/connections\/([a-f0-9-]{36})\/revoke$/.exec(path);
        if (req.method === 'POST' && match) {
          await mcpAccess.revoke(user.id, match[1]);
          return send(200, { revoked: true });
        }
        return send(404, { error: 'Not found.' });
      }
      if (path === '/api/vacancies' && req.method === 'GET') {
        // Two reads per second allow the approved one-per-second workload at window boundaries.
        limit('vacancies:' + user.id, 120, 60000);
        const params = new URL(req.url, origin).searchParams;
        return send(200, {
          collection: isPg
            ? await catalogDatabase.collection()
            : {
                batchSize: 10,
                batchIntervalHours: 1,
                companyIntervalHours: 24,
                ...vacancyCatalog.batchSchedule(),
              },
          ...(await vacancyCatalog.list({
            ...Object.fromEntries(
              [
                'role',
                'level',
                'workMode',
                'employmentType',
                'skills',
                'skillMatch',
                'exclude',
                'location',
                'country',
                'industry',
                'salaryDisclosed',
                'salaryMin',
                'currency',
                'salaryInterval',
              ].map((key) => [key, params.get(key) ?? '']),
            ),
            organizationId: params.get('organizationId') ?? '',
            query: params.get('q') ?? '',
            status: params.get('status') ?? '',
            offset: params.get('offset'),
          })),
          scope:
            'Cached public sources; partial coverage. Check the official posting before applying.',
        });
      }
      if (path === '/api/organizations' && req.method === 'GET') {
        limit('catalog:' + user.id, 60, 60000);
        const params = new URL(req.url, origin).searchParams,
          query = params.get('q') ?? '',
          offset = pageOffset(params.get('offset'));
        const filters = {
          query,
          industry: params.get('industry') ?? '',
          employeeSize: params.get('employeeSize') ?? '',
        };
        const organizations = await organizationCatalog.list({ ...filters, offset }),
          matching = await organizationCatalog.matchingCount(filters);
        return send(200, {
          organizations,
          total: await organizationCatalog.count(),
          matching,
          facets: await organizationCatalog.facets(),
          nextOffset:
            offset + organizations.length < matching ? offset + organizations.length : null,
          growth: organizationGrowth.status(),
          discoveryEnabled: env.ORGANIZATION_DISCOVERY_ENABLED === '1',
          refreshEnabled: env.ORGANIZATION_REFRESH_ENABLED === '1',
          scope: 'Public employer sources; not an exhaustive directory.',
        });
      }
      const workspaceAccount = req.headers['x-rolemorrow-account-id'];
      if (workspaceAccount !== undefined && workspaceAccount !== user.id) {
        res.setHeader('X-Rolemorrow-Account-Mismatch', '1');
        return send(409, {
          error: 'The signed-in account changed. Reload this workspace before continuing.',
        });
      }
      res.setHeader('X-Rolemorrow-Account-ID', user.id);
      if (path === '/api/account' && req.method === 'DELETE') {
        let input;
        try {
          input = JSON.parse(raw.toString());
        } catch {
          return send(400, { error: 'Invalid JSON.' });
        }
        if (input.confirm !== true)
          return send(400, { error: 'Explicit account deletion confirmation required.' });
        await accounts.deleteAccount(token(req), { password: input.password });
        deletedUsers.add(user.id);
        importManager.invalidate(user.id);
        const inner = tenants.get(user.id);
        if (inner) {
          if (!privateStorage) inner.eraseWorkspace?.();
          inner.emit('close');
          tenants.delete(user.id);
        }
        if (privateStorage) privateStorage.purgeDeletedWorkspaceSync(user.id);
        else await rm(dirname(userPath(user)), { recursive: true, force: true });
        res.setHeader('set-cookie', cookie('', true));
        return send(200, { ok: true });
      }
      if (policyMetadata(env, user).required) {
        if (req.method === 'GET' && path === '/') {
          res.writeHead(302, { location: '/account?setup=1' });
          return res.end();
        }
        if (mutation && path.startsWith('/api/'))
          return send(403, {
            code: 'policy_required',
            error:
              'Review the current service terms and privacy notice in Your account before continuing.',
          });
      }
      if (path.startsWith('/api/imports/')) {
        if (req.method !== 'POST') return send(404, { error: 'Not found.' });
        const method = path.slice('/api/imports/'.length);
        if (!['begin', 'chunk', 'preview', 'commit', 'progress', 'cancel'].includes(method))
          return send(404, { error: 'Not found.' });
        let body;
        try {
          body = JSON.parse(raw.toString());
        } catch {
          return send(400, { error: 'Invalid JSON.' });
        }
        const rawSession = token(req),
          owner = accounts.assertSession(rawSession, user.id);
        return send(
          200,
          await tenant(user).importAction(
            { accountId: user.id, email: user.email, principalId: owner.principalId },
            method,
            body,
            { assertActive: () => accounts.assertSession(rawSession, user.id) },
          ),
        );
      }
      if (path === '/api/organization-suggestions' && req.method === 'POST') {
        let input;
        try {
          input = JSON.parse(raw.toString());
        } catch {
          return send(400, { error: 'Invalid JSON.' });
        }
        if (typeof input?.query !== 'string')
          return send(400, { error: 'Enter a company name or homepage.' });
        await accounts.consumeQuota(user.id, 'catalog-suggestion', 10, 86400000);
        await accounts.consumeQuota('global', 'catalog-suggestion', 50, 86400000);
        let outcome;
        try {
          outcome = await organizationCandidates.enqueue({ query: input.query });
        } catch (error) {
          return send(error.status ?? 400, { error: error.message });
        }
        void discover();
        return send(202, {
          status: outcome.status,
          message:
            outcome.status === 'known'
              ? 'This company is already in the catalog.'
              : 'Public company details queued for verification. Your identity and workspace are not published.',
        });
      }
      if (path === '/api/scans' && req.method === 'POST') {
        let body;
        try {
          body = JSON.parse(raw.toString());
        } catch {
          return send(400, { error: 'Invalid JSON.' });
        }
        if (body?.mode === 'live') {
          await accounts.consumeQuota(
            user.id,
            'scan',
            Number(env.PUBLIC_SCANS_PER_DAY) || 3,
            86400000,
          );
          await accounts.consumeQuota(
            'global',
            'scan',
            Number(env.PUBLIC_SCANS_GLOBAL_PER_DAY) || 20,
            86400000,
          );
        }
      }
      if (path.startsWith('/api/mail/dispatches') && req.method === 'POST') {
        await accounts.consumeQuota(
          user.id,
          'mail',
          Number(env.PUBLIC_MAIL_PER_DAY) || 10,
          86400000,
        );
        await accounts.consumeQuota(
          'global',
          'mail',
          Number(env.PUBLIC_MAIL_GLOBAL_PER_DAY) || 50,
          86400000,
        );
      }
      if (!(await accounts.authenticate(token(req))))
        return send(401, { error: 'Sign in required.' });
      tenant(user).emit('request', replay(req, raw, true), res);
    } catch (error) {
      send(Number.isInteger(error.status) ? error.status : 500, {
        error:
          error.status && error.status < 500
            ? error.message
            : 'Unable to complete this action. Try again.',
      });
    }
  });
  // Public webhook routes into one verified account. No application routes here.
  server.ingress = http.createServer(async (req, res) => {
    headers(res);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST' || req.url !== '/hooks/resend')
      return send(404, { error: 'Not found.' });
    if (!env.RESEND_WEBHOOK_SECRET) return send(503, { error: 'Webhook is not configured.' });
    let raw, signed;
    try {
      raw = await readBody(req, 262144);
      signed = verifyResendWebhook(raw, req.headers, env.RESEND_WEBHOOK_SECRET);
    } catch {
      return send(401, { error: 'Invalid webhook.' });
    }
    if (inflight.size >= 4 || inflight.has(signed.id)) return send(503, { error: 'Retry later.' });
    inflight.add(signed.id);
    let forwarded = false;
    try {
      if (privacyContact?.matches(signed.event)) {
        const outcome = await privacyContact.handle(signed.event);
        return send(200, { received: true, privacyForwarded: outcome.forwarded });
      }
      const users = (await accounts.listUsers()).filter((u) => u.verified),
        event = signed.event;
      let target;
      if (event.type === 'email.received') {
        const tags = new Set(
          (Array.isArray(event.data.to) ? event.data.to : [])
            .map((to) =>
              typeof to === 'string'
                ? to.toLowerCase().match(/^op-([a-f0-9]{12})-[a-f0-9-]+@/i)?.[1]
                : null,
            )
            .filter(Boolean),
        );
        const matches = users.filter((u) => tags.has(u.mailboxTag));
        if (matches.length !== 1) return send(200, { received: true, linked: false });
        target = matches[0];
      } else if (['email.delivered', 'email.bounced', 'email.failed'].includes(event.type)) {
        for (const user of users) {
          try {
            const data = JSON.parse(await readFile(userPath(user), 'utf8'));
            if (data.mailDispatches?.some((d) => d.providerId === event.data.email_id)) {
              target = user;
              break;
            }
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
        }
        if (!target)
          return send(503, { error: 'Delivery association not available yet. Retry later.' });
      } else return send(200, { received: true, ignored: true });
      forwarded = true;
      res.once('finish', () => inflight.delete(signed.id));
      res.once('close', () => inflight.delete(signed.id));
      tenant(target).ingress.emit('request', replay(req, raw), res);
    } catch {
      return send(503, { error: 'Webhook processing unavailable. Retry later.' });
    } finally {
      if (!forwarded) inflight.delete(signed.id);
    }
  });
  server.accounts = accounts;
  server.on('close', () => {
    closed = true;
    importManager.close();
    organizationStopped = true;
    clearTimeout(organizationTimer);
    organizationRefresh.stop();
    organizationDiscovery.stop();
    organizationGrowth.stop();
    void catalogDatabase.close().catch(() => console.error('Catalog database close failed.'));
    for (const inner of tenants.values()) inner.emit('close');
    if (server.ingress.listening) server.ingress.close();
    void privateStorage?.close();
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 60;
  server.ingress.requestTimeout = 30000;
  server.ingress.headersTimeout = 10000;
  server.ingress.maxHeadersCount = 40;
  return server;
}
