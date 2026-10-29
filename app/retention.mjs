// Dormant operator-only maintenance. No imports from app servers or schedulers.
import * as fs from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { createHash } from 'node:crypto';
const DAY = 86400000,
  MAX_FILE = 32 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hex = /^[a-f0-9]{64}$/;
const fail = (message) => {
  throw Error('Retention: ' + message);
};
const present = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
};
const hash = (b) => createHash('sha256').update(b).digest('hex');
const stable = (v) =>
  Array.isArray(v)
    ? '[' + v.map(stable).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + stable(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v);
function object(v, required, optional = []) {
  if (
    !v ||
    Array.isArray(v) ||
    typeof v !== 'object' ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => ![...required, ...optional].includes(k))
  )
    fail('invalid metadata shape');
}
function time(v) {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    fail('invalid UTC date');
  return Date.parse(v);
}
function checkedPath(path, directory = false) {
  let current = parse(resolve(path)).root;
  for (const part of resolve(path).slice(current.length).split('/')) {
    current = join(current, part);
    const s = fs.lstatSync(current);
    if (s.isSymbolicLink()) fail('symlink path refused');
  }
  const s = fs.lstatSync(path);
  if (
    s.uid !== process.getuid() ||
    (s.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
  )
    fail('unsafe protected path');
  return s;
}
function read(path, max = MAX_FILE) {
  checkedPath(path);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const a = fs.fstatSync(fd);
    if (a.size > max) fail('file capacity exceeded');
    const bytes = fs.readFileSync(fd),
      b = fs.fstatSync(fd);
    if (a.ino !== b.ino || a.size !== b.size || a.ctimeMs !== b.ctimeMs || a.nlink !== 1)
      fail('file changed during inspection');
    return {
      bytes,
      identity: {
        dev: b.dev,
        ino: b.ino,
        size: b.size,
        mtimeMs: b.mtimeMs,
        ctimeMs: b.ctimeMs,
        sha256: hash(bytes),
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}
function syncDir(root) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function save(root, name, value) {
  const temp = join(root, '.retention-write-' + process.pid),
    target = join(root, name);
  const fd = fs.openSync(
    temp,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (present(target)) checkedPath(target);
    fs.renameSync(temp, target);
    syncDir(root);
  } catch (e) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw e;
  }
}
function readProgress(root) {
  const p = join(root, '.retention-progress.json');
  if (!present(p)) return null;
  let v;
  try {
    v = JSON.parse(read(p, 2 * 1024 * 1024).bytes);
  } catch {
    fail('invalid progress receipt');
  }
  object(v, ['version', 'manifestHash', 'plan', 'states'], ['finalizing']);
  if (
    v.version !== 1 ||
    !hex.test(v.manifestHash) ||
    !v.plan ||
    !Array.isArray(v.plan.entries) ||
    !Array.isArray(v.states) ||
    v.states.length > 1000
  )
    fail('invalid progress receipt');
  const ids = new Set();
  for (const s of v.states) {
    object(s, ['id', 'state']);
    if (
      !uuid.test(s.id) ||
      ids.has(s.id) ||
      !v.plan.body?.entries?.some((e) => e.id === s.id && e.action === 'delete') ||
      !['pending', 'deleted', 'reconciled-missing'].includes(s.state)
    )
      fail('invalid progress state');
    ids.add(s.id);
  }
  if (
    hash(stable(v.plan.body)) !== v.plan.digest ||
    v.plan.now !== v.plan.body.now ||
    v.manifestHash !== v.plan.body.manifestIdentity?.sha256
  )
    fail('progress plan integrity');
  return v;
}
function deadline(e, now) {
  object(
    e,
    ['id', 'file', 'category', 'createdAt', 'sha256'],
    ['closedAt', 'compactedAt', 'compactionReceipt', 'compactionReceiptFile', 'hold'],
  );
  if (
    !uuid.test(e.id) ||
    typeof e.file !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(e.file) ||
    e.file === 'manifest.json' ||
    !hex.test(e.sha256)
  )
    fail('invalid copy identity');
  const created = time(e.createdAt);
  if (created > now) fail('future creation date');
  let closed;
  if (e.closedAt !== undefined) {
    closed = time(e.closedAt);
    if (closed < created || closed > now) fail('invalid closure chronology');
  }
  let due, reason;
  switch (e.category) {
    case 'backup':
      due = created + 30 * DAY;
      break;
    case 'journal':
      if (
        e.compactedAt === undefined ||
        e.compactionReceipt === undefined ||
        e.compactionReceiptFile === undefined
      ) {
        reason = 'verified-compaction-required';
        break;
      }
      if (!hex.test(e.compactionReceipt)) fail('invalid compaction receipt');
      {
        const compacted = time(e.compactedAt);
        if (compacted < created || compacted > now) fail('invalid compaction chronology');
        due = Math.min(created + 30 * DAY, compacted + 7 * DAY);
      }
      break;
    case 'operator':
    case 'support':
    case 'rights-attachment':
    case 'minimal-evidence':
      if (closed === undefined) {
        reason = 'closure-required';
        break;
      }
      if (e.category === 'minimal-evidence') {
        const d = new Date(closed),
          month = d.getUTCMonth();
        d.setUTCFullYear(d.getUTCFullYear() + 3);
        if (d.getUTCMonth() !== month) d.setUTCDate(0);
        due = +d;
      } else due = closed + { operator: 7, support: 90, 'rights-attachment': 30 }[e.category] * DAY;
      break;
    case 'metadata':
      due = created + 90 * DAY;
      break;
    default:
      fail('unknown category; manual classification required');
  }
  if (e.hold !== undefined) {
    const h = e.hold;
    object(h, ['owner', 'reason', 'setAt', 'reviewAt', 'expiresAt']);
    if (
      ![h.owner, h.reason].every(
        (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 200,
      )
    )
      fail('invalid hold');
    const set = time(h.setAt),
      review = time(h.reviewAt),
      end = time(h.expiresAt);
    if (set > now || review < set || end < set || review > set + 90 * DAY || end > set + 90 * DAY)
      fail('invalid hold duration');
    return {
      action: 'held',
      reason: review <= now || end <= now ? 'hold-review-required' : 'scoped-hold',
      dueAt: due ? new Date(due).toISOString() : null,
    };
  }
  return {
    action: reason ? 'blocked' : now >= due ? 'delete' : 'retain',
    reason: reason ?? (now >= due ? 'expired' : 'not-due'),
    dueAt: due ? new Date(due).toISOString() : null,
  };
}
export function planRetention({ root, now = new Date().toISOString() }) {
  root = resolve(root);
  checkedPath(root, true);
  const at = time(now);
  const manifest = read(join(root, 'manifest.json'), 1024 * 1024);
  let m;
  try {
    m = JSON.parse(manifest.bytes);
  } catch {
    fail('malformed manifest');
  }
  object(m, ['version', 'entries']);
  if (m.version !== 1 || !Array.isArray(m.entries) || m.entries.length > 1000)
    fail('inventory capacity/schema');
  const prior = readProgress(root),
    ids = new Set(),
    files = new Set();
  if (prior?.finalizing) fail('batch finalization incomplete; resume finalize');
  if (prior && prior.manifestHash !== manifest.identity.sha256)
    fail('inventory changed after execution; reconcile prior receipt first');
  const entries = m.entries.map((e) => {
    const result = deadline(e, at);
    if (e.category === 'journal' && result.action === 'delete') {
      if (
        typeof e.compactionReceiptFile !== 'string' ||
        !/^receipt-[a-f0-9-]+\.json$/.test(e.compactionReceiptFile)
      )
        fail('invalid compaction receipt path');
      const proof = read(join(root, e.compactionReceiptFile), 1024 * 1024);
      if (proof.identity.sha256 !== e.compactionReceipt) fail('compaction receipt mismatch');
      let v;
      try {
        v = JSON.parse(proof.bytes);
      } catch {
        fail('invalid compaction receipt');
      }
      if (
        v.version !== 1 ||
        v.ready !== true ||
        v.sourceJournalSha256 !== e.sha256 ||
        v.originalCreatedAt !== e.createdAt ||
        v.verifiedAt !== e.compactedAt
      )
        fail('unverified compaction receipt');
      result.compactionProofIdentity = proof.identity;
    }
    if (ids.has(e.id) || files.has(e.file)) fail('duplicate copy identity');
    ids.add(e.id);
    files.add(e.file);
    let identity;
    const path = join(root, e.file),
      state = prior?.states.find((x) => x.id === e.id);
    if (!present(path) && state) {
      const old = prior.plan.body.entries.find((x) => x.id === e.id);
      if (!old || old.sha256 !== e.sha256) fail('missing file without matching intent');
      identity = old.identity;
    } else {
      identity = read(path).identity;
      if (identity.sha256 !== e.sha256) fail('copy content mismatch');
      if (state && state.state !== 'pending')
        fail('deleted copy reappeared; manual reconciliation required');
    }
    return { ...e, ...result, identity };
  });
  const rootInfo = fs.lstatSync(root);
  // Directory mtime changes due to our lock/receipt, so bind stable device/inode only.
  const body = {
    version: 1,
    root,
    rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino },
    now,
    manifestIdentity: manifest.identity,
    entries,
  };
  const digest = hash(stable(body));
  return {
    now,
    digest,
    entries: entries.map(({ identity: _identity, hold: _hold, ...e }) => e),
    body,
  };
}
export function executeRetention({
  root,
  now,
  approve,
  enabled = false,
  clock = Date.now(),
  beforeUnlink,
}) {
  if (enabled !== true) fail('execution disabled');
  if (typeof approve !== 'string' || !hex.test(approve)) fail('explicit approved digest required');
  const at = time(now);
  if (clock < at || clock - at > 15 * 60000) fail('approval expired or in future');
  root = resolve(root);
  checkedPath(root, true);
  const lock = join(root, '.retention-lock');
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch {
    fail('maintenance lock unavailable');
  }
  try {
    const p = planRetention({ root, now });
    if (p.digest !== approve) fail('stale approval');
    let progress = readProgress(root);
    if (progress && progress.plan.digest !== p.digest)
      fail('existing batch requires reconciliation');
    if (!progress)
      progress = { version: 1, manifestHash: p.body.manifestIdentity.sha256, plan: p, states: [] };
    let deleted = 0,
      reconciled = 0;
    for (const e of p.body.entries.filter((x) => x.action === 'delete')) {
      let state = progress.states.find((x) => x.id === e.id);
      if (state && state.state !== 'pending') continue;
      const path = join(root, e.file);
      if (!state) {
        state = { id: e.id, state: 'pending' };
        progress.states.push(state);
        save(root, '.retention-progress.json', progress);
      }
      if (present(path)) {
        if (beforeUnlink) beforeUnlink(e.id);
        const currentRoot = checkedPath(root, true);
        if (
          currentRoot.dev !== p.body.rootIdentity.dev ||
          currentRoot.ino !== p.body.rootIdentity.ino
        )
          fail('root changed before removal');
        if (
          stable(read(join(root, 'manifest.json'), 1024 * 1024).identity) !==
          stable(p.body.manifestIdentity)
        )
          fail('inventory changed before removal');
        if (
          e.compactionProofIdentity &&
          stable(read(join(root, e.compactionReceiptFile), 1024 * 1024).identity) !==
            stable(e.compactionProofIdentity)
        )
          fail('compaction proof changed before removal');
        if (stable(read(path).identity) !== stable(e.identity)) fail('copy changed before removal');
        fs.unlinkSync(path);
        syncDir(root);
        state.state = 'deleted';
        deleted++;
      } else {
        state.state = 'reconciled-missing';
        reconciled++;
      }
      save(root, '.retention-progress.json', progress);
    }
    return {
      status: 'completed',
      digest: p.digest,
      deleted,
      reconciledMissing: reconciled,
      previouslyCompleted: progress.states.length - deleted - reconciled,
    };
  } finally {
    fs.rmdirSync(lock);
    syncDir(root);
  }
}

/** Finalize only an entirely completed batch; never deletes copy contents. */
export function finalizeRetention({ root, approve, enabled = false, beforePublish }) {
  if (enabled !== true) fail('execution disabled');
  root = resolve(root);
  checkedPath(root, true);
  const lock = join(root, '.retention-lock');
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch {
    fail('maintenance lock unavailable');
  }
  try {
    const progress = readProgress(root);
    if (!progress || progress.plan.digest !== approve) fail('completed batch approval required');
    const original = progress.plan.body,
      deleted = original.entries.filter((e) => e.action === 'delete');
    if (deleted.some((e) => !progress.states.some((s) => s.id === e.id && s.state !== 'pending')))
      fail('batch is incomplete');
    const info = checkedPath(root, true);
    if (info.dev !== original.rootIdentity.dev || info.ino !== original.rootIdentity.ino)
      fail('root changed');
    for (const e of original.entries) {
      if (e.action === 'delete') {
        if (present(join(root, e.file))) fail('deleted copy reappeared');
      } else if (stable(read(join(root, e.file)).identity) !== stable(e.identity))
        fail('retained copy changed');
    }
    const manifest = read(join(root, 'manifest.json'), 1024 * 1024);
    if (!progress.finalizing) {
      if (stable(manifest.identity) !== stable(original.manifestIdentity))
        fail('inventory changed before finalization');
      const m = JSON.parse(manifest.bytes);
      m.entries = m.entries.filter((e) => !deleted.some((d) => d.id === e.id));
      progress.finalizing = {
        manifest: m,
        sha256: hash(JSON.stringify(m)),
        startedAt: new Date().toISOString(),
      };
      save(root, '.retention-progress.json', progress);
    } else {
      const f = progress.finalizing;
      object(f, ['manifest', 'sha256', 'startedAt']);
      time(f.startedAt);
      if (hash(JSON.stringify(f.manifest)) !== f.sha256) fail('invalid finalization intent');
      if (
        manifest.identity.sha256 !== original.manifestIdentity.sha256 &&
        manifest.identity.sha256 !== f.sha256
      )
        fail('finalization inventory changed');
    }
    if (beforePublish) beforePublish();
    const current = checkedPath(root, true);
    if (current.dev !== original.rootIdentity.dev || current.ino !== original.rootIdentity.ino)
      fail('root changed');
    const latest = read(join(root, 'manifest.json'), 1024 * 1024);
    if (
      ![original.manifestIdentity.sha256, progress.finalizing.sha256].includes(
        latest.identity.sha256,
      )
    )
      fail('finalization inventory changed');
    save(root, 'manifest.json', progress.finalizing.manifest);
    const receipt = join(root, 'retention-receipt-' + approve + '.json');
    const minimal = {
      version: 1,
      digest: approve,
      completedAt: progress.finalizing.startedAt,
      states: progress.states,
    };
    if (present(receipt)) {
      if (read(receipt).bytes.toString() !== JSON.stringify(minimal))
        fail('conflicting finalization receipt');
    } else save(root, 'retention-receipt-' + approve + '.json', minimal);
    fs.unlinkSync(join(root, '.retention-progress.json'));
    syncDir(root);
    return {
      status: 'finalized',
      digest: approve,
      remaining: progress.finalizing.manifest.entries.length,
    };
  } finally {
    fs.rmdirSync(lock);
    syncDir(root);
  }
}
