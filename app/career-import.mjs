import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { files as normalizeFiles, analyzeMail } from './mail.mjs';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const MAX_BYTES = 6 * 1024 * 1024,
  CHUNK = 49152,
  VERSION = 1;
const fail = (status, message, code = 'import_error') => {
  throw Object.assign(new Error(message), { status, code });
};
const canonical = (v) => JSON.stringify(sort(v));
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sort(v[k])]),
    );
  return v;
}
const digest = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' || Buffer.isBuffer(v) ? v : canonical(v))
    .digest('hex');
function shape(v, required, optional = []) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => ![...required, ...optional].includes(k))
  )
    fail(400, 'Unexpected or missing import fields');
}
function text(v, max, required = false) {
  if (typeof v !== 'string' || v.length > max || v.includes('\0') || (required && !v.trim()))
    fail(400, 'Invalid import text');
  return v;
}
function email(v) {
  const s = text(v, 254, true).trim().toLowerCase();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s))
    fail(400, 'Invalid source email');
  return s;
}
function ids(v) {
  if (!UUID.test(v ?? '')) fail(400, 'Invalid import identity');
  return v;
}
function addresses(v) {
  if (!Array.isArray(v) || v.length > 20) fail(400, 'Too many message recipients');
  return v.map(email);
}
function instant(v) {
  if (v === undefined || v === null || v === '') return { value: null, status: 'unknown' };
  if (
    typeof v !== 'string' ||
    v.length > 100 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    return { value: null, status: 'invalid' };
  const calendar = v.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(calendar[0], calendar[1] - 1, calendar[2]));
  if (
    date.getUTCFullYear() !== calendar[0] ||
    date.getUTCMonth() !== calendar[1] - 1 ||
    date.getUTCDate() !== calendar[2]
  )
    return { value: null, status: 'invalid' };
  return { value: new Date(v).toISOString(), status: 'verified' };
}
const authSubject = (s) =>
  /password\s*(?:reset|change)|reset\s*(?:your\s*)?password|(?:security|authentication|verification|one.time|sign.in|login)\s*(?:code|token|link|alert)|verify\s*(?:your\s*)?(?:email|account)|two.factor/i.test(
    s,
  );
const authenticationUrl = (s) =>
  /https?:\/\/[^\s<>"']{1,1900}\/(?:reset[-_/]?password|password[-_/]?reset|magic[-_/]?login|magic[-_/]?link|sign[-_/]?in|verify[-_/]?(?:email|account))[^\s<>"']{0,1500}[?&](?:token|code|key)=/i.test(
    s,
  );
const sensitive = (s) =>
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:access_token|refresh_token|client_secret)\s*[:=]|\b(?:password|api[_ -]?key)\s*[:=]\s*\S+|\b(?:verification|authentication|one.time|security)\s*code\s*(?:is|:|=)?\s*\d{4,8}\b/i.test(
    s,
  );
function publicUrl(v) {
  if (v === undefined || v === null || v === '') return null;
  text(v, 2048, true);
  let u;
  try {
    u = new URL(v);
  } catch {
    fail(400, 'Invalid vacancy URL');
  }
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    isIP(u.hostname.replace(/^\[|\]$/g, '')) ||
    !u.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)
  )
    fail(400, 'Vacancy URL must be a public HTTP URL');
  u.hash = '';
  for (const k of [...u.searchParams.keys()])
    if (/^utm_/i.test(k) || ['gclid', 'fbclid'].includes(k.toLowerCase())) u.searchParams.delete(k);
  return u.href;
}
function actor(owner) {
  const grant = owner.principalId.startsWith('grant:') ? owner.principalId.slice(6) : null;
  if (grant && !UUID.test(grant)) fail(401, 'Invalid originating grant');
  return {
    type: grant ? 'agent' : 'user',
    id: grant ?? owner.accountId,
    role: 'career-import',
    ...(grant ? { grantId: grant } : {}),
  };
}
function own(owner) {
  if (
    !owner ||
    !UUID.test(owner.accountId ?? '') ||
    !Number.isSafeInteger(owner.generation) ||
    owner.generation < 0 ||
    typeof owner.principalId !== 'string' ||
    owner.principalId.length > 200 ||
    !/^(?:web:|grant:)/.test(owner.principalId)
  )
    fail(401, 'Import authority required');
  return { ...owner, email: email(owner.email) };
}
function sourceKey(sourceAccount, p) {
  return digest({
    namespace: 'ja-permanent',
    sourceAccount,
    kind: p.kind,
    id: p.kind === 'vacancy' ? p.sourceId : p.providerMessageId,
  });
}
function normalize(raw, session, entry) {
  if (raw.kind !== entry.kind || raw.namespace !== 'ja-permanent')
    fail(400, 'Only selected permanent-employment source records are supported');
  if (raw.kind === 'vacancy') {
    shape(
      raw,
      ['kind', 'namespace', 'sourceId', 'company', 'title'],
      ['url', 'description', 'postingId', 'employerDomain', 'observedAt'],
    );
    const p = {
      kind: raw.kind,
      namespace: raw.namespace,
      sourceId: text(raw.sourceId, 200, true),
      company: text(raw.company, 100, true),
      title: text(raw.title, 250, true),
      url: raw.url ?? null,
      canonicalUrl: publicUrl(raw.url),
      description: text(raw.description ?? '', 40000),
      postingId: text(raw.postingId ?? '', 200),
      employerDomain: text(raw.employerDomain ?? '', 254).toLowerCase(),
      observedAt: instant(raw.observedAt).value,
    };
    if (sensitive(p.description)) fail(400, 'Sensitive content requires manual redaction');
    return p;
  }
  shape(
    raw,
    ['kind', 'namespace', 'sourceKind', 'providerMessageId', 'from', 'to', 'subject', 'text'],
    [
      'providerThreadId',
      'messageId',
      'inReplyTo',
      'references',
      'cc',
      'bcc',
      'sentAt',
      'receivedAt',
      'originalDateHeader',
      'vacancySourceId',
      'opportunityId',
      'files',
      'missingFiles',
      'attempt',
    ],
  );
  if (!['gmail', 'selected-export'].includes(raw.sourceKind))
    fail(400, 'Unsupported message source');
  const subject = text(raw.subject, 250),
    body = text(raw.text, 20000);
  if (
    subject !== entry.subject ||
    authSubject(subject) ||
    sensitive(subject + '\n' + body) ||
    authenticationUrl(body)
  )
    fail(400, 'Authentication or sensitive content requires manual redaction');
  const from = email(raw.from),
    to = addresses(raw.to),
    cc = addresses(raw.cc ?? []),
    bcc = addresses(raw.bcc ?? []),
    direction =
      from === session.sourceAccount
        ? 'outbound'
        : [...to, ...cc, ...bcc].includes(session.sourceAccount)
          ? 'inbound'
          : null;
  if (!direction) fail(400, 'Message does not belong to the selected source account');
  if (raw.vacancySourceId !== undefined && raw.opportunityId !== undefined)
    fail(400, 'Choose exactly one vacancy link');
  for (const value of [raw.sentAt, raw.receivedAt])
    if (value !== undefined && value !== null) text(value, 100);
  const sent = instant(raw.sentAt),
    received = instant(raw.receivedAt),
    main = direction === 'outbound' ? sent : received;
  const normalizedFiles = normalizeFiles(raw.files ?? []).map((f) => ({
    ...f,
    sha256: digest(Buffer.from(f.base64, 'base64')),
  }));
  if (
    normalizedFiles.some(
      (f) =>
        sensitive(Buffer.from(f.base64, 'base64').toString('utf8')) ||
        authenticationUrl(Buffer.from(f.base64, 'base64').toString('utf8')),
    )
  )
    fail(400, 'Sensitive document content requires manual redaction');
  const missing = raw.missingFiles ?? [];
  if (!Array.isArray(missing) || missing.length > 2 || missing.length + normalizedFiles.length > 2)
    fail(400, 'At most two submitted documents per message');
  const missingFiles = missing.map((f) => {
    shape(f, ['name', 'reason']);
    return { name: text(f.name, 120, true), reason: text(f.reason, 500, true) };
  });
  const references = raw.references ?? [];
  if (!Array.isArray(references) || references.length > 20)
    fail(400, 'Too many message references');
  const p = {
    kind: raw.kind,
    namespace: raw.namespace,
    sourceKind: raw.sourceKind,
    providerMessageId: text(raw.providerMessageId, 254, true),
    providerThreadId: text(raw.providerThreadId ?? '', 254),
    messageId: text(raw.messageId ?? '', 254),
    inReplyTo: text(raw.inReplyTo ?? '', 254),
    references: references.map((v) => text(v, 254)),
    from,
    to,
    cc,
    bcc,
    subject,
    text: body,
    direction,
    sentAt: sent.value,
    receivedAt: received.value,
    timeStatus: main.status,
    sourceDateValue: direction === 'outbound' ? (raw.sentAt ?? null) : (raw.receivedAt ?? null),
    originalDateHeader: text(raw.originalDateHeader ?? '', 500),
    vacancySourceId:
      raw.vacancySourceId === undefined ? null : text(raw.vacancySourceId, 200, true),
    opportunityId: raw.opportunityId === undefined ? null : ids(raw.opportunityId),
    files: normalizedFiles,
    missingFiles,
    attempt: null,
  };
  if (raw.attempt !== undefined) {
    shape(raw.attempt, ['kind', 'channel', 'evidenceMessageId']);
    if (
      raw.attempt.kind !== 'application' ||
      raw.attempt.channel !== 'gmail' ||
      raw.attempt.evidenceMessageId !== p.providerMessageId ||
      direction !== 'outbound' ||
      (!p.vacancySourceId && !p.opportunityId)
    )
      fail(400, 'Application evidence must name this outbound message and a selected vacancy');
    p.attempt = { ...raw.attempt };
  }
  return p;
}
function normalizedDigest(p) {
  const v = structuredClone(p);
  if (v.kind === 'message') {
    for (const k of ['to', 'cc', 'bcc', 'references']) v[k].sort();
    v.files = v.files
      .map(({ id: _id, base64: _base64, ...f }) => f)
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    v.missingFiles.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  return digest({ normalizerVersion: VERSION, payload: v });
}
function matchingVacancy(state, p) {
  return (
    state.opportunities.find(
      (o) =>
        o.importSource?.sourceId === p.sourceId && o.importSource?.namespace === 'ja-permanent',
    ) ??
    (p.postingId && p.employerDomain
      ? state.opportunities.find(
          (o) =>
            o.importSource?.postingId === p.postingId &&
            o.importSource?.employerDomain === p.employerDomain,
        )
      : null) ??
    (p.canonicalUrl
      ? state.opportunities.find((o) => {
          try {
            return publicUrl(o.snapshot?.url) === p.canonicalUrl;
          } catch {
            return false;
          }
        })
      : null)
  );
}
function capacity(state) {
  return {
    opportunities: Math.max(0, 500 - state.opportunities.length),
    messages: Math.max(0, 200 - state.messages.length),
    historicalAttempts: Math.max(0, 500 - (state.historicalAttempts ?? []).length),
    importReceipts: Math.max(0, 1000 - (state.importReceipts ?? []).length),
  };
}
export function createCareerImportManager({ now = Date.now } = {}) {
  const sessions = new Map();
  let closed = false;
  const clock = () => {
    const n = now();
    if (!Number.isSafeInteger(n) || n < 0) fail(503, 'Import clock unavailable');
    return n;
  };
  const remove = (s) => {
    for (const e of s.entries) {
      e.parts = [];
      e.payload = null;
    }
    sessions.delete(s.key);
  };
  const expire = () => {
    if (closed) fail(503, 'Import manager is closed');
    for (const s of sessions.values()) if (s.expiresAt <= clock()) remove(s);
  };
  const key = (owner, batchId) => owner.accountId + '|' + owner.principalId + '|' + batchId;
  function session(owner, body) {
    expire();
    owner = own(owner);
    ids(body.batchId);
    const s = sessions.get(key(owner, body.batchId));
    if (!s || s.generation !== owner.generation) fail(404, 'Import preview expired or unavailable');
    return s;
  }
  function prepare(s, state) {
    if (s.frozen) return;
    for (const e of s.entries) {
      if (e.status === 'rejected' || e.payload) continue;
      if (e.parts.filter(Boolean).length !== e.chunks) {
        e.status = 'missing';
        e.reason = 'Some selected chunks have not been supplied';
        continue;
      }
      try {
        const h = createHash('sha256');
        for (const part of e.parts) h.update(part);
        if (h.digest('hex') !== e.sha256) fail(400, 'Selected item digest mismatch');
        const assembled = Buffer.concat(e.parts, e.bytes);
        let raw;
        try {
          raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(assembled));
        } catch {
          fail(400, 'Import item must contain valid UTF-8 JSON');
        }
        e.payload = normalize(raw, s, e);
        e.sourceKey = sourceKey(s.sourceAccount, e.payload);
        e.sourceDigest = normalizedDigest(e.payload);
        e.status = 'ready';
        e.reason = 'Selected source evidence; review before import';
        e.parts = [];
      } catch (error) {
        e.status = 'rejected';
        e.reason = String(error.message).slice(0, 500);
        e.parts = [];
        e.payload = null;
      }
    }
    if (s.entries.reduce((n, e) => n + (e.payload?.files?.length ?? 0), 0) > 20) {
      for (const e of s.entries)
        if (e.payload?.files?.length) {
          e.status = 'rejected';
          e.reason = 'Preview supports at most twenty files';
          e.payload = null;
          e.parts = [];
        }
    }
    // Freeze only after all incoming chunks are present or explicitly rejected.
    if (s.entries.some((e) => e.status === 'missing')) return;
    const vacancyIds = new Map();
    const proposedVacancies = [];
    for (const e of s.entries.filter((e) => e.payload?.kind === 'vacancy')) {
      const p = e.payload,
        existing = matchingVacancy(state, p);
      const prior =
        proposedVacancies.find((other) => other.payload.sourceId === p.sourceId) ??
        (p.postingId && p.employerDomain
          ? proposedVacancies.find(
              (other) =>
                other.payload.postingId === p.postingId &&
                other.payload.employerDomain === p.employerDomain,
            )
          : null) ??
        (p.canonicalUrl
          ? proposedVacancies.find((other) => other.payload.canonicalUrl === p.canonicalUrl)
          : null);
      e.entityRefs = {
        opportunityId: existing?.id ?? prior?.entityRefs.opportunityId ?? randomUUID(),
      };
      vacancyIds.set(p.sourceId, e.entityRefs.opportunityId);
      proposedVacancies.push(e);
    }
    for (const e of s.entries.filter((e) => e.payload)) {
      const old = (state.importReceipts ?? []).find((r) => r.sourceKey === e.sourceKey);
      if (old) {
        e.entityRefs = structuredClone(old.entityRefs);
        e.status = old.sourceDigest === e.sourceDigest ? 'duplicate' : 'conflict';
        e.reason =
          e.status === 'duplicate'
            ? 'Already imported without changes'
            : 'This source identity has different content';
        continue;
      }
      if (e.payload.kind === 'message') {
        const p = e.payload;
        let opportunityId = p.opportunityId;
        if (opportunityId && !state.opportunities.some((o) => o.id === opportunityId)) {
          e.status = 'rejected';
          e.reason = 'Selected vacancy is unavailable in this account';
          continue;
        }
        if (p.vacancySourceId) {
          opportunityId =
            state.opportunities.find(
              (o) =>
                o.importSource?.namespace === 'ja-permanent' &&
                o.importSource.sourceId === p.vacancySourceId,
            )?.id ??
            (state.importReceipts ?? []).find(
              (r) =>
                r.sourceKey ===
                sourceKey(s.sourceAccount, { kind: 'vacancy', sourceId: p.vacancySourceId }),
            )?.entityRefs?.opportunityId ??
            vacancyIds.get(p.vacancySourceId);
          if (!opportunityId) {
            e.status = 'rejected';
            e.reason = 'Selected parent vacancy has not been supplied';
            continue;
          }
        }
        e.entityRefs = {
          ...(opportunityId ? { opportunityId } : {}),
          messageId: randomUUID(),
          ...(p.attempt ? { historicalAttemptId: randomUUID() } : {}),
        };
      }
    }
    s.baseRevision = state.revision;
    s.profileVersion = state.profile?.version ?? null;
    s.previewHash = digest({
      accountId: s.accountId,
      principalId: s.principalId,
      generation: s.generation,
      batchId: s.batchId,
      sourceAccount: s.sourceAccount,
      baseRevision: s.baseRevision,
      profileVersion: s.profileVersion,
      manifest: s.manifest,
      items: s.entries.map((e) => ({
        itemId: e.itemId,
        status: e.status,
        sourceKey: e.sourceKey ?? null,
        sourceDigest: e.sourceDigest ?? null,
        entityRefs: e.entityRefs ?? {},
      })),
    });
    s.frozen = true;
  }
  function summary(s, state) {
    const receipts = (state.importReceipts ?? []).filter((r) => r.batchId === s.batchId);
    return {
      batchId: s.batchId,
      examined: s.entries.length,
      committed: receipts.filter((r) => r.outcome === 'committed').length,
      excluded: receipts.filter((r) => r.outcome === 'explicitly-excluded').length,
      conflicting: s.entries.filter((e) => e.status === 'conflict').length,
      failed: s.entries.filter((e) => e.lastStatus === 'failed').length,
      rejected: s.entries.filter((e) => e.status === 'rejected').length,
      items: s.entries.map((e) => ({
        itemId: e.itemId,
        status: e.lastStatus ?? e.status,
        reason: e.reason ?? '',
      })),
      pending: s.entries.filter(
        (e) =>
          !receipts.some((r) => r.itemId === e.itemId) &&
          !['duplicate', 'conflict'].includes(e.status),
      ).length,
      receipts: receipts.map((r) => structuredClone(r)),
    };
  }
  const itemView = (e) => ({
    itemId: e.itemId,
    kind: e.kind,
    status: e.status,
    label: (e.payload?.title ?? e.subject ?? 'Selected vacancy').slice(0, 250),
    reason: e.reason ?? '',
    sourceDigest: e.sourceDigest ?? null,
    entityRefs: e.entityRefs ?? {},
    evidence:
      e.payload?.kind === 'message'
        ? {
            direction: e.payload.direction,
            from: e.payload.from,
            recipients: { to: e.payload.to, cc: e.payload.cc, bcc: e.payload.bcc },
            subject: e.payload.subject,
            excerpt: e.payload.text.slice(0, 1000),
            sentAt: e.payload.sentAt,
            receivedAt: e.payload.receivedAt,
            timeStatus: e.payload.timeStatus,
            providerMessageId: e.payload.providerMessageId,
          }
        : e.payload
          ? {
              company: e.payload.company,
              title: e.payload.title,
              url: e.payload.url,
              excerpt: e.payload.description.slice(0, 1000),
            }
          : null,
    files: e.payload?.files?.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })) ?? [],
    missingFiles: e.payload?.missingFiles ?? [],
    ...(e.payload?.attempt
      ? {
          attempt: {
            kind: 'application',
            status: 'source-declared sent evidence; delivery unknown',
          },
        }
      : {}),
  });
  return {
    begin(owner, body, _state) {
      expire();
      owner = own(owner);
      shape(body, ['batchId', 'sourceAccount', 'items']);
      ids(body.batchId);
      if (email(body.sourceAccount) !== owner.email)
        fail(403, 'Select only your verified source account');
      if (
        !Array.isArray(body.items) ||
        !body.items.length ||
        body.items.length > 60 ||
        Buffer.byteLength(canonical(body)) > 256 * 1024
      )
        fail(400, 'Import metadata capacity exceeded');
      const manifest = canonical(body),
        k = key(owner, body.batchId),
        existing = sessions.get(k);
      if (existing) {
        if (existing.generation !== owner.generation || existing.manifest !== manifest)
          fail(409, 'Batch identity already has different metadata');
        return { batchId: existing.batchId, expiresAt: existing.expiresAt };
      }
      if (
        [...sessions.values()].filter((s) => s.accountId === owner.accountId).length >= 2 ||
        sessions.size >= 8
      )
        fail(429, 'Too many active import previews');
      const seen = new Set();
      let bytes = 0,
        chunks = 0,
        vacancies = 0,
        messages = 0;
      const entries = body.items.map((item) => {
        shape(item, ['itemId', 'kind', 'bytes', 'sha256', 'chunks'], ['subject']);
        ids(item.itemId);
        if (seen.has(item.itemId)) fail(400, 'Duplicate selected item');
        seen.add(item.itemId);
        if (
          !['vacancy', 'message'].includes(item.kind) ||
          !Number.isInteger(item.bytes) ||
          item.bytes < 1 ||
          item.bytes > 1024 * 1024 ||
          !HEX.test(item.sha256) ||
          item.chunks !== Math.ceil(item.bytes / CHUNK)
        )
          fail(400, 'Invalid selected item metadata');
        if (item.kind === 'message') {
          messages++;
          text(item.subject, 250);
          if (authSubject(item.subject)) fail(400, 'Authentication source messages are excluded');
        } else vacancies++;
        bytes += item.bytes;
        chunks += item.chunks;
        return {
          ...item,
          parts: [],
          partHashes: [],
          status: item.kind === 'message' && authSubject(item.subject) ? 'rejected' : 'missing',
          reason:
            item.kind === 'message' && authSubject(item.subject)
              ? 'Authentication source messages are excluded'
              : '',
        };
      });
      if (
        vacancies > 10 ||
        messages > 50 ||
        bytes > MAX_BYTES ||
        chunks > 128 ||
        [...sessions.values()].reduce((n, s) => n + s.bytes, 0) + bytes > 48 * 1024 * 1024
      )
        fail(413, 'Import preview capacity exceeded');
      const s = {
        key: k,
        accountId: owner.accountId,
        generation: owner.generation,
        principalId: owner.principalId,
        sourceAccount: owner.email,
        batchId: body.batchId,
        expiresAt: clock() + 1800000,
        manifest,
        bytes,
        entries,
        frozen: false,
        baseRevision: null,
        profileVersion: null,
      };
      sessions.set(k, s);
      return { batchId: s.batchId, expiresAt: s.expiresAt };
    },
    chunk(owner, body, _state) {
      shape(body, ['batchId', 'itemId', 'index', 'data']);
      const s = session(owner, body),
        e = s.entries.find((e) => e.itemId === body.itemId);
      if (!e) fail(404, 'Selected item unavailable');
      if (e.status === 'rejected') fail(400, e.reason);
      if (
        !Number.isInteger(body.index) ||
        body.index < 0 ||
        body.index >= e.chunks ||
        typeof body.data !== 'string' ||
        body.data.length > 65536 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)
      )
        fail(400, 'Invalid import chunk');
      const expected = body.index === e.chunks - 1 ? e.bytes - CHUNK * body.index : CHUNK;
      if (body.data.length !== 4 * Math.ceil(expected / 3))
        fail(400, 'Import chunk length mismatch');
      const part = Buffer.from(body.data, 'base64');
      if (part.length !== expected || part.toString('base64') !== body.data)
        fail(400, 'Import chunk must be canonical base64');
      const h = digest(part);
      if (e.partHashes[body.index]) {
        if (e.partHashes[body.index] !== h) fail(409, 'Chunk identity already has different bytes');
        return { batchId: s.batchId, itemId: e.itemId, received: true, replayed: true };
      }
      if (s.frozen) fail(409, 'Preview is already frozen');
      e.parts[body.index] = part;
      e.partHashes[body.index] = h;
      return { batchId: s.batchId, itemId: e.itemId, received: true };
    },
    preview(owner, body, state) {
      shape(body, ['batchId'], ['offset', 'limit']);
      const s = session(owner, body);
      const offset = body.offset ?? 0,
        limit = body.limit ?? 20;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20
      )
        fail(400, 'Invalid preview page');
      prepare(s, state);
      const result = {
        batchId: s.batchId,
        previewHash: s.previewHash ?? null,
        expiresAt: s.expiresAt,
        items: s.entries.slice(offset, offset + limit).map(itemView),
        total: s.entries.length,
        capacity: capacity(state),
        accountId: s.accountId,
        destination: { accountId: s.accountId, email: s.sourceAccount },
        workspaceRevision: s.baseRevision,
        profileVersion: s.profileVersion,
      };
      if (Buffer.byteLength(canonical(result)) > 96 * 1024)
        fail(413, 'Preview page capacity exceeded');
      return result;
    },
    async commit(owner, body, { getState, mutate, assertActive }) {
      shape(body, ['batchId', 'previewHash', 'itemIds']);
      owner = own(owner);
      const s = session(owner, body);
      const checkStaging = () => {
        if (sessions.get(s.key) !== s || s.expiresAt <= clock()) {
          if (sessions.get(s.key) === s) remove(s);
          fail(410, 'Import preview expired or was cancelled');
        }
      };
      if (!s.frozen || body.previewHash !== s.previewHash)
        fail(409, 'Preview changed or is incomplete');
      if (
        !Array.isArray(body.itemIds) ||
        body.itemIds.length > 60 ||
        new Set(body.itemIds).size !== body.itemIds.length ||
        body.itemIds.some((id) => !UUID.test(id) || !s.entries.some((e) => e.itemId === id))
      )
        fail(400, 'Invalid selected import items');
      const selected = body.itemIds.map((id) => s.entries.find((e) => e.itemId === id)),
        results = new Map();
      if (s.inflight) fail(409, 'An import commit is already running for this preview');
      s.inflight = true;
      let stopped = false,
        interruption = null;
      try {
        for (const e of [...selected].sort(
          (a, b) => (a.kind === 'vacancy' ? 0 : 1) - (b.kind === 'vacancy' ? 0 : 1),
        )) {
          await yieldToLoop();
          if (stopped && interruption) {
            results.set(e.itemId, { itemId: e.itemId, status: 'failed', reason: interruption });
            e.lastStatus = 'failed';
            continue;
          }
          try {
            assertActive();
            checkStaging();
          } catch (error) {
            if (!results.size) throw error;
            stopped = true;
            interruption = String(error.message).slice(0, 500);
            results.set(e.itemId, { itemId: e.itemId, status: 'failed', reason: interruption });
            e.lastStatus = 'failed';
            continue;
          }
          const state = getState(),
            existing = (state.importReceipts ?? []).find((r) => r.sourceKey === e.sourceKey);
          if (existing) {
            results.set(e.itemId, {
              itemId: e.itemId,
              status: existing.sourceDigest === e.sourceDigest ? 'duplicate' : 'conflict',
              entityRefs: existing.entityRefs,
            });
            continue;
          }
          if (
            stopped ||
            state.revision !== s.baseRevision ||
            (state.profile?.version ?? null) !== s.profileVersion
          ) {
            if (!results.size) fail(409, 'Workspace changed; create a fresh import preview');
            results.set(e.itemId, {
              itemId: e.itemId,
              status: 'failed',
              reason: 'Workspace changed; remaining items were not imported',
            });
            stopped = true;
            continue;
          }
          if (e.status !== 'ready') {
            results.set(e.itemId, {
              itemId: e.itemId,
              status: e.status === 'conflict' ? 'conflict' : 'failed',
              reason: e.reason,
            });
            continue;
          }
          try {
            assertActive();
            checkStaging();
            const at = new Date(clock()).toISOString(),
              refs = e.entityRefs,
              p = e.payload,
              receiptActor = actor(owner);
            mutate(
              (next) => {
                next.importReceipts ??= [];
                next.historicalAttempts ??= [];
                if (next.importReceipts.length >= 1000)
                  fail(507, 'Import receipt capacity reached');
                if (p.kind === 'vacancy') {
                  const found = matchingVacancy(next, p);
                  if (found) {
                    if (found.id !== refs.opportunityId) fail(409, 'Vacancy relationship changed');
                  } else {
                    if (next.opportunities.length >= 500)
                      fail(507, 'Saved vacancy capacity reached');
                    const snapshot = {
                      id: randomUUID(),
                      company: p.company,
                      title: p.title,
                      url: p.url,
                      text: p.description,
                      countries: [],
                      workMode: 'unknown',
                      salary: null,
                      requirements: [],
                      source: {
                        authority: 'user-supplied unverified',
                        url: p.url,
                        linkedFrom: p.url,
                        checkedAt: p.observedAt,
                        status: 'imported-unverified',
                      },
                      assessment: null,
                      profileVersion: s.profileVersion,
                    };
                    next.opportunities.push({
                      id: refs.opportunityId,
                      identity: digest({ namespace: 'ja-permanent', sourceId: p.sourceId }),
                      firstSavedAt: at,
                      latestObservedAt: p.observedAt,
                      runMode: 'import',
                      snapshot,
                      stage: 'saved',
                      note: '',
                      nextAction: '',
                      dueDate: '',
                      decisionRevision: 0,
                      updatedAt: at,
                      events: [{ at, stage: 'saved', origin: 'career-import' }],
                      importSource: {
                        namespace: 'ja-permanent',
                        sourceId: p.sourceId,
                        postingId: p.postingId,
                        employerDomain: p.employerDomain,
                        canonicalUrl: p.canonicalUrl,
                        originalUrl: p.url,
                      },
                    });
                  }
                } else {
                  if (
                    refs.opportunityId &&
                    !next.opportunities.some((o) => o.id === refs.opportunityId)
                  )
                    fail(409, 'Selected parent vacancy was not committed');
                  if (next.messages.length >= 200) fail(507, 'Message capacity reached');
                  if (p.attempt && next.historicalAttempts.length >= 500)
                    fail(507, 'Historical attempt capacity reached');
                  const attachmentRefs = [
                    ...p.files.map((f) => ({
                      fileId: f.id,
                      name: f.name,
                      sha256: f.sha256,
                      unavailable: false,
                    })),
                    ...p.missingFiles.map((f) => ({
                      name: f.name,
                      reason: f.reason,
                      unavailable: true,
                    })),
                  ];
                  next.messages.push({
                    id: refs.messageId,
                    origin: 'gmail-import',
                    transportId: p.providerMessageId,
                    sourceKind: p.sourceKind,
                    sourceAccount: s.sourceAccount,
                    providerMessageId: p.providerMessageId,
                    providerThreadId: p.providerThreadId,
                    messageId: p.messageId,
                    inReplyTo: p.inReplyTo,
                    references: p.references,
                    from: p.from,
                    to: p.to[0] ?? p.cc[0] ?? p.bcc[0] ?? '',
                    originalRecipients: { to: p.to, cc: p.cc, bcc: p.bcc },
                    subject: p.subject,
                    text: p.text,
                    files: p.files,
                    attachmentRefs,
                    receivedAt: p.receivedAt,
                    sentAt: p.sentAt,
                    timeStatus: p.timeStatus,
                    originalSourceTime: p.sourceDateValue,
                    originalDateHeader: p.originalDateHeader,
                    importedAt: at,
                    direction: p.direction,
                    revision: 0,
                    opportunityId: refs.opportunityId ?? null,
                    sourceKey: e.sourceKey,
                    sourceDigest: e.sourceDigest,
                    normalizerVersion: VERSION,
                    analysis: {
                      ...analyzeMail(p.text),
                      action: null,
                      proposedStage: null,
                      method: 'Historical imported evidence — review only',
                    },
                    task: { done: false, revision: 0 },
                  });
                  if (p.attempt)
                    next.historicalAttempts.push({
                      id: refs.historicalAttemptId,
                      source: 'import',
                      opportunityId: refs.opportunityId,
                      messageId: refs.messageId,
                      channel: 'gmail',
                      sender: p.from,
                      sourceSentAt: p.sentAt,
                      importedAt: at,
                      evidenceMessageId: p.providerMessageId,
                      submittedDocumentRefs: attachmentRefs,
                      sourceKey: e.sourceKey,
                      sourceDigest: e.sourceDigest,
                    });
                }
                const first = !next.importReceipts.some(
                  (r) => r.batchId === s.batchId && r.outcome === 'committed',
                );
                next.importReceipts.push({
                  batchId: s.batchId,
                  itemId: e.itemId,
                  sourceKey: e.sourceKey,
                  sourceDigest: e.sourceDigest,
                  normalizerVersion: VERSION,
                  outcome: 'committed',
                  entityRefs: refs,
                  importedAt: at,
                  actor: receiptActor,
                });
                if (first) {
                  if (next.notifications.length >= 500) fail(507, 'Notification capacity reached');
                  next.notifications.push({
                    id: randomUUID(),
                    type: 'career-import',
                    kind: 'career-import',
                    title: 'Imported items are available; review batch progress',
                    text: 'Imported items are available; review batch progress',
                    at,
                    createdAt: at,
                    read: false,
                    revision: 0,
                    batchId: s.batchId,
                    url: '/imports?batchId=' + s.batchId,
                  });
                }
              },
              {
                careerImport: {
                  batchId: s.batchId,
                  itemId: e.itemId,
                  sourceKey: e.sourceKey,
                  sourceDigest: e.sourceDigest,
                  entityRefs: refs,
                  actor: receiptActor,
                },
              },
            );
            s.baseRevision = getState().revision;
            results.set(e.itemId, { itemId: e.itemId, status: 'committed', entityRefs: refs });
            e.lastStatus = 'committed';
          } catch (error) {
            e.lastStatus = 'failed';
            results.set(e.itemId, {
              itemId: e.itemId,
              status: 'failed',
              reason: String(error.message).slice(0, 500),
            });
            if (error.status === 401 || error.status === 403 || error.status === 409)
              stopped = true;
          }
        }
        return { ...summary(s, getState()), items: body.itemIds.map((id) => results.get(id)) };
      } finally {
        s.inflight = false;
      }
    },
    progress(owner, body, state) {
      shape(body, ['batchId']);
      expire();
      owner = own(owner);
      ids(body.batchId);
      const s = sessions.get(key(owner, body.batchId));
      if (s && s.generation === owner.generation) return summary(s, state);
      const receipts = (state.importReceipts ?? []).filter((r) => r.batchId === body.batchId);
      if (!receipts.length) fail(404, 'Import progress unavailable');
      return {
        batchId: body.batchId,
        committed: receipts.filter((r) => r.outcome === 'committed').length,
        excluded: receipts.filter((r) => r.outcome === 'explicitly-excluded').length,
        pending: null,
        status: 'staging-unavailable',
        receipts: structuredClone(receipts),
      };
    },
    cancel(owner, body) {
      shape(body, ['batchId']);
      const s = session(owner, body);
      remove(s);
      return { batchId: body.batchId, cancelled: true };
    },
    invalidate(accountId, principalId) {
      for (const s of sessions.values())
        if (
          s.accountId === accountId &&
          (principalId === undefined || s.principalId === principalId)
        )
          remove(s);
    },
    close() {
      for (const s of sessions.values()) remove(s);
      closed = true;
    },
  };
}
export function validateCareerImportState(state) {
  for (const key of ['importReceipts', 'historicalAttempts'])
    if (
      state[key] !== undefined &&
      (!Array.isArray(state[key]) || state[key].length > (key === 'importReceipts' ? 1000 : 500))
    )
      fail(503, 'Invalid imported history capacity');
  const receipts = state.importReceipts ?? [],
    messages = state.messages ?? [],
    attempts = state.historicalAttempts ?? [],
    opportunities = state.opportunities ?? [];
  const receiptKeys = new Set();
  for (const r of receipts) {
    if (receiptKeys.has(r.sourceKey)) fail(503, 'Duplicate import receipt source identity');
    receiptKeys.add(r.sourceKey);
    shape(r, [
      'batchId',
      'itemId',
      'sourceKey',
      'sourceDigest',
      'normalizerVersion',
      'outcome',
      'entityRefs',
      'importedAt',
      'actor',
    ]);
    ids(r.batchId);
    ids(r.itemId);
    if (
      !HEX.test(r.sourceKey) ||
      !HEX.test(r.sourceDigest) ||
      r.normalizerVersion !== VERSION ||
      !['committed', 'explicitly-excluded'].includes(r.outcome) ||
      instant(r.importedAt).status !== 'verified'
    )
      fail(503, 'Invalid import receipt');
    shape(r.entityRefs, [], ['opportunityId', 'messageId', 'historicalAttemptId']);
    for (const id of Object.values(r.entityRefs)) ids(id);
    shape(r.actor, ['type', 'id', 'role'], ['grantId']);
    if (!['user', 'agent'].includes(r.actor.type) || r.actor.role !== 'career-import')
      fail(503, 'Invalid importing actor');
    ids(r.actor.id);
    if (r.actor.grantId) ids(r.actor.grantId);
    if (r.actor.type === 'agent' ? r.actor.grantId !== r.actor.id : r.actor.grantId !== undefined)
      fail(503, 'Import actor binding mismatch');
    if (
      (r.entityRefs.opportunityId &&
        !opportunities.some((o) => o.id === r.entityRefs.opportunityId)) ||
      (r.entityRefs.messageId && !messages.some((m) => m.id === r.entityRefs.messageId)) ||
      (r.entityRefs.historicalAttemptId &&
        !attempts.some((a) => a.id === r.entityRefs.historicalAttemptId))
    )
      fail(503, 'Orphan import receipt');
  }
  for (const m of messages.filter((m) => m.origin === 'gmail-import')) {
    shape(m, [
      'id',
      'origin',
      'transportId',
      'sourceKind',
      'sourceAccount',
      'providerMessageId',
      'providerThreadId',
      'messageId',
      'inReplyTo',
      'references',
      'from',
      'to',
      'originalRecipients',
      'subject',
      'text',
      'files',
      'attachmentRefs',
      'receivedAt',
      'sentAt',
      'timeStatus',
      'originalSourceTime',
      'originalDateHeader',
      'importedAt',
      'direction',
      'revision',
      'opportunityId',
      'sourceKey',
      'sourceDigest',
      'normalizerVersion',
      'analysis',
      'task',
    ]);
    shape(m.originalRecipients, ['to', 'cc', 'bcc']);
    if (
      !['gmail', 'selected-export'].includes(m.sourceKind) ||
      m.transportId !== m.providerMessageId ||
      m.revision !== 0 ||
      m.analysis?.action !== null ||
      m.analysis?.proposedStage !== null ||
      m.task?.done !== false ||
      m.task?.revision !== 0
    )
      fail(503, 'Invalid historical message controls');
    const sourceAccount = email(m.sourceAccount);
    if (
      m.direction === 'outbound'
        ? m.from !== sourceAccount
        : ![
            ...m.originalRecipients.to,
            ...m.originalRecipients.cc,
            ...m.originalRecipients.bcc,
          ].includes(sourceAccount)
    )
      fail(503, 'Historical message account mismatch');
    if (
      m.to !==
      (m.originalRecipients.to[0] ??
        m.originalRecipients.cc[0] ??
        m.originalRecipients.bcc[0] ??
        '')
    )
      fail(503, 'Historical recipient display mismatch');
    for (const value of [m.sentAt, m.receivedAt])
      if (value !== null && instant(value).status !== 'verified')
        fail(503, 'Invalid historical source time');
    if (!Array.isArray(m.references) || m.references.length > 20)
      fail(503, 'Invalid historical references');
    m.references.forEach((value) => text(value, 254));
    text(m.providerMessageId, 254, true);
    text(m.providerThreadId, 254);
    text(m.messageId, 254);
    text(m.inReplyTo, 254);
    text(m.originalDateHeader, 500);
    if (m.originalSourceTime !== null) text(m.originalSourceTime, 100);
    normalizeFiles(m.files);
    if (!Array.isArray(m.attachmentRefs) || m.attachmentRefs.length > 2)
      fail(503, 'Invalid historical document references');
    for (const ref of m.attachmentRefs) {
      if (ref.unavailable === true) {
        shape(ref, ['name', 'reason', 'unavailable']);
        text(ref.name, 120, true);
        text(ref.reason, 500, true);
      } else {
        shape(ref, ['fileId', 'name', 'sha256', 'unavailable']);
        if (
          ref.unavailable !== false ||
          !m.files.some(
            (f) => f.id === ref.fileId && f.name === ref.name && f.sha256 === ref.sha256,
          )
        )
          fail(503, 'Historical document reference mismatch');
      }
    }
    if (m.files.some((f) => !m.attachmentRefs.some((ref) => ref.fileId === f.id)))
      fail(503, 'Historical document has no evidence reference');
    if (
      !UUID.test(m.id) ||
      !HEX.test(m.sourceKey) ||
      !HEX.test(m.sourceDigest) ||
      m.normalizerVersion !== VERSION ||
      !['inbound', 'outbound'].includes(m.direction) ||
      !['verified', 'unknown', 'invalid'].includes(m.timeStatus) ||
      instant(m.importedAt).status !== 'verified' ||
      !m.originalRecipients ||
      !Array.isArray(m.files) ||
      m.files.length > 2
    )
      fail(503, 'Invalid historical message');
    email(m.from);
    addresses(m.originalRecipients.to);
    addresses(m.originalRecipients.cc);
    addresses(m.originalRecipients.bcc);
    text(m.subject, 250);
    text(m.text, 20000);
    for (const f of m.files) {
      if (!HEX.test(f.sha256) || digest(Buffer.from(f.base64, 'base64')) !== f.sha256)
        fail(503, 'Historical document hash mismatch');
    }
    if (m.opportunityId && !opportunities.some((o) => o.id === m.opportunityId))
      fail(503, 'Orphan historical message');
  }
  for (const a of attempts) {
    shape(a, [
      'id',
      'source',
      'opportunityId',
      'messageId',
      'channel',
      'sender',
      'sourceSentAt',
      'importedAt',
      'evidenceMessageId',
      'submittedDocumentRefs',
      'sourceKey',
      'sourceDigest',
    ]);
    ids(a.id);
    if (
      a.source !== 'import' ||
      a.channel !== 'gmail' ||
      !HEX.test(a.sourceKey) ||
      !HEX.test(a.sourceDigest) ||
      !opportunities.some((o) => o.id === a.opportunityId)
    )
      fail(503, 'Invalid historical attempt');
    const m = messages.find(
      (m) =>
        m.id === a.messageId &&
        m.origin === 'gmail-import' &&
        m.direction === 'outbound' &&
        m.opportunityId === a.opportunityId,
    );
    if (
      !m ||
      a.sender !== m.from ||
      a.sourceSentAt !== m.sentAt ||
      a.importedAt !== m.importedAt ||
      a.sourceKey !== m.sourceKey ||
      a.sourceDigest !== m.sourceDigest ||
      m.providerMessageId !== a.evidenceMessageId ||
      canonical(m.attachmentRefs) !== canonical(a.submittedDocumentRefs)
    )
      fail(503, 'Historical attempt evidence mismatch');
  }
}
