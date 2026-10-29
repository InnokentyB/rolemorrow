import { validateCareerImportState } from './career-import.mjs';
import { validateConnections } from './mcp-access.mjs';
import { createAudit, validateAudit } from './agent-audit.mjs';
import { spawnSync } from 'node:child_process';
import { validateProfile } from './domain.mjs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve, parse, sep } from 'node:path';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => structuredClone(value);
const fail = (message) => {
  throw new Error('Private storage: ' + message);
};
const nofollow = fs.constants.O_NOFOLLOW ?? 0;
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function directorySync(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | nofollow);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function checkPath(path, { directory = false, missing = false } = {}) {
  try {
    const info = fs.lstatSync(path);
    if (
      info.isSymbolicLink() ||
      !(directory ? info.isDirectory() : info.isFile()) ||
      info.uid !== process.getuid()
    )
      fail('unsafe protected path');
    if (!directory && info.nlink !== 1) fail('linked protected file refused');
    if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail('insecure protected permissions');
    return info;
  } catch (error) {
    if (missing && error.code === 'ENOENT') return null;
    throw error;
  }
}
function safeDirectory(path) {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    const next = join(current, part);
    try {
      if (!fs.lstatSync(next).isDirectory() || fs.lstatSync(next).isSymbolicLink())
        fail('unsafe directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(next, { mode: 0o700 });
      directorySync(current);
    }
    current = next;
  }
  checkPath(absolute, { directory: true });
  return absolute;
}
function bytesAt(path) {
  const info = checkPath(path, { missing: true });
  if (!info) return null;
  if (info.size > 32 * 1024 * 1024) fail('aggregate exceeds bound');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | nofollow);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function writeExclusive(path, bytes) {
  const fd = fs.openSync(
    path,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow,
    0o600,
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function assertJSON(value, depth = 0) {
  if (depth > 100) fail('aggregate nesting bound');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('nonfinite aggregate');
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail('sparse aggregate');
      assertJSON(value[i], depth + 1);
    }
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) assertJSON(item, depth + 1);
    return;
  }
  fail('non-JSON aggregate');
}
function shape(value, required, optional = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => ![...required, ...optional].includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail('invalid typed shape');
}
function integer(value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('invalid integer field');
}
function text(value, max, nonempty = false) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.length))
    fail('invalid text field');
}
function hex(value, size) {
  if (typeof value !== 'string' || value.length !== size || !/^[a-f0-9]+$/i.test(value))
    fail('invalid hash field');
}
function receipt(value) {
  shape(
    value,
    ['termsVersion', 'privacyVersion', 'acceptedAt', 'privacyAcknowledgedAt'],
    ['termsDigest', 'privacyDigest'],
  );
  text(value.termsVersion, 200, true);
  text(value.privacyVersion, 200, true);
  integer(value.acceptedAt);
  integer(value.privacyAcknowledgedAt);
  if ((value.termsDigest !== undefined) !== (value.privacyDigest !== undefined))
    fail('incomplete policy content digest');
  if (value.termsDigest !== undefined) {
    hex(value.termsDigest, 64);
    hex(value.privacyDigest, 64);
  }
}
function validateTyped(storeId, value) {
  assertJSON(value);
  if (storeId === 'auth') {
    shape(value, ['version', 'users', 'sessions', 'tokens', 'quotas'], ['commitRevision']);
    if (value.version !== 1) fail('auth schema version');
    /** @type {[string,number][]} */ const capacities = [
      ['users', 1000],
      ['tokens', 2000],
      ['quotas', 10000],
      ['sessions', 10000],
    ];
    for (const [name, max] of capacities)
      if (!Array.isArray(value[name]) || value[name].length > max) fail('auth array bound');
    const ids = new Set(),
      emails = new Set(),
      tags = new Set();
    for (const user of value.users) {
      shape(
        user,
        [
          'id',
          'email',
          'name',
          'verified',
          'mailboxTag',
          'passwordSalt',
          'passwordHash',
          'createdAt',
        ],
        ['policyAcceptance', 'policyAcceptanceHistory'],
      );
      if (!uuid.test(user.id) || ids.has(user.id)) fail('user identity');
      ids.add(user.id);
      text(user.email, 254, true);
      if (
        !/^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(user.email) ||
        user.email !== user.email.trim().toLowerCase() ||
        emails.has(user.email)
      )
        fail('canonical email');
      emails.add(user.email);
      text(user.name, 100);
      if (typeof user.verified !== 'boolean') fail('verification type');
      hex(user.mailboxTag, 12);
      if (tags.has(user.mailboxTag)) fail('duplicate mailbox tag');
      tags.add(user.mailboxTag);
      hex(user.passwordSalt, 64);
      hex(user.passwordHash, 128);
      integer(user.createdAt);
      if (user.policyAcceptance !== undefined) receipt(user.policyAcceptance);
      if (user.policyAcceptanceHistory !== undefined) {
        if (
          !Array.isArray(user.policyAcceptanceHistory) ||
          user.policyAcceptanceHistory.length < 1 ||
          user.policyAcceptanceHistory.length > 100
        )
          fail('policy acceptance history bound');
        for (const item of user.policyAcceptanceHistory) receipt(item);
        if (
          JSON.stringify(user.policyAcceptanceHistory.at(-1)) !==
          JSON.stringify(user.policyAcceptance)
        )
          fail('policy acceptance history latest mismatch');
      }
    }
    const sessionHashes = new Set(),
      perUser = new Map();
    for (const item of value.sessions) {
      shape(item, ['hash', 'userId', 'createdAt', 'expiresAt'], ['lastActiveAt']);
      hex(item.hash, 64);
      if (sessionHashes.has(item.hash) || !ids.has(item.userId)) fail('session identity/reference');
      sessionHashes.add(item.hash);
      integer(item.createdAt);
      integer(item.expiresAt);
      if (item.lastActiveAt !== undefined) integer(item.lastActiveAt);
      const count = (perUser.get(item.userId) ?? 0) + 1;
      if (count > 10) fail('session bound');
      perUser.set(item.userId, count);
    }
    const tokenHashes = new Set();
    for (const item of value.tokens) {
      shape(item, ['hash', 'userId', 'kind', 'expiresAt'], ['registration', 'failedAttemptCount']);
      hex(item.hash, 64);
      if (
        tokenHashes.has(item.hash) ||
        !ids.has(item.userId) ||
        !['verify', 'reset'].includes(item.kind)
      )
        fail('token identity/reference');
      tokenHashes.add(item.hash);
      integer(item.expiresAt);
      if (item.failedAttemptCount !== undefined) integer(item.failedAttemptCount, 5);
      if (item.registration !== undefined) {
        shape(item.registration, ['passwordSalt', 'passwordHash', 'name'], ['policyAcceptance']);
        hex(item.registration.passwordSalt, 64);
        hex(item.registration.passwordHash, 128);
        text(item.registration.name, 100);
        if (item.registration.policyAcceptance !== undefined)
          receipt(item.registration.policyAcceptance);
      }
    }
    const keys = new Set();
    for (const item of value.quotas) {
      shape(item, ['key', 'count', 'expiresAt']);
      hex(item.key, 64);
      if (keys.has(item.key)) fail('duplicate quota');
      keys.add(item.key);
      integer(item.count);
      integer(item.expiresAt);
    }
  } else if (storeId === 'lifecycle') {
    shape(value, ['version', 'commitRevision', 'records']);
    if (
      value.version !== 1 ||
      !value.records ||
      typeof value.records !== 'object' ||
      Array.isArray(value.records)
    )
      fail('lifecycle schema');
    for (const [id, item] of Object.entries(value.records)) {
      if (!uuid.test(id)) fail('lifecycle account identity');
      shape(item, ['generation', 'active', 'deletedAt', 'transactionId']);
      integer(item.generation);
      if (typeof item.active !== 'boolean' || !uuid.test(item.transactionId))
        fail('lifecycle types');
      if (item.deletedAt !== null) integer(item.deletedAt);
    }
  } else if (storeId.startsWith('connections:')) {
    validateConnections(value);
  } else if (storeId.startsWith('audit:')) {
    validateAudit(value);
  } else {
    const arrays = [
      'companies',
      'history',
      'opportunities',
      'applications',
      'messages',
      'replyDrafts',
      'mailDispatches',
      'mailEvents',
      'notifications',
      'webhookReceipts',
    ];
    shape(
      value,
      ['revision', 'mailSchema', 'profile', 'run', 'mailReceivingPaused', ...arrays],
      ['importReceipts', 'historicalAttempts'],
    );
    validateCareerImportState(value);
    if (
      value.mailSchema !== 1 ||
      typeof value.mailReceivingPaused !== 'boolean' ||
      arrays.some((key) => !Array.isArray(value[key])) ||
      (value.run !== null &&
        (!value.run || typeof value.run !== 'object' || Array.isArray(value.run)))
    )
      fail('workspace schema');
    if (value.profile !== null) {
      shape(value.profile, ['facts', 'goal', 'version', 'savedAt'], ['preferences']);
      const normalized = validateProfile(value.profile);
      const persisted = {
        facts: value.profile.facts,
        goal: value.profile.goal,
        ...(value.profile.preferences === undefined
          ? {}
          : { preferences: value.profile.preferences }),
      };
      if (stable(normalized) !== stable(persisted)) fail('profile normalized schema');
      hex(value.profile.version, 64);
      text(value.profile.savedAt, 100, true);
      if (!Number.isFinite(Date.parse(value.profile.savedAt))) fail('profile saved time');
    }
  }
  const revision = storeId.startsWith('workspace:') ? value.revision : (value.commitRevision ?? 0);
  integer(revision);
  return revision;
}
function revisionOf(storeId, value) {
  return validateTyped(storeId, value);
}

async function acquireLock(path) {
  checkPath(path, { missing: true });
  const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | nofollow, 0o600);
  try {
    const info = fs.fstatSync(fd),
      at = checkPath(path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      at.ino !== info.ino ||
      at.dev !== info.dev
    )
      fail('unsafe lock inode');
    directorySync(dirname(path));
    const probe = spawnSync('/usr/bin/flock', ['--nonblock', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd],
      env: { PATH: '/usr/bin:/bin' },
      timeout: 3000,
      maxBuffer: 4096,
    });
    if (probe.error || probe.status !== 0)
      fail('another writer holds lock or kernel lock unavailable');
    let released = false;
    return {
      assert() {
        if (released) fail('writer lock closed');
        const current = checkPath(path),
          held = fs.fstatSync(fd);
        if (
          current.ino !== info.ino ||
          current.dev !== info.dev ||
          held.ino !== info.ino ||
          held.dev !== info.dev
        )
          fail('writer lock inode changed');
      },
      async close() {
        if (released) return;
        released = true;
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function validCopyDate(value, now) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isSafeInteger(now) &&
    now >= 0 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value &&
    Date.parse(value) <= now
  );
}
function independentCopyDestination(base, destination) {
  if (typeof destination !== 'string' || !destination) fail('copy destination required');
  const target = resolve(destination);
  if (target === base || target.startsWith(base + sep) || base.startsWith(target + sep))
    fail('copy destination overlaps source');
  let parent = dirname(target);
  while (true) {
    const info = fs.lstatSync(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('copy unsafe destination ancestor');
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  try {
    fs.lstatSync(target);
    fail('copy destination must not exist');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}
function copyFileFor(base, id) {
  if (id === 'auth') return join(base, 'accounts.json');
  if (id === 'lifecycle') return join(base, 'lifecycle.json');
  for (const [prefix, name] of [
    ['workspace:', 'state.json'],
    ['audit:', 'audit.json'],
    ['connections:', 'connections.json'],
  ])
    if (id.startsWith(prefix) && uuid.test(id.slice(prefix.length)))
      return join(base, 'users', id.slice(prefix.length), name);
  fail('copy invalid aggregate identity');
}

// Snapshot under the original kernel lock, without invoking recovery on source.
// Any recovery (including interrupted-intent replay) is performed on the copy.
export async function snapshotPrivateStorage({ source, destination }) {
  const base = resolve(source);
  checkPath(base, { directory: true });
  // safeDirectory verifies that source ancestors are not symlinks; source exists.
  safeDirectory(base);
  const target = independentCopyDestination(base, destination);
  const lock = await acquireLock(join(base, '.writer.lock'));
  let count = 0,
    total = 0;
  try {
    fs.mkdirSync(target, { mode: 0o700 });
    const visit = (from, to) => {
      checkPath(from, { directory: true });
      for (const name of fs.readdirSync(from)) {
        if (from === base && name === '.writer.lock') continue;
        if (++count > 10000) fail('copy snapshot file capacity');
        const src = join(from, name),
          dst = join(to, name),
          info = fs.lstatSync(src);
        if (info.isDirectory()) {
          checkPath(src, { directory: true });
          fs.mkdirSync(dst, { mode: 0o700 });
          visit(src, dst);
        } else {
          const bytes = bytesAt(src);
          total += bytes.length;
          if (total > 512 * 1024 * 1024) fail('copy snapshot byte capacity');
          writeExclusive(dst, bytes);
        }
      }
      directorySync(to);
    };
    visit(base, target);
    lock.assert();
    directorySync(dirname(target));
  } finally {
    await lock.close();
  }
}

/**
 * @param {{directory:string, fault?:(point:string, context:{transactionId:string,storeId?:string})=>void|Promise<void>, bootstrap?:boolean}} options
 */
export async function openPrivateStorage({ directory, fault, bootstrap = false }) {
  if (typeof directory !== 'string' || !directory) fail('directory required');
  const base = safeDirectory(directory);
  const lock = await acquireLock(join(base, '.writer.lock'));
  const journal = join(base, 'private.journal');
  let staging;
  try {
    staging = safeDirectory(join(base, '.staging'));
  } catch (error) {
    await lock.close();
    throw error;
  }
  let closed = false,
    blocked = false,
    busy = false,
    seq = 0;
  const completed = new Map(),
    known = new Set(),
    authority = new Map(),
    purgeCapability = Symbol('deleted workspace purge');
  const alive = () => {
    if (closed) fail('closed');
    lock.assert();
    if (blocked) fail('recovery required');
  };
  const fileFor = (storeId) => {
    if (storeId === 'auth') return join(base, 'accounts.json');
    if (storeId === 'lifecycle') return join(base, 'lifecycle.json');
    if (
      typeof storeId === 'string' &&
      storeId.startsWith('workspace:') &&
      uuid.test(storeId.slice(10))
    )
      return join(base, 'users', storeId.slice(10), 'state.json');
    if (typeof storeId === 'string' && storeId.startsWith('audit:') && uuid.test(storeId.slice(6)))
      return join(base, 'users', storeId.slice(6), 'audit.json');
    if (
      typeof storeId === 'string' &&
      storeId.startsWith('connections:') &&
      uuid.test(storeId.slice(12))
    )
      return join(base, 'users', storeId.slice(12), 'connections.json');
    fail('invalid store identity');
  };
  function ancestors(path) {
    let current = dirname(path);
    const chain = [];
    while (true) {
      chain.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const item of chain.reverse()) {
      let info;
      try {
        info = fs.lstatSync(item);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) fail('unsafe protected ancestor');
      if (item === base || item.startsWith(base + '/')) checkPath(item, { directory: true });
    }
    return true;
  }
  const protectedBytes = (path) => (ancestors(path) ? bytesAt(path) : null);
  const load = (storeId) => {
    const bytes = protectedBytes(fileFor(storeId));
    const expected = authority.get(storeId);
    if (expected && (bytes === null || digest(bytes) !== expected.sha256))
      fail('authoritative aggregate changed');
    if (bytes === null) return null;
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('malformed aggregate');
    }
    revisionOf(storeId, value);
    known.add(storeId);
    return value;
  };
  const append = (record) => {
    const payload = Buffer.from(JSON.stringify({ ...record, seq: ++seq }));
    if (payload.length > 16384) fail('journal metadata bound');
    const frame = Buffer.alloc(4 + payload.length + 32);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    Buffer.from(digest(payload), 'hex').copy(frame, 4 + payload.length);
    const existed = fs.existsSync(journal);
    const current = checkPath(journal, { missing: true });
    if ((current?.size ?? 0) + frame.length > 64 * 1024 * 1024) fail('journal capacity reached');
    const fd = fs.openSync(
      journal,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | nofollow,
      0o600,
    );
    try {
      fs.writeFileSync(fd, frame);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!existed) directorySync(base);
  };
  function stagePath(stageId) {
    if (typeof stageId !== 'string' || !/^stage-[a-f0-9-]+-[0-2]\.json$/.test(stageId))
      fail('invalid staged identity');
    return join(staging, stageId);
  }
  function validateIntent(record) {
    if (
      !uuid.test(record.transactionId) ||
      typeof record.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
      !Array.isArray(record.targets) ||
      record.targets.length < 1 ||
      record.targets.length > 3
    )
      fail('invalid journal intent');
    const ids = new Set();
    for (const target of record.targets) {
      fileFor(target.storeId);
      stagePath(target.stageId);
      if (
        ids.has(target.storeId) ||
        !/^[a-f0-9]{64}$/.test(target.sha256) ||
        !Number.isSafeInteger(target.newRevision) ||
        target.newRevision < 0
      )
        fail('invalid journal target');
      ids.add(target.storeId);
    }
  }
  function publish(target) {
    const path = fileFor(target.storeId),
      existing = protectedBytes(path);
    if (existing && digest(existing) === target.sha256) {
      known.add(target.storeId);
      return;
    }
    const stage = stagePath(target.stageId),
      bytes = protectedBytes(stage);
    if (!bytes || digest(bytes) !== target.sha256) fail('missing/conflicting recovery aggregate');
    const value = JSON.parse(bytes.toString('utf8'));
    if (revisionOf(target.storeId, value) !== target.newRevision)
      fail('recovery revision conflict');
    safeDirectory(dirname(path));
    checkPath(path, { missing: true });
    fs.renameSync(stage, path);
    directorySync(dirname(path));
    if (dirname(path) !== staging) directorySync(staging);
    known.add(target.storeId);
  }
  function discover() {
    const ids = [];
    for (const id of ['auth', 'lifecycle']) if (protectedBytes(fileFor(id)) !== null) ids.push(id);
    const users = join(base, 'users');
    if (fs.existsSync(users)) {
      ancestors(join(users, 'sentinel'));
      checkPath(users, { directory: true });
      for (const id of fs.readdirSync(users)) {
        if (!uuid.test(id)) fail('unknown workspace directory');
        const key = 'workspace:' + id;
        if (protectedBytes(fileFor(key)) !== null) ids.push(key);
        const auditKey = 'audit:' + id;
        if (protectedBytes(fileFor(auditKey)) !== null) ids.push(auditKey);
        const connectionKey = 'connections:' + id;
        if (protectedBytes(fileFor(connectionKey)) !== null) ids.push(connectionKey);
      }
    }
    return ids.sort();
  }
  function validateGraph(replacements = new Map()) {
    const ids = new Set([...discover(), ...replacements.keys()]);
    const value = (id) => (replacements.has(id) ? replacements.get(id) : load(id));
    const auth = value('auth'),
      lifecycle = value('lifecycle'),
      users = new Set((auth?.users ?? []).map((user) => user.id));
    if (replacements.has('auth')) {
      const before = load('auth'),
        priorLifecycle = load('lifecycle');
      for (const user of before?.users ?? [])
        if (!users.has(user.id)) {
          const record = lifecycle?.records?.[user.id],
            previous = priorLifecycle?.records?.[user.id]?.generation ?? 0;
          if (!record || record.active !== false || record.generation <= previous)
            fail('auth deletion requires durable generation tombstone');
        }
    }
    for (const [id, record] of Object.entries(lifecycle?.records ?? {}))
      if (record.active && !users.has(id)) fail('active lifecycle has no auth account');
    for (const id of ids)
      if (id.startsWith('workspace:') || id.startsWith('audit:') || id.startsWith('connections:')) {
        const accountId = id.slice(
            id.startsWith('connections:') ? 12 : id.startsWith('audit:') ? 6 : 10,
          ),
          record = lifecycle?.records?.[accountId];
        if (!users.has(accountId) && !(record && record.active === false))
          fail('orphan private workspace');
      }
  }
  function verifyAuthorities() {
    const found = discover();
    for (const [id, target] of authority) {
      const bytes = protectedBytes(fileFor(id));
      if (bytes === null || digest(bytes) !== target.sha256)
        fail('committed aggregate missing or changed');
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        fail('committed aggregate malformed');
      }
      if (revisionOf(id, value) !== target.newRevision) fail('committed revision changed');
      known.add(id);
    }
    for (const id of found)
      if (!authority.has(id)) {
        if (!bootstrap) fail('untracked aggregate requires explicit conversion');
        load(id);
      }
  }
  function checkpointRecord() {
    verifyAuthorities();
    const manifest = discover().map((storeId) => {
      const bytes = protectedBytes(fileFor(storeId)),
        value = JSON.parse(bytes.toString('utf8'));
      return {
        storeId,
        sha256: digest(bytes),
        newRevision: revisionOf(storeId, value),
      };
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest)),
      manifestId = 'checkpoint-' + randomUUID() + '.json',
      path = join(base, manifestId);
    writeExclusive(path, manifestBytes);
    directorySync(base);
    const manifestHash = digest(manifestBytes);
    append({
      kind: 'checkpoint',
      transactionId: randomUUID(),
      manifestHash,
      manifestId,
    });
    for (const item of manifest) {
      authority.set(item.storeId, item);
      known.add(item.storeId);
    }
    return { manifestHash };
  }
  function readCheckpoint(record) {
    if (
      typeof record.manifestId !== 'string' ||
      !/^checkpoint-[a-f0-9-]+\.json$/.test(record.manifestId) ||
      typeof record.manifestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.manifestHash)
    )
      fail('invalid checkpoint record');
    const bytes = protectedBytes(join(base, record.manifestId));
    if (!bytes || digest(bytes) !== record.manifestHash)
      fail('checkpoint manifest missing/changed');
    let manifest;
    try {
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('checkpoint manifest malformed');
    }
    if (!Array.isArray(manifest)) fail('checkpoint manifest type');
    const seen = new Set();
    for (const item of manifest) {
      shape(item, ['storeId', 'sha256', 'newRevision']);
      fileFor(item.storeId);
      if (seen.has(item.storeId) || !/^[a-f0-9]{64}$/.test(item.sha256))
        fail('checkpoint authority identity');
      integer(item.newRevision);
      seen.add(item.storeId);
    }
    for (const id of authority.keys()) if (!seen.has(id)) fail('incomplete checkpoint authority');
    for (const item of manifest) authority.set(item.storeId, item);
  }
  function recoverInternal() {
    lock.assert();
    const bytes = bytesAtJournal();
    const records = [];
    let position = 0,
      good = 0,
      previous = 0;
    while (position < bytes.length) {
      if (bytes.length - position < 4) break;
      const length = bytes.readUInt32BE(position);
      if (length < 1 || length > 16384) fail('invalid journal frame length');
      const end = position + 4 + length + 32;
      if (end > bytes.length) break;
      const payload = bytes.subarray(position + 4, position + 4 + length),
        checksum = bytes.subarray(position + 4 + length, end);
      if (!checksum.equals(Buffer.from(digest(payload), 'hex'))) fail('journal checksum conflict');
      let record;
      try {
        record = JSON.parse(payload.toString('utf8'));
      } catch {
        fail('journal metadata malformed');
      }
      if (!Number.isSafeInteger(record.seq) || record.seq !== previous + 1)
        fail('journal sequence conflict');
      previous = record.seq;
      records.push(record);
      position = end;
      good = end;
    }
    seq = previous;
    if (good < bytes.length) {
      const tail = bytes.subarray(good),
        quarantine = join(base, 'recovery-tail-' + randomUUID() + '.bin');
      writeExclusive(quarantine, tail);
      directorySync(base);
      const fd = fs.openSync(journal, fs.constants.O_WRONLY | nofollow);
      try {
        fs.ftruncateSync(fd, good);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const pending = new Map();
    completed.clear();
    authority.clear();
    known.clear();
    for (const record of records) {
      if (record.kind === 'intent') {
        validateIntent(record);
        if (pending.has(record.transactionId) || completed.has(record.transactionId))
          fail('duplicate journal intent');
        pending.set(record.transactionId, record);
      } else if (record.kind === 'commit') {
        const intent = pending.get(record.transactionId);
        if (!intent || record.fingerprint !== intent.fingerprint) fail('orphan/conflicting commit');
        completed.set(record.transactionId, intent.fingerprint);
        for (const target of intent.targets) authority.set(target.storeId, target);
        pending.delete(record.transactionId);
      } else if (record.kind === 'checkpoint') {
        if (pending.size) fail('checkpoint during incomplete transaction');
        readCheckpoint(record);
      } else fail('unknown journal kind');
    }
    if (pending.size > 1) fail('overlapping incomplete transactions');
    for (const intent of pending.values()) {
      for (const target of intent.targets) publish(target);
      append({
        kind: 'commit',
        transactionId: intent.transactionId,
        fingerprint: intent.fingerprint,
      });
      completed.set(intent.transactionId, intent.fingerprint);
      for (const target of intent.targets) authority.set(target.storeId, target);
    }
    verifyAuthorities();
    validateGraph();
    blocked = false;
    // Replay deletion fences before erasing current private aggregates. Historical
    // journal/backups retain their existing documented retention semantics.
    for (const [id, record] of Object.entries(load('lifecycle')?.records ?? {}))
      if (record.active === false && !load('auth')?.users?.some((user) => user.id === id))
        purgeDeleted(id, true);
  }
  function bytesAtJournal() {
    const info = checkPath(journal, { missing: true });
    if (!info) return Buffer.alloc(0);
    if (info.size > 64 * 1024 * 1024) fail('journal capacity reached');
    const fd = fs.openSync(journal, fs.constants.O_RDONLY | nofollow);
    try {
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  function prepare(input, purpose) {
    alive();
    if (
      !input ||
      !uuid.test(input.transactionId) ||
      !Array.isArray(input.targets) ||
      input.targets.length < 1 ||
      input.targets.length > 3 ||
      !input.expectedRevisions ||
      typeof input.expectedRevisions !== 'object'
    )
      fail('invalid transaction');
    const fingerprint = digest(stable(input));
    if (completed.has(input.transactionId)) {
      if (completed.get(input.transactionId) !== fingerprint) fail('transaction identity reused');
      return { replayed: true, fingerprint };
    }
    if (
      !bootstrap &&
      purpose !== purgeCapability &&
      input.targets.some(
        (target) =>
          typeof target.storeId === 'string' &&
          (target.storeId.startsWith('workspace:') ||
            target.storeId.startsWith('audit:') ||
            target.storeId.startsWith('connections:')),
      ) &&
      input.accountId === undefined
    )
      fail('account context required');
    if (input.accountId !== undefined) {
      if (
        !uuid.test(input.accountId) ||
        !Number.isSafeInteger(input.generation) ||
        input.generation < 0
      )
        fail('invalid account generation');
      const lifecycle = load('lifecycle'),
        record = lifecycle?.records?.[input.accountId];
      const exists = load('auth')?.users?.some((user) => user.id === input.accountId);
      if (
        record
          ? !record.active || !exists || record.generation !== input.generation
          : !exists || input.generation !== 0
      )
        fail('account inactive or stale generation');
      for (const target of input.targets)
        if (
          target.storeId !== 'workspace:' + input.accountId &&
          target.storeId !== 'audit:' + input.accountId &&
          target.storeId !== 'connections:' + input.accountId
        )
          fail('foreign account target');
    }
    const proposed = new Map();
    for (const target of input.targets) {
      fileFor(target.storeId);
      revisionOf(target.storeId, target.value);
      if (proposed.has(target.storeId)) fail('duplicate transaction target');
      proposed.set(target.storeId, target.value);
    }
    validateGraph(proposed);
    const ids = new Set(),
      targets = [];
    for (const [index, target] of input.targets.entries()) {
      assertJSON(target.value);
      const path = fileFor(target.storeId);
      if (ids.has(target.storeId) || !Object.hasOwn(input.expectedRevisions, target.storeId))
        fail('duplicate target/missing expected revision');
      ids.add(target.storeId);
      const current = load(target.storeId),
        actual = current === null ? null : revisionOf(target.storeId, current),
        expected = input.expectedRevisions[target.storeId];
      if (actual !== expected) fail('revision conflict');
      if (
        !Number.isSafeInteger(target.revision) ||
        target.revision < 0 ||
        (actual !== null && target.revision !== actual + 1) ||
        revisionOf(target.storeId, target.value) !== target.revision
      )
        fail('invalid new revision');
      const bytes = Buffer.from(JSON.stringify(target.value));
      if (
        bytes.length >
        (target.storeId.startsWith('connections:')
          ? 0.5
          : target.storeId.startsWith('workspace:')
            ? 32
            : 16) *
          1024 *
          1024
      )
        fail('aggregate capacity');
      const stageId = 'stage-' + input.transactionId + '-' + index + '.json';
      const staged = stagePath(stageId);
      if (fs.existsSync(staged)) {
        const prior = protectedBytes(staged);
        if (!prior || !prior.equals(bytes)) fail('stage identity reused');
      } else writeExclusive(staged, bytes);
      targets.push({
        storeId: target.storeId,
        expectedRevision: expected,
        newRevision: target.revision,
        stageId,
        sha256: digest(bytes),
      });
      void path;
    }
    directorySync(staging);
    return {
      kind: 'intent',
      transactionId: input.transactionId,
      fingerprint,
      targets,
    };
  }
  /** @returns {Generator<[string,{transactionId:string,storeId?:string}],{replayed:boolean},unknown>} */
  function* workflow(input, purpose) {
    const intent = prepare(input, purpose);
    if (intent.replayed) return { replayed: true };
    blocked = true;
    append(intent);
    yield ['after-intent', { transactionId: input.transactionId }];
    for (const target of intent.targets) {
      lock.assert();
      publish(target);
      yield ['after-publish', { transactionId: input.transactionId, storeId: target.storeId }];
    }
    yield ['before-commit', { transactionId: input.transactionId }];
    append({
      kind: 'commit',
      transactionId: input.transactionId,
      fingerprint: intent.fingerprint,
    });
    completed.set(input.transactionId, intent.fingerprint);
    for (const target of intent.targets) authority.set(target.storeId, target);
    blocked = false;
    return { replayed: false };
  }
  function purgeDeleted(accountId, recovering = false) {
    alive();
    if (busy || (!recovering && fault)) fail('purge unavailable');
    if (!uuid.test(accountId)) fail('invalid purge identity');
    const auth = load('auth'),
      record = load('lifecycle')?.records?.[accountId];
    if (
      auth?.users?.some((user) => user.id === accountId) ||
      !record ||
      record.active !== false ||
      record.generation < 1
    )
      fail('account is not durably deleted');
    const storeId = 'workspace:' + accountId,
      current = load(storeId),
      auditId = 'audit:' + accountId,
      auditCurrent = load(auditId);
    const workspaceBlank = {
      revision: current?.revision ?? 0,
      mailSchema: 1,
      profile: null,
      companies: [],
      run: null,
      history: [],
      opportunities: [],
      applications: [],
      messages: [],
      replyDrafts: [],
      mailDispatches: [],
      mailEvents: [],
      notifications: [],
      webhookReceipts: [],
      mailReceivingPaused: true,
    };
    const targets = [],
      expectedRevisions = {};
    if (current && stable(current) !== stable(workspaceBlank)) {
      workspaceBlank.revision = current.revision + 1;
      targets.push({
        storeId,
        value: workspaceBlank,
        revision: workspaceBlank.revision,
      });
      expectedRevisions[storeId] = current.revision;
    }
    if (
      auditCurrent &&
      (auditCurrent.events.length || Object.keys(auditCurrent.snapshots).length)
    ) {
      const blank = createAudit();
      blank.commitRevision = auditCurrent.commitRevision + 1;
      targets.push({
        storeId: auditId,
        value: blank,
        revision: blank.commitRevision,
      });
      expectedRevisions[auditId] = auditCurrent.commitRevision;
    }
    const connectionId = 'connections:' + accountId,
      connections = load(connectionId);
    if (connections?.grants.length) {
      const blank = {
        version: 1,
        commitRevision: connections.commitRevision + 1,
        grants: [],
        historyEpoch: randomUUID(),
        historyAnchor: null,
        cursorKey: connections.cursorKey,
      };
      targets.push({
        storeId: connectionId,
        value: blank,
        revision: blank.commitRevision,
      });
      expectedRevisions[connectionId] = connections.commitRevision;
    }
    if (!targets.length) return { purged: true, revision: current?.revision ?? null };
    busy = true;
    try {
      const iterator = workflow(
        { transactionId: randomUUID(), expectedRevisions, targets },
        purgeCapability,
      );
      let step = iterator.next();
      while (step.done === false) step = iterator.next();
      return { purged: true, revision: workspaceBlank.revision };
    } finally {
      busy = false;
    }
  }
  try {
    recoverInternal();
  } catch (error) {
    await lock.close();
    throw error;
  }
  return {
    // Offline copy-forward only: never rotates or deletes the source generation.
    async exportCurrentCopy({
      destination,
      originalCreatedAt,
      now = Date.now(),
      tombstones = [],
      revokeCredentials = false,
      ledgerDigest = null,
      beforeReady,
    } = {}) {
      alive();
      if (busy) fail('copy unavailable during mutation');
      const target = independentCopyDestination(base, destination);
      if (!validCopyDate(originalCreatedAt, now)) fail('copy original creation date');
      if (beforeReady !== undefined && typeof beforeReady !== 'function')
        fail('copy readiness guard');
      if (!Array.isArray(tombstones) || tombstones.length > 1000) fail('copy tombstone capacity');
      const removed = new Map();
      for (const item of tombstones) {
        shape(item, ['accountId', 'generation', 'deletedAt']);
        if (
          !uuid.test(item.accountId) ||
          item.accountId !== item.accountId.toLowerCase() ||
          removed.has(item.accountId) ||
          !Number.isSafeInteger(item.generation) ||
          item.generation < 1 ||
          !Number.isSafeInteger(item.deletedAt) ||
          item.deletedAt < 0 ||
          item.deletedAt > now
        )
          fail('copy tombstone invalid');
        removed.set(item.accountId, item);
      }
      busy = true;
      let output;
      try {
        verifyAuthorities();
        validateGraph();
        const values = new Map(discover().map((id) => [id, clone(load(id))]));
        const lifecycle = values.get('lifecycle') ?? {
          version: 1,
          commitRevision: 0,
          records: {},
        };
        for (const [id, record] of Object.entries(lifecycle.records))
          if (!record.active)
            removed.set(id, {
              accountId: id,
              generation: Math.max(record.generation, removed.get(id)?.generation ?? 0),
              deletedAt: record.deletedAt ?? removed.get(id)?.deletedAt ?? now,
            });
        for (const item of removed.values()) {
          const previous = lifecycle.records[item.accountId];
          lifecycle.records[item.accountId] = {
            generation: Math.max(item.generation, previous?.generation ?? 0),
            active: false,
            deletedAt: previous?.active === false ? previous.deletedAt : item.deletedAt,
            transactionId: randomUUID(),
          };
          for (const prefix of ['workspace:', 'audit:', 'connections:'])
            values.delete(prefix + item.accountId);
        }
        if (removed.size) values.set('lifecycle', lifecycle);
        const auth = values.get('auth');
        if (auth) {
          auth.users = auth.users.filter((user) => !removed.has(user.id));
          auth.sessions = revokeCredentials
            ? []
            : auth.sessions.filter((session) => !removed.has(session.userId));
          auth.tokens = revokeCredentials
            ? []
            : auth.tokens.filter((token) => !removed.has(token.userId));
        }
        if (revokeCredentials)
          for (const [id, value] of values)
            if (id.startsWith('connections:')) {
              value.grants = [];
              value.historyEpoch = randomUUID();
              value.historyAnchor = null;
              value.cursorKey = randomBytes(32).toString('hex');
            }
        // Revision-preserving materialization is a bootstrap into a new generation,
        // never a transaction against the old authoritative journal.
        fs.mkdirSync(target, { mode: 0o700 });
        directorySync(dirname(target));
        for (const [id, value] of values) {
          revisionOf(id, value);
          const path = copyFileFor(target, id);
          safeDirectory(dirname(path));
          writeExclusive(path, Buffer.from(JSON.stringify(value)));
          directorySync(dirname(path));
        }
        output = await openPrivateStorage({
          directory: target,
          bootstrap: true,
        });
        await output.checkpoint();
        await output.close();
        output = null;
        output = await openPrivateStorage({ directory: target });
        for (const [id, value] of values)
          if (stable(await output.read(id)) !== stable(value)) fail('copy verification mismatch');
        for (const id of removed.keys())
          for (const prefix of ['workspace:', 'audit:', 'connections:'])
            if ((await output.read(prefix + id)) !== null) fail('copy deleted aggregate survived');
        await output.close();
        output = null;
        const ready = {
          version: 1,
          ready: true,
          originalCreatedAt,
          verifiedAt: new Date(now).toISOString(),
          ledgerDigest,
          sourceJournalSha256: digest(bytesAtJournal()),
          manifestHash: digest(
            stable(
              [...values]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([id, value]) => ({ id, sha256: digest(stable(value)) })),
            ),
          ),
        };
        lock.assert();
        if (beforeReady?.()?.then) fail('copy readiness guard must be synchronous');
        writeExclusive(join(target, 'retention-ready.json'), Buffer.from(JSON.stringify(ready)));
        directorySync(target);
        return ready;
      } finally {
        if (output) await output.close();
        busy = false;
      }
    },
    readSync(storeId) {
      alive();
      return clone(load(storeId));
    },
    async read(storeId) {
      alive();
      return clone(load(storeId));
    },
    commitSync(input) {
      if (busy || fault) fail('sync transaction unavailable');
      busy = true;
      try {
        const iterator = workflow(input);
        let step = iterator.next();
        while (step.done === false) step = iterator.next();
        return step.value;
      } finally {
        busy = false;
      }
    },
    async commit(input) {
      if (busy) fail('another private mutation is active');
      busy = true;
      try {
        const iterator = workflow(input);
        let step = iterator.next();
        while (step.done === false) {
          if (fault) await fault(step.value[0], step.value[1]);
          step = iterator.next();
        }
        return step.value;
      } finally {
        busy = false;
      }
    },
    async purgeDeletedWorkspace(accountId) {
      return this.purgeDeletedWorkspaceSync(accountId);
    },
    purgeDeletedWorkspaceSync(accountId) {
      return purgeDeleted(accountId);
    },
    async recover() {
      if (closed || busy) fail('recovery unavailable');
      try {
        recoverInternal();
      } catch (error) {
        blocked = true;
        throw error;
      }
    },
    async checkpoint() {
      alive();
      if (busy) fail('checkpoint unavailable');
      try {
        return checkpointRecord();
      } catch (error) {
        blocked = true;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      if (busy) fail('transaction in progress');
      closed = true;
      await lock.close();
    },
  };
}
