import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { openPrivateStorage, snapshotPrivateStorage } from './private-storage.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = () => {
  throw new Error('Retention restore: ledger or copy validation refused');
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
}
function date(value, now) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value ||
    Date.parse(value) > now
  )
    fail();
  return Date.parse(value);
}
function ancestors(path) {
  let current = dirname(path);
  for (;;) {
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail();
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
function readBoundedLedger(fd) {
  const bytes = Buffer.alloc(1024 * 1024 + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
    if (!read) break;
    offset += read;
  }
  if (offset > 1024 * 1024) fail();
  return bytes.subarray(0, offset);
}

/** Offline operator boundary. currentSnapshot is a positive completeness attestation,
 * not a claim that software can discover omitted external deletion records. */
export async function createVerifiedRetentionCopy({
  source,
  destination,
  ledgerPath,
  ledgerDigest,
  currentSnapshot,
  originalCreatedAt,
  now = Date.now(),
} = {}) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    currentSnapshot !== true ||
    typeof ledgerDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ledgerDigest)
  )
    fail();
  if ([source, destination, ledgerPath].some((value) => typeof value !== 'string' || !value))
    fail();
  const src = resolve(source),
    dst = resolve(destination),
    ledger = resolve(ledgerPath);
  if (overlaps(src, dst) || overlaps(src, ledger) || overlaps(dst, ledger)) fail();
  date(originalCreatedAt, now);
  ancestors(src);
  ancestors(dst);
  ancestors(ledger);
  try {
    fs.lstatSync(dst);
    fail();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const st = fs.lstatSync(ledger);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.uid !== process.getuid() ||
    (st.mode & 0o777) !== 0o600 ||
    st.size > 1024 * 1024
  )
    fail();
  const fd = fs.openSync(ledger, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const held = fs.fstatSync(fd);
    if (held.ino !== st.ino || held.dev !== st.dev || held.size > 1024 * 1024) fail();
    bytes = readBoundedLedger(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (hash(bytes) !== ledgerDigest) fail();
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    fail();
  }
  exact(value, ['version', 'asOf', 'records']);
  if (
    value.version !== 1 ||
    now - date(value.asOf, now) > 86400000 ||
    !Array.isArray(value.records) ||
    value.records.length > 1000
  )
    fail();
  const seen = new Set(),
    tombstones = value.records.map((record) => {
      exact(record, ['accountId', 'generation', 'deletedAt']);
      if (
        !uuid.test(record.accountId) ||
        record.accountId !== record.accountId.toLowerCase() ||
        seen.has(record.accountId) ||
        !Number.isSafeInteger(record.generation) ||
        record.generation < 1
      )
        fail();
      seen.add(record.accountId);
      return {
        ...record,
        deletedAt: date(record.deletedAt, Date.parse(value.asOf)),
      };
    });
  const temp = fs.mkdtempSync(join(tmpdir(), 'rm-retention-source-'));
  fs.chmodSync(temp, 0o700);
  const started = performance.now();
  const verifyLedgerSnapshot = () => {
    ancestors(ledger);
    const latest = fs.lstatSync(ledger);
    if (
      !latest.isFile() ||
      latest.isSymbolicLink() ||
      latest.nlink !== 1 ||
      latest.uid !== st.uid ||
      (latest.mode & 0o777) !== 0o600 ||
      latest.ino !== st.ino ||
      latest.dev !== st.dev ||
      latest.size !== st.size ||
      now + (performance.now() - started) - Date.parse(value.asOf) > 86400000
    )
      fail();
    const currentFd = fs.openSync(ledger, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const held = fs.fstatSync(currentFd);
      if (
        held.ino !== st.ino ||
        held.dev !== st.dev ||
        held.size > 1024 * 1024 ||
        hash(readBoundedLedger(currentFd)) !== ledgerDigest
      )
        fail();
    } finally {
      fs.closeSync(currentFd);
    }
  };
  let store;
  try {
    const working = join(temp, 'snapshot');
    await snapshotPrivateStorage({ source: src, destination: working });
    store = await openPrivateStorage({ directory: working });
    return await store.exportCurrentCopy({
      destination: dst,
      originalCreatedAt,
      now,
      tombstones,
      revokeCredentials: true,
      ledgerDigest,
      beforeReady: verifyLedgerSnapshot,
    });
  } finally {
    if (store) await store.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
