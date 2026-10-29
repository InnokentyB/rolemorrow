import OAuth2Server from '@node-oauth/oauth2-server';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const fail = (status, message, code = 'invalid_request') => {
  throw Object.assign(new Error(message), { status, code });
};
const scopesOf = (s) => {
  const a = Array.isArray(s) ? s : typeof s === 'string' ? s.split(' ') : [];
  if (
    !a.length ||
    new Set(a).size !== a.length ||
    a.some((x) => !['mcp:read', 'mcp:write', 'mcp:prepare', 'mcp:import'].includes(x)) ||
    ((a.includes('mcp:prepare') || a.includes('mcp:import')) &&
      (!a.includes('mcp:read') || !a.includes('mcp:write')))
  )
    fail(400, 'Invalid scope', 'invalid_scope');
  return a;
};
export function validateConnections(v) {
  const keys = (o, k) => {
    if (
      !o ||
      typeof o !== 'object' ||
      Array.isArray(o) ||
      Object.keys(o).some((x) => !k.includes(x)) ||
      k.some((x) => !Object.hasOwn(o, x))
    )
      throw Error('connections schema');
  };
  keys(v, ['version', 'commitRevision', 'grants', 'historyEpoch', 'historyAnchor', 'cursorKey']);
  if (
    !/^[a-f0-9]{64}$/.test(v.cursorKey) ||
    !uuid.test(v.historyEpoch) ||
    (v.historyAnchor !== null && v.historyAnchor !== '' && !/^[a-f0-9]{64}$/.test(v.historyAnchor))
  )
    throw Error('connections history epoch');
  if (
    v.version !== 1 ||
    !Number.isSafeInteger(v.commitRevision) ||
    v.commitRevision < 0 ||
    !Array.isArray(v.grants) ||
    v.grants.length > 64 ||
    Buffer.byteLength(JSON.stringify(v)) > 512 * 1024
  )
    throw Error('connections capacity/schema');
  const ids = new Set();
  for (const g of v.grants) {
    keys(g, [
      'id',
      'generation',
      'clientId',
      'resource',
      'scopes',
      'redirectUri',
      'createdAt',
      'expiresAt',
      'revokedAt',
      'codeHash',
      'codeExpiresAt',
      'codeChallenge',
      'codeUsed',
      'accessHash',
      'accessExpiresAt',
      'refreshHash',
      'usedRefreshHashes',
    ]);
    if (
      !uuid.test(g.id) ||
      ids.has(g.id) ||
      !Number.isSafeInteger(g.generation) ||
      g.generation < 0
    )
      throw Error('connections identity');
    ids.add(g.id);
    scopesOf(g.scopes);
    for (const k of ['createdAt', 'expiresAt', 'codeExpiresAt', 'accessExpiresAt'])
      if (!Number.isSafeInteger(g[k]) || g[k] < 0) throw Error('connections time');
    if (g.revokedAt !== null && (!Number.isSafeInteger(g.revokedAt) || g.revokedAt < 0))
      throw Error('connections revocation');
    for (const k of ['clientId', 'resource', 'redirectUri'])
      if (typeof g[k] !== 'string' || g[k].length > 2048) throw Error('connections binding');
    for (const k of ['codeHash', 'accessHash', 'refreshHash'])
      if (g[k] !== null && !/^[a-f0-9]{64}$/.test(g[k])) throw Error('connections hash');
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(g.codeChallenge) ||
      typeof g.codeUsed !== 'boolean' ||
      !Array.isArray(g.usedRefreshHashes) ||
      g.usedRefreshHashes.length > 512 ||
      g.usedRefreshHashes.some((x) => !/^[a-f0-9]{64}$/.test(x))
    )
      throw Error('connections token schema');
  }
  return v.commitRevision;
}
/**
 * @param {{storage?: Awaited<ReturnType<typeof import('./private-storage.mjs').openPrivateStorage>>, origin?: string, clientId?: string, redirectUri?: string, now?: () => number, onRevoke?: (grantId: string) => unknown}} options
 */
export function createMcpAccess({
  storage,
  origin,
  clientId = 'rolemorrow-codex',
  redirectUri = 'http://127.0.0.1/callback',
  now = Date.now,
  onRevoke,
} = {}) {
  if (!storage) fail(503, 'Protected storage required');
  const resource = new URL('/mcp', origin).href,
    base = new URL(redirectUri);
  let tail = Promise.resolve();
  const serial = (fn) => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };
  const clock = () => {
    const n = now();
    if (!Number.isSafeInteger(n) || n < 0) fail(503, 'Clock unavailable');
    return n;
  };
  const current = (id) => {
    if (!uuid.test(id)) fail(401, 'Invalid credentials', 'invalid_token');
    const user = storage.readSync('auth')?.users?.find((x) => x.id === id && x.verified),
      r = storage.readSync('lifecycle')?.records?.[id];
    if (!user || r?.active === false) fail(401, 'Inactive account', 'invalid_token');
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        verified: true,
        mailboxTag: user.mailboxTag,
        ...(user.policyAcceptance
          ? { policyAcceptance: structuredClone(user.policyAcceptance) }
          : {}),
      },
      generation: r?.generation ?? 0,
    };
  };
  const read = (id) =>
    storage.readSync('connections:' + id) ?? {
      version: 1,
      commitRevision: 0,
      grants: [],
      historyEpoch: randomUUID(),
      historyAnchor: null,
      cursorKey: randomBytes(32).toString('hex'),
    };
  const save = (id, v) => {
    const old = storage.readSync('connections:' + id),
      c = current(id);
    for (const grant of v.grants) {
      if (grant.revokedAt !== null || grant.expiresAt <= clock()) grant.usedRefreshHashes = [];
    }
    v.commitRevision = (old?.commitRevision ?? 0) + 1;
    validateConnections(v);
    storage.commitSync({
      transactionId: randomUUID(),
      accountId: id,
      generation: c.generation,
      expectedRevisions: { ['connections:' + id]: old?.commitRevision ?? null },
      targets: [{ storeId: 'connections:' + id, value: v, revision: v.commitRevision }],
    });
  };
  const raw = (id) => id + '.' + randomBytes(32).toString('base64url');
  const route = (token) => {
    if (typeof token !== 'string' || !/^([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/.test(token))
      fail(401, 'Invalid credentials', 'invalid_token');
    const id = token.slice(0, 36);
    current(id);
    return id;
  };
  const validRedirect = (s) => {
    try {
      const u = new URL(s);
      return (
        u.protocol === base.protocol &&
        u.hostname === base.hostname &&
        u.pathname === base.pathname &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (base.hostname === '127.0.0.1' || base.hostname === '[::1]') &&
        u.protocol === 'http:'
      );
    } catch {
      return false;
    }
  };
  const notify = (id) => {
    try {
      onRevoke?.(id);
    } catch {}
  };
  const active = (id, g) => {
    const c = current(id);
    if (
      !g ||
      g.revokedAt !== null ||
      g.expiresAt <= clock() ||
      g.generation !== c.generation ||
      g.clientId !== clientId ||
      g.resource !== resource
    )
      fail(401, 'Connection expired or revoked', 'invalid_token');
    return c;
  };
  /** @type {{id?: string, grantId?: string, refreshHash?: string} | null} */
  let operation;
  const model = {
    getAccessToken: async (rawToken) => {
      try {
        const context = await api.authenticate(rawToken);
        return {
          accessToken: rawToken,
          accessTokenExpiresAt: new Date(Date.now() + context.accessExpiresAt - clock()),
          scope: context.scopes,
          client: { id: clientId, grants: ['authorization_code', 'refresh_token'] },
          user: context.user,
        };
      } catch {
        return null;
      }
    },
    getClient: async (id, secret) =>
      id === clientId && !secret
        ? { id, grants: ['authorization_code', 'refresh_token'], redirectUris: [redirectUri] }
        : null,
    validateRedirectUri: async (s) => validRedirect(s),
    validateScope: async (_u, _c, s) => scopesOf(s),
    generateAuthorizationCode: async () => raw(operation.id),
    generateAccessToken: async () => raw(operation.id),
    generateRefreshToken: async () => raw(operation.id),
    saveAuthorizationCode: async (code, _client, user) => {
      const v = read(user.id),
        at = clock(),
        c = current(user.id);
      v.grants = v.grants.filter((g) => g.expiresAt > at);
      if (v.grants.filter((g) => g.revokedAt === null).length >= 8 || v.grants.length >= 64)
        fail(429, 'Connection capacity reached', 'capacity');
      const g = {
        id: randomUUID(),
        generation: c.generation,
        clientId,
        resource,
        scopes: scopesOf(code.scope),
        redirectUri: code.redirectUri,
        createdAt: at,
        expiresAt: at + 30 * 86400000,
        revokedAt: null,
        codeHash: hash(code.authorizationCode),
        codeExpiresAt: at + 300000,
        codeChallenge: code.codeChallenge,
        codeUsed: false,
        accessHash: null,
        accessExpiresAt: 0,
        refreshHash: null,
        usedRefreshHashes: [],
      };
      v.grants.push(g);
      save(user.id, v);
      operation.grantId = g.id;
      return { ...code, client: { id: clientId }, user };
    },
    getAuthorizationCode: async (token) => {
      let id;
      try {
        id = route(token);
      } catch {
        return null;
      }
      const v = read(id),
        g = v.grants.find((g) => g.codeHash === hash(token));
      if (!g || g.codeUsed || g.codeExpiresAt <= clock()) return null;
      const c = active(id, g);
      operation = { ...operation, id, grantId: g.id };
      return {
        authorizationCode: token,
        expiresAt: new Date(Date.now() + Math.max(1, g.codeExpiresAt - clock())),
        redirectUri: g.redirectUri,
        scope: g.scopes,
        codeChallenge: g.codeChallenge,
        codeChallengeMethod: 'S256',
        user: c.user,
        client: { id: clientId },
      };
    },
    revokeAuthorizationCode: async () => {
      const v = read(operation.id),
        g = v.grants.find((g) => g.id === operation.grantId);
      if (!g || g.codeUsed) return false;
      g.codeUsed = true;
      save(operation.id, v);
      return true;
    },
    getRefreshToken: async (token) => {
      let id;
      try {
        id = route(token);
      } catch {
        return null;
      }
      const v = read(id),
        digest = hash(token),
        replayed = v.grants.find((g) => g.usedRefreshHashes.includes(digest));
      if (replayed) {
        replayed.revokedAt = clock();
        save(id, v);
        notify(replayed.id);
        return null;
      }
      const g = v.grants.find((g) => g.refreshHash === digest);
      if (!g) return null;
      const c = active(id, g);
      operation = { ...operation, id, grantId: g.id, refreshHash: digest };
      return {
        refreshToken: token,
        refreshTokenExpiresAt: new Date(Date.now() + Math.max(1, g.expiresAt - clock())),
        scope: g.scopes,
        user: c.user,
        client: { id: clientId },
      };
    },
    revokeToken: async () => true,
    saveToken: async (token, _client, user) => {
      const v = read(user.id),
        g = v.grants.find((g) => g.id === operation.grantId);
      active(user.id, g);
      if (operation.refreshHash && g.refreshHash !== operation.refreshHash) {
        g.revokedAt = clock();
        save(user.id, v);
        notify(g.id);
        fail(401, 'Refresh token reused', 'invalid_grant');
      }
      if (g.refreshHash) {
        if (g.usedRefreshHashes.length >= 512) {
          g.revokedAt = clock();
          save(user.id, v);
          notify(g.id);
          fail(401, 'Refresh rotation capacity reached', 'invalid_grant');
        }
        g.usedRefreshHashes.push(g.refreshHash);
      }
      g.accessHash = hash(token.accessToken);
      g.accessExpiresAt = clock() + 600000;
      g.refreshHash = hash(token.refreshToken);
      g.scopes = scopesOf(token.scope);
      save(user.id, v);
      return {
        ...token,
        accessTokenExpiresAt: new Date(Date.now() + 600000),
        refreshTokenExpiresAt: new Date(Date.now() + g.expiresAt - clock()),
        client: { id: clientId },
        user,
      };
    },
  };
  const oauth = new OAuth2Server({
    model,
    accessTokenLifetime: 600,
    refreshTokenLifetime: 30 * 86400,
    authorizationCodeLifetime: 300,
    requirePKCE: true,
  });
  const normalize = (e) => {
    if (e.status && typeof e.code === 'string') return e;
    return Object.assign(new Error(e.message || 'OAuth request failed'), {
      status: e.status ?? e.statusCode ?? (Number.isInteger(e.code) ? e.code : 400),
      code: e.name ?? 'invalid_request',
    });
  };
  const api = {
    createCursor(id, epoch, sequence) {
      current(id);
      const v = read(id);
      if (!uuid.test(epoch) || !Number.isSafeInteger(sequence) || sequence < 0)
        fail(400, 'Invalid cursor');
      if (!storage.readSync('connections:' + id)) save(id, v);
      const payload = Buffer.from(JSON.stringify({ accountId: id, epoch, sequence })).toString(
        'base64url',
      );
      return (
        payload +
        '.' +
        createHmac('sha256', Buffer.from(v.cursorKey, 'hex')).update(payload).digest('base64url')
      );
    },
    readCursor(id, raw) {
      current(id);
      if (
        typeof raw !== 'string' ||
        raw.length > 512 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(raw)
      )
        fail(400, 'Invalid cursor');
      const [payload, signature] = raw.split('.'),
        v = read(id),
        expected = createHmac('sha256', Buffer.from(v.cursorKey, 'hex'))
          .update(payload)
          .digest('base64url');
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
        fail(400, 'Invalid cursor');
      let data;
      try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        fail(400, 'Invalid cursor');
      }
      if (
        !data ||
        Object.keys(data).sort().join(',') !== 'accountId,epoch,sequence' ||
        data.accountId !== id ||
        !uuid.test(data.epoch) ||
        !Number.isSafeInteger(data.sequence) ||
        data.sequence < 0
      )
        fail(400, 'Invalid cursor');
      return { epoch: data.epoch, sequence: data.sequence };
    },
    syncHistoryEpoch(id, anchor) {
      current(id);
      if (anchor !== '' && !/^[a-f0-9]{64}$/.test(anchor ?? ''))
        fail(400, 'Invalid history anchor');
      const v = read(id);
      if (v.historyAnchor !== anchor) {
        // An explicit workspace clear rotates the epoch atomically. The first
        // event appended to an empty history belongs to that same epoch.
        if (v.historyAnchor !== null && v.historyAnchor !== '') v.historyEpoch = randomUUID();
        v.historyAnchor = anchor;
        save(id, v);
      }
      return v.historyEpoch;
    },
    metadata() {
      return {
        issuer: new URL(origin).origin,
        authorization_response_iss_parameter_supported: true,
        authorization_endpoint: origin + '/oauth/authorize',
        token_endpoint: origin + '/oauth/token',
        revocation_endpoint: origin + '/oauth/revoke',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['mcp:read', 'mcp:write', 'mcp:prepare', 'mcp:import'],
        resource,
      };
    },
    authorize(user, p) {
      return serial(async () => {
        current(user?.id);
        if (
          !p ||
          p.client_id !== clientId ||
          p.resource !== resource ||
          !validRedirect(p.redirect_uri) ||
          p.code_challenge_method !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? '') ||
          typeof p.state !== 'string' ||
          p.state.length > 512
        )
          fail(400, 'Invalid authorization request');
        scopesOf(p.scope);
        operation = { id: user.id };
        const response = new OAuth2Server.Response();
        try {
          await oauth.authorize(
            new OAuth2Server.Request({ method: 'GET', query: p, headers: {}, body: {} }),
            response,
            {
              authenticateHandler: { handle: async () => current(user.id).user },
              requirePKCE: true,
            },
          );
          const redirect = new URL(response.headers.location);
          const registeredRedirect = new URL(p.redirect_uri);
          if (
            redirect.origin !== registeredRedirect.origin ||
            redirect.pathname !== registeredRedirect.pathname
          )
            fail(503, 'Authorization response redirect binding failed');
          redirect.searchParams.set('iss', new URL(origin).origin);
          return { redirectTo: redirect.href, grantId: operation.grantId };
        } catch (e) {
          throw normalize(e);
        } finally {
          operation = null;
        }
      });
    },
    token(body, headers = {}) {
      return serial(async () => {
        if (
          !body ||
          Buffer.byteLength(JSON.stringify(body)) > 16384 ||
          body.client_id !== clientId ||
          body.resource !== resource ||
          !['authorization_code', 'refresh_token'].includes(body.grant_type) ||
          body.client_secret ||
          headers.authorization
        )
          fail(400, 'Invalid token request');
        if (
          body.grant_type === 'authorization_code' &&
          (!validRedirect(body.redirect_uri) ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier ?? ''))
        )
          fail(400, 'Invalid proof key');
        operation = {};
        const response = new OAuth2Server.Response();
        try {
          await oauth.token(
            new OAuth2Server.Request({
              method: 'POST',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': String(Buffer.byteLength(new URLSearchParams(body).toString())),
              },
              body,
              query: {},
            }),
            response,
            {
              requireClientAuthentication: { authorization_code: false, refresh_token: false },
              requirePKCE: true,
            },
          );
          return response.body;
        } catch (e) {
          throw normalize(e);
        } finally {
          operation = null;
        }
      });
    },
    async authenticate(token, required = []) {
      const id = route(token),
        v = read(id),
        g = v.grants.find((g) => g.accessHash === hash(token)),
        c = active(id, g);
      if (g.accessExpiresAt <= clock()) fail(401, 'Access token expired', 'invalid_token');
      if (required.some((s) => !g.scopes.includes(s)))
        fail(403, 'Insufficient scope', 'insufficient_scope');
      return {
        accountId: id,
        generation: c.generation,
        grantId: g.id,
        clientId: g.clientId,
        scopes: [...g.scopes],
        accessExpiresAt: g.accessExpiresAt,
        user: c.user,
      };
    },
    assertActive(context, required = []) {
      const c = current(context?.accountId),
        g = read(context.accountId).grants.find((g) => g.id === context.grantId);
      active(context.accountId, g);
      if (
        context.generation !== c.generation ||
        context.clientId !== clientId ||
        context.accessExpiresAt <= clock() ||
        g.accessExpiresAt <= clock()
      )
        fail(401, 'Delegation expired', 'invalid_token');
      if (required.some((s) => !g.scopes.includes(s)))
        fail(403, 'Insufficient scope', 'insufficient_scope');
      return true;
    },
    list(id) {
      current(id);
      return read(id).grants.map((g) => ({
        id: g.id,
        clientId: g.clientId,
        scopes: [...g.scopes],
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        active: g.revokedAt === null && g.expiresAt > clock(),
      }));
    },
    revoke(id, grantId) {
      return serial(() => {
        current(id);
        const v = read(id),
          g = v.grants.find((g) => g.id === grantId);
        if (!g) fail(404, 'Connection not found', 'not_found');
        if (g.revokedAt === null) {
          g.revokedAt = clock();
          save(id, v);
          notify(g.id);
        }
        return { ok: true };
      });
    },
    revokeToken(body) {
      return serial(() => {
        if (body?.client_id !== clientId) fail(400, 'Invalid client');
        let id;
        try {
          id = route(body.token);
        } catch {
          return { ok: true };
        }
        const v = read(id),
          d = hash(body.token),
          g = v.grants.find(
            (g) => g.accessHash === d || g.refreshHash === d || g.usedRefreshHashes.includes(d),
          );
        if (g && g.revokedAt === null) {
          g.revokedAt = clock();
          save(id, v);
          notify(g.id);
        }
        return { ok: true };
      });
    },
  };
  return api;
}
