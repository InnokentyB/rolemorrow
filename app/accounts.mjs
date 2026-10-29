import { policyReceipt, currentAcceptance } from './policies.mjs';
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
const scrypt = promisify(scryptCallback),
  sessionTtl = 86400000,
  sessionIdleTtl = 60 * 60000,
  tokenTtl = 30 * 60000;
export class AccountError extends Error {
  constructor(status, message, code = 'account_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, message, code) => {
  throw new AccountError(status, message, code);
};
const canonicalEmail = (value) => {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value.trim())
  )
    fail(400, 'Enter a valid email address.');
  return value.trim().toLowerCase();
};
const password = (value) => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128)
    fail(400, 'Use a password containing 12 to 128 characters.');
  return value;
};
const displayName = (value) => {
  if (typeof value !== 'string' || value.trim().length > 100 || /[\r\n\0]/.test(value))
    fail(400, 'Use a name of at most 100 characters.');
  return value.trim();
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};
const opaqueToken = () => randomBytes(32).toString('base64url');
const tokenHash = (token) =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token) : null;
const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  verified: u.verified,
  mailboxTag: u.mailboxTag,
  ...(u.policyAcceptance ? { policyAcceptance: structuredClone(u.policyAcceptance) } : {}),
});
let activeCrypto = 0;
const cryptoWaiters = [];
const acquireCrypto = () => {
  if (activeCrypto < 4) {
    activeCrypto++;
    return Promise.resolve();
  }
  if (cryptoWaiters.length >= 128)
    return Promise.reject(new AccountError(503, 'Account service is busy. Try again.'));
  return new Promise((resolve) => cryptoWaiters.push(resolve));
};
const releaseCrypto = () => {
  const next = cryptoWaiters.shift();
  if (next) next();
  else activeCrypto--;
};
const derive = async (p, salt) => {
  await acquireCrypto();
  try {
    return (
      await scrypt(p, Buffer.from(salt, 'hex'), 64, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      })
    ).toString('hex');
  } finally {
    releaseCrypto();
  }
};
export function createAccountStore({
  file,
  sendAccountMail,
  origin,
  now = () => Date.now(),
  requirePolicyAcceptance = false,
  storage,
} = {}) {
  if (typeof file !== 'string' || !file)
    throw new AccountError(503, 'Account storage is not configured.');
  let publicOrigin;
  try {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname) ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    )
      throw Error();
    publicOrigin = url.origin;
  } catch {
    throw new AccountError(503, 'Account origin must be an HTTPS origin.');
  }
  let state;
  try {
    state = storage
      ? (storage.readSync('auth') ?? {
          version: 1,
          users: [],
          sessions: [],
          tokens: [],
          quotas: [],
        })
      : existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8'))
        : { version: 1, users: [], sessions: [], tokens: [], quotas: [] };
    if (existsSync(file)) {
      chmodSync(dirname(file), 0o700);
      chmodSync(file, 0o600);
    }
  } catch {
    throw new AccountError(503, 'Account storage requires recovery.');
  }
  if (
    state.version !== 1 ||
    !Array.isArray(state.users) ||
    !Array.isArray(state.sessions) ||
    !Array.isArray(state.tokens) ||
    (state.quotas !== undefined && !Array.isArray(state.quotas))
  )
    throw new AccountError(503, 'Account storage requires recovery.');
  let tail = Promise.resolve();
  const serial = (fn) => {
    const operation = tail.then(fn);
    tail = operation.catch(() => {});
    return operation;
  };
  const instant = () => {
    const value = typeof now === 'function' ? now() : now;
    const n = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(n)) throw new AccountError(503, 'Account clock is unavailable.');
    return n;
  };
  function commit(next) {
    if (storage) {
      const current = storage.readSync('auth');
      next.commitRevision = (current?.commitRevision ?? 0) + 1;
      const targets = [{ storeId: 'auth', value: next, revision: next.commitRevision }],
        expectedRevisions = { auth: current ? (current.commitRevision ?? 0) : null };
      const removed = (current?.users ?? []).filter(
        (old) => !next.users.some((user) => user.id === old.id),
      );
      if (removed.length) {
        const previous = storage.readSync('lifecycle'),
          ledger = structuredClone(previous ?? { version: 1, commitRevision: 0, records: {} });
        ledger.commitRevision++;
        for (const user of removed)
          ledger.records[user.id] = {
            generation: (ledger.records[user.id]?.generation ?? 0) + 1,
            active: false,
            deletedAt: Date.now(),
            transactionId: randomUUID(),
          };
        targets.push({ storeId: 'lifecycle', value: ledger, revision: ledger.commitRevision });
        expectedRevisions.lifecycle = previous?.commitRevision ?? null;
      }
      storage.commitSync({ transactionId: randomUUID(), targets, expectedRevisions });
      state = next;
      return;
    }
    const data = JSON.stringify(next);
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) fail(503, 'Account storage capacity reached.');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(file), 0o700);
    const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
      chmodSync(file, 0o600);
      state = next;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {}
      throw new AccountError(503, 'Account changes could not be saved.');
    }
  }
  const sessionActivity = (session) => session.lastActiveAt ?? session.createdAt;
  const sessionActive = (session, at) =>
    Number.isFinite(session.expiresAt) &&
    session.expiresAt > at &&
    Number.isFinite(sessionActivity(session)) &&
    sessionActivity(session) + sessionIdleTtl > at;
  const copy = () => {
    const next = structuredClone(state),
      at = instant();
    next.sessions = next.sessions.filter((s) => sessionActive(s, at));
    next.tokens = next.tokens.filter((t) => t.expiresAt > at);
    next.quotas = (next.quotas ?? []).filter((q) => q.expiresAt > at);
    return next;
  };
  function issueToken(next, userId, kind, registration) {
    if (next.tokens.length >= 2000)
      fail(503, 'Account verification capacity reached. Retry later.');
    const raw = opaqueToken();
    next.tokens.push({
      hash: hash(raw),
      userId,
      kind,
      expiresAt: instant() + tokenTtl,
      ...(registration ? { registration } : {}),
    });
    return raw;
  }
  function consume(next, raw, kind) {
    const digest = tokenHash(raw),
      item =
        digest &&
        next.tokens.find(
          (t) => equal(t.hash, digest) && t.kind === kind && t.expiresAt > instant(),
        );
    if (!item) fail(400, 'This link is invalid or expired. Request a new link.');
    const user = next.users.find((u) => u.id === item.userId);
    if (!user) fail(400, 'This link is invalid or expired. Request a new link.');
    if (kind === 'verify' && item.registration) Object.assign(user, item.registration);
    next.tokens = next.tokens.filter((t) => !(t.userId === user.id && t.kind === kind));
    return user;
  }
  const findSession = (source, raw) => {
    const digest = tokenHash(raw),
      at = instant();
    return digest && source.sessions.find((s) => equal(s.hash, digest) && sessionActive(s, at));
  };
  // Provider latency/failures must not reveal whether an address has an account.
  // A committed pending account can always request a fresh link by registering again.
  function mail(email, kind, raw) {
    if (typeof sendAccountMail !== 'function') return;
    const link = publicOrigin + '/account?' + kind + '=' + encodeURIComponent(raw);
    const subject =
      kind === 'verify' ? 'Verify your Rolemorrow email' : 'Reset your Rolemorrow password';
    const text =
      (kind === 'verify'
        ? 'Verify your email address to use Rolemorrow.'
        : 'Reset your password only if you requested this change.') +
      '\n\n' +
      link +
      '\n\nThis link expires in 30 minutes. If you did not request it, ignore this email.';
    try {
      Promise.resolve(sendAccountMail({ to: email, subject, text })).catch(() => {});
    } catch {}
  }
  return {
    async register(input = {}) {
      const acceptance =
        requirePolicyAcceptance || input.acceptance !== undefined
          ? policyReceipt(input.acceptance, instant())
          : undefined;
      const email = canonicalEmail(input.email),
        p = password(input.password),
        name = displayName(input.name ?? '');
      const salt = randomBytes(32).toString('hex'),
        derived = await derive(p, salt);
      const issued = await serial(() => {
        const next = copy();
        const deletedIdentity = hash(JSON.stringify(['deleted-identity', email]));
        if (next.quotas.some((q) => q.key === deletedIdentity)) return null;
        let user = next.users.find((u) => u.email === email);
        if (user?.verified) return null;
        if (!user) {
          if (next.users.length >= 1000) fail(503, 'Registration is temporarily at capacity.');
          let tag;
          do {
            tag = randomBytes(6).toString('hex');
          } while (next.users.some((u) => u.mailboxTag === tag));
          user = {
            id: randomUUID(),
            email,
            name,
            verified: false,
            mailboxTag: tag,
            passwordSalt: salt,
            passwordHash: derived,
            createdAt: instant(),
          };
          next.users.push(user);
        }
        const raw = issueToken(next, user.id, 'verify', {
          passwordSalt: salt,
          passwordHash: derived,
          name,
          ...(acceptance ? { policyAcceptance: acceptance } : {}),
        });
        commit(next);
        return raw;
      });
      if (issued) mail(email, 'verify', issued);
      return { ok: true };
    },
    async login(input = {}) {
      const invalid = () =>
        fail(
          401,
          'Email or password is incorrect, or email verification is required.',
          'invalid_credentials',
        );
      let email, p;
      try {
        email = canonicalEmail(input.email);
        p = password(input.password);
      } catch {
        invalid();
      }
      // Take a snapshot for expensive derivation, then recheck identity under the writer queue.
      const found = state.users.find((u) => u.email === email),
        salt = found?.passwordSalt ?? '00'.repeat(32),
        derived = await derive(p, salt);
      return serial(() => {
        const user = state.users.find((u) => u.email === email);
        if (
          !user ||
          !found ||
          user.passwordHash !== found.passwordHash ||
          !equal(derived, user.passwordHash) ||
          !user.verified
        )
          invalid();
        const next = copy();
        if (next.sessions.filter((s) => s.userId === user.id).length >= 10)
          fail(429, 'Session limit reached. Sign out another session before signing in.');
        const raw = opaqueToken();
        next.sessions.push({
          hash: hash(raw),
          userId: user.id,
          createdAt: instant(),
          lastActiveAt: instant(),
          expiresAt: instant() + sessionTtl,
        });
        commit(next);
        return { user: publicUser(user), sessionToken: raw };
      });
    },
    async verify({ token } = {}) {
      return serial(() => {
        const next = copy(),
          user = consume(next, token, 'verify');
        user.verified = true;
        if (user.policyAcceptance && !user.policyAcceptanceHistory)
          user.policyAcceptanceHistory = [structuredClone(user.policyAcceptance)];
        commit(next);
        return { user: publicUser(user) };
      });
    },
    async requestReset({ email: inputEmail } = {}) {
      const email = canonicalEmail(inputEmail);
      const raw = await serial(() => {
        const next = copy(),
          user = next.users.find((u) => u.email === email);
        if (!user?.verified) return null;
        const token = issueToken(next, user.id, 'reset');
        commit(next);
        return token;
      });
      if (raw) mail(email, 'reset', raw);
      return { ok: true };
    },
    async reset({ token, password: inputPassword } = {}) {
      const p = password(inputPassword),
        salt = randomBytes(32).toString('hex'),
        derived = await derive(p, salt);
      return serial(() => {
        const next = copy(),
          user = consume(next, token, 'reset');
        user.passwordHash = derived;
        user.passwordSalt = salt;
        user.verified = true;
        next.tokens = next.tokens.filter((t) => t.userId !== user.id);
        next.sessions = next.sessions.filter((s) => s.userId !== user.id);
        commit(next);
        return { user: publicUser(user) };
      });
    },
    async acceptPolicies(raw, input) {
      return serial(() => {
        const session = findSession(state, raw),
          user = session && state.users.find((u) => u.id === session.userId && u.verified);
        if (!user) fail(401, 'Sign in required.');
        const receipt = policyReceipt(input, instant()),
          next = copy();
        if (currentAcceptance(user.policyAcceptance)) return { user: publicUser(user) };
        const target = next.users.find((u) => u.id === user.id);
        const history = target.policyAcceptanceHistory ??
          (target.policyAcceptance ? [structuredClone(target.policyAcceptance)] : []);
        if (history.length >= 100)
          fail(503, 'Policy acceptance history requires operator review. No receipt was removed.');
        target.policyAcceptanceHistory = [...history, receipt];
        target.policyAcceptance = receipt;
        commit(next);
        return { user: publicUser(next.users.find((u) => u.id === user.id)) };
      });
    },
    assertSession(raw, expectedAccountId) {
      const source = storage ? storage.readSync('auth') : state;
      const session = findSession(source, raw),
        user = session && source.users.find((u) => u.id === session.userId && u.verified);
      if (!user || (expectedAccountId && user.id !== expectedAccountId))
        fail(401, 'Current verified session required.');
      return { user: publicUser(user), principalId: 'web:' + tokenHash(raw) };
    },
    async authenticate(raw) {
      return serial(() => {
        const session = findSession(state, raw),
          user = session && state.users.find((u) => u.id === session.userId && u.verified);
        if (!user) return null;
        if (session.lastActiveAt === undefined || instant() - session.lastActiveAt > 60000) {
          const next = copy(),
            currentSession = next.sessions.find((s) => s.hash === session.hash);
          if (!currentSession) return null;
          currentSession.lastActiveAt = instant();
          commit(next);
        }
        return { user: publicUser(user) };
      });
    },
    async logout(raw) {
      return serial(() => {
        const digest = tokenHash(raw);
        if (!digest) return { ok: true };
        const next = copy();
        next.sessions = next.sessions.filter((s) => !equal(s.hash, digest));
        commit(next);
        return { ok: true };
      });
    },
    async deleteAccount(raw, { password: inputPassword } = {}) {
      const p = password(inputPassword),
        session = findSession(state, raw),
        found = session && state.users.find((u) => u.id === session.userId);
      const derived = await derive(p, found?.passwordSalt ?? '00'.repeat(32));
      return serial(() => {
        const current = findSession(state, raw),
          user = current && state.users.find((u) => u.id === current.userId);
        if (
          !user ||
          !found ||
          user.id !== found.id ||
          user.passwordHash !== found.passwordHash ||
          !equal(derived, user.passwordHash)
        )
          fail(401, 'Current session and password are required.');
        const next = copy();
        const reservationKey = hash(JSON.stringify(['deleted-identity', user.email]));
        if (!next.quotas.some((q) => q.key === reservationKey)) {
          if (next.quotas.length >= 10000)
            fail(503, 'Account deletion requires storage capacity. Retry later.');
          next.quotas.push({ key: reservationKey, count: 1, expiresAt: Number.MAX_SAFE_INTEGER });
        }
        next.users = next.users.filter((u) => u.id !== user.id);
        next.sessions = next.sessions.filter((s) => s.userId !== user.id);
        next.tokens = next.tokens.filter((t) => t.userId !== user.id);
        commit(next);
        return { ok: true };
      });
    },
    async consumeQuota(owner, scope, max, windowMs) {
      if (
        typeof owner !== 'string' ||
        !owner ||
        owner.length > 200 ||
        typeof scope !== 'string' ||
        !scope ||
        scope.length > 100 ||
        !Number.isSafeInteger(max) ||
        max < 1 ||
        max > 1000000 ||
        !Number.isSafeInteger(windowMs) ||
        windowMs < 1 ||
        windowMs > 31 * 86400000
      )
        fail(400, 'Invalid usage limit.');
      return serial(() => {
        const next = copy(),
          key = hash(JSON.stringify([owner, scope]));
        let quota = next.quotas.find((q) => q.key === key);
        if (quota && quota.count >= max)
          fail(429, 'Usage limit reached. Retry after the current limit window.', 'quota_exceeded');
        if (!quota) {
          if (next.quotas.length >= 10000) fail(503, 'Usage accounting capacity reached.');
          quota = { key, count: 0, expiresAt: instant() + windowMs };
          next.quotas.push(quota);
        }
        quota.count++;
        commit(next);
        return { ok: true };
      });
    },
    async consumePreparationQuota(
      accountId,
      requestId,
      { accountMax = 3, globalMax = 20, windowMs = 86400000 } = {},
    ) {
      if (
        !/^[a-f0-9-]{36}$/i.test(accountId ?? '') ||
        !/^[a-f0-9-]{36}$/i.test(requestId ?? '') ||
        ![accountMax, globalMax, windowMs].every(Number.isSafeInteger) ||
        accountMax < 1 ||
        globalMax < 1 ||
        accountMax > 1000000 ||
        globalMax > 1000000 ||
        windowMs < 1 ||
        windowMs > 31 * 86400000
      )
        fail(400, 'Invalid preparation budget.');
      return serial(() => {
        const next = copy();
        if (!next.users.some((u) => u.id === accountId && u.verified))
          fail(401, 'Sign in required.');
        const marker = hash(JSON.stringify(['preparation-intent', accountId, requestId]));
        if (next.quotas.some((q) => q.key === marker)) return { ok: true, replayed: true };
        const keys = [
            hash(JSON.stringify(['preparation-account', accountId])),
            hash(JSON.stringify(['preparation-global'])),
          ],
          limits = [accountMax, globalMax];
        for (let i = 0; i < keys.length; i++) {
          const q = next.quotas.find((q) => q.key === keys[i]);
          if (q && q.count >= limits[i])
            fail(429, 'Preparation budget exhausted.', 'quota_exceeded');
        }
        const missing = keys.filter((key) => !next.quotas.some((q) => q.key === key)).length;
        if (next.quotas.length + missing + 1 > 10000)
          fail(503, 'Usage accounting capacity reached.');
        for (const key of keys) {
          let q = next.quotas.find((q) => q.key === key);
          if (!q) {
            q = { key, count: 0, expiresAt: instant() + windowMs };
            next.quotas.push(q);
          }
          q.count++;
        }
        next.quotas.push({ key: marker, count: 1, expiresAt: instant() + windowMs });
        commit(next);
        return { ok: true, replayed: false };
      });
    },
    async listUsers() {
      return serial(() => state.users.map(publicUser));
    },
  };
}
