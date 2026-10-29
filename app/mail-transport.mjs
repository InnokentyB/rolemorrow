// Pure state transitions. Callers persist mutations atomically before network I/O.
// receiveResend/deliveryEvent are trusted adapter entry points, never public intake.
import { hash, id } from './domain.mjs';
import { MailError, files, analyzeMail } from './mail.mjs';
const fail = (status, message) => {
  throw new MailError(status, message);
};
const bounded = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max || !value.trim())
    fail(400, `Check ${label}.`);
  return value.trim();
};
const address = (value) => {
  const v = bounded(value, 254, 'email address');
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v))
    fail(400, 'Enter a plain email address.');
  return v.toLowerCase();
};
const header = (value, max, label) => {
  const v = bounded(value, max, label);
  if (/[\r\n\x00]/.test(v)) fail(400, `Invalid ${label}.`);
  return v;
};
const messageHeader = (value) => {
  const v = header(value, 998, 'message ID');
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(v)) fail(400, 'Invalid message ID.');
  return v;
};
const revision = (actual, expected) => {
  if (!Number.isInteger(actual) || actual < 0) fail(400, 'Current revision required.');
  if (actual !== expected) fail(409, 'Saved content changed. Reload before confirming.');
};
const timestamp = (now) => {
  const v = now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(v))) fail(400, 'Invalid operation timestamp.');
  return new Date(v).toISOString();
};
const domain = (value) => {
  const v = bounded(value, 253, 'reply domain').toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(v))
    fail(400, 'Invalid reply domain.');
  return v;
};
const aliasPrefix = (value) => {
  const v = value ?? '';
  if (typeof v !== 'string' || (v !== '' && !/^[a-f0-9]{12}-$/.test(v)))
    fail(400, 'Invalid mailbox alias prefix.');
  return v;
};
export function nativeMailAlias(opportunityId, { replyDomain, aliasPrefix: prefix } = {}) {
  if (typeof opportunityId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(opportunityId))
    fail(400, 'Invalid saved job identity.');
  return `op-${aliasPrefix(prefix)}${opportunityId}@${domain(replyDomain)}`;
}
const dispatch = (s, key) =>
  s.mailDispatches?.find((d) => d.id === key) ?? fail(404, 'Dispatch not found.');
const opportunity = (s, key) => {
  const o = s.opportunities.find((o) => o.id === key) ?? fail(404, 'Saved job not found.');
  if (o.runMode === 'fixture') fail(400, 'Test opportunities cannot send real email.');
  return o;
};
const limit = (list, max, label) => {
  if ((list?.length ?? 0) >= max) fail(400, `${label} storage limit reached.`);
};
export function prepareDispatch(state, input, config) {
  if (input.confirm !== true) fail(400, 'Explicit send confirmation is required.');
  const now = timestamp(config.now),
    sender = address(config.sender),
    replyDomain = domain(config.replyDomain),
    prefix = aliasPrefix(config.aliasPrefix);
  let o,
    snapshot,
    to,
    subject,
    body,
    messageId = null,
    packetRevision = null,
    replyRevision = null,
    parentId = null;
  if (input.kind === 'application') {
    o = opportunity(state, input.opportunityId);
    const packet =
      state.applications.find((a) => a.opportunityId === o.id) ??
      fail(400, 'Save an application packet first.');
    revision(input.packetRevision, packet.revision);
    packetRevision = packet.revision;
    snapshot = structuredClone(packet);
    delete snapshot.history;
    if (!packet.cvText?.trim() && !packet.files?.length) fail(400, 'Application packet has no CV.');
    to = address(input.to ?? input.recipient);
    subject = header(input.subject ?? 'Job application', 250, 'subject');
    body = bounded(
      input.body ?? 'Please consider my application. Saved materials follow.',
      40000,
      'application body',
    );
    if (
      body.length +
        [packet.cvText, packet.coverLetter, packet.answers]
          .filter(Boolean)
          .reduce((sum, value) => sum + value.length, 0) +
        100 >
      80000
    )
      fail(400, 'Combined application message is too long.');
  } else if (input.kind === 'reply') {
    const m =
      state.messages.find((m) => m.id === input.messageId) ?? fail(404, 'Message not found.');
    if (m.origin === 'gmail-import')
      fail(400, 'Historical Gmail evidence is read-only. Reply in the source mailbox.');
    if (m.origin !== 'resend' || !m.opportunityId)
      fail(400, 'Only verified linked correspondence can receive live replies.');
    o = opportunity(state, m.opportunityId);
    const draft =
      state.replyDrafts.find((d) => d.messageId === m.id) ?? fail(400, 'Save a reply draft first.');
    revision(input.replyRevision, draft.revision);
    if (draft.opportunityId && draft.opportunityId !== o.id)
      fail(409, 'Reply association changed.');
    to = address(m.from);
    subject = header(/^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, 250, 'subject');
    body = bounded(draft.body, 10000, 'reply body');
    replyRevision = draft.revision;
    messageId = m.id;
    parentId = m.messageId ? messageHeader(m.messageId) : null;
    snapshot = { ...structuredClone(draft), files: [] };
  } else fail(400, 'Choose application or reply.');
  revision(input.decisionRevision, o.decisionRevision);
  const replyTo = nativeMailAlias(o.id, { replyDomain, aliasPrefix: prefix });
  const fingerprint = hash({
    kind: input.kind,
    opportunityId: o.id,
    messageId,
    packetRevision,
    replyRevision,
    snapshot,
    to,
    subject,
    body,
    sender,
    replyDomain,
    ...(prefix ? { aliasPrefix: prefix } : {}),
  });
  const previous = state.mailDispatches?.find((d) => d.fingerprint === fingerprint);
  if (previous) return previous;
  const unresolved = state.mailDispatches?.some(
    (d) =>
      ['sending', 'unknown'].includes(d.status) &&
      d.kind === input.kind &&
      (input.kind === 'application' ? d.opportunityId === o.id : d.messageId === messageId),
  );
  if (unresolved)
    fail(
      409,
      'Resolve the previous send before preparing different content. Retry its saved snapshot or reconcile provider delivery.',
    );
  limit(state.mailDispatches, 200, 'Dispatch');
  const replyToHeader = `Rolemorrow <${replyTo}>`;
  const d = {
    id: id(),
    kind: input.kind,
    opportunityId: o.id,
    messageId,
    packetRevision,
    replyRevision,
    to,
    subject,
    body,
    sender,
    replyTo,
    replyToHeader,
    parentId,
    snapshot,
    fingerprint,
    idempotencyKey: `rolemorrow-${fingerprint}`,
    status: 'prepared',
    revision: 0,
    createdAt: now,
    updatedAt: now,
    firstAttemptAt: null,
    attempts: 0,
    providerId: null,
    lastError: null,
  };
  (state.mailDispatches ??= []).push(d);
  return d;
}
export function claimDispatch(state, key, { now } = {}) {
  const d = dispatch(state, key),
    at = timestamp(now);
  if (!['prepared', 'unknown', 'failed'].includes(d.status))
    fail(409, 'Dispatch cannot be sent in its current state.');
  if (
    d.firstAttemptAt &&
    (Date.parse(at) - Date.parse(d.firstAttemptAt) < 0 ||
      Date.parse(at) - Date.parse(d.firstAttemptAt) >= 24 * 60 * 60 * 1000)
  )
    fail(409, 'Provider idempotency window expired. Reconcile delivery before sending again.');
  if (d.attempts >= 10) fail(409, 'Dispatch attempt limit reached. Reconcile provider status.');
  const packetText =
    d.kind === 'application'
      ? [
          ['Saved CV', d.snapshot.cvText],
          ['Cover letter', d.snapshot.coverLetter],
          ['Screening answers', d.snapshot.answers],
        ]
          .filter(([, value]) => value?.trim())
          .map(([label, value]) => `${label}\n${value}`)
          .join('\n\n')
      : '';
  const payload = {
    from: d.sender,
    to: [d.to],
    subject: d.subject,
    text: [d.body, packetText].filter(Boolean).join('\n\n'),
    reply_to: d.replyToHeader ?? d.replyTo,
    headers: { 'X-Rolemorrow-Dispatch': d.id },
    attachments: (d.snapshot.files ?? []).map((f) => ({
      filename: f.name,
      content: f.base64,
      content_type: f.type,
    })),
  };
  if (d.parentId) payload.headers['In-Reply-To'] = d.parentId;
  d.status = 'sending';
  d.firstAttemptAt ??= at;
  d.updatedAt = at;
  d.attempts++;
  d.revision++;
  d.lastError = null;
  return { idempotencyKey: d.idempotencyKey, payload };
}
const applyDelivery = (d, type) => {
  if (type === 'bounced') d.status = 'bounced';
  else if (type === 'delivered' && d.status !== 'bounced') d.status = 'delivered';
  else if (type === 'failed' && !['bounced', 'delivered'].includes(d.status)) d.status = 'failed';
};
export function settleDispatch(state, key, outcome, { now } = {}) {
  const d = dispatch(state, key),
    at = timestamp(now);
  if (!['accepted', 'unknown', 'failed'].includes(outcome.status))
    fail(400, 'Invalid dispatch outcome.');
  const providerId =
    outcome.status === 'accepted' ? bounded(outcome.providerId, 254, 'provider ID') : null;
  const providerMessageId = outcome.messageId ? messageHeader(outcome.messageId) : null;
  if (
    providerId &&
    state.mailDispatches.some((other) => other.id !== d.id && other.providerId === providerId)
  )
    fail(409, 'Provider identity belongs to another dispatch.');
  if (providerId && d.providerId && d.providerId !== providerId)
    fail(409, 'Provider identity changed.');
  if (!['sending', 'accepted', 'delivered', 'bounced'].includes(d.status))
    fail(409, 'Dispatch was not claimed.');
  if (['accepted', 'delivered', 'bounced'].includes(d.status) && outcome.status !== 'accepted')
    return d;
  if (providerId) d.providerId = providerId;
  if (providerMessageId) d.providerMessageId = providerMessageId;
  if (!['delivered', 'bounced'].includes(d.status)) d.status = outcome.status;
  d.lastError = outcome.status === 'accepted' ? null : 'Provider outcome requires review.';
  d.updatedAt = at;
  d.revision++;
  for (const event of state.mailEvents ?? [])
    if (d.providerId && event.providerId === d.providerId) applyDelivery(d, event.type);
  return d;
}
export function deliveryEvent(state, event, { now } = {}) {
  const at = timestamp(now),
    eventId = bounded(event.id, 254, 'event ID'),
    providerId = bounded(event.providerId, 254, 'provider ID');
  if (!['delivered', 'bounced', 'failed'].includes(event.type))
    fail(400, 'Unsupported delivery event.');
  const payloadHash = hash({ providerId, type: event.type });
  const duplicate = state.mailEvents?.find((e) => e.id === eventId);
  if (duplicate) {
    if (duplicate.payloadHash !== payloadHash)
      fail(409, 'Event identity reused with different content.');
    return duplicate;
  }
  limit(state.mailEvents, 1000, 'Mail event');
  const entry = { id: eventId, providerId, type: event.type, payloadHash, receivedAt: at };
  (state.mailEvents ??= []).push(entry);
  const d = state.mailDispatches?.find((d) => d.providerId === providerId);
  if (d) {
    applyDelivery(d, event.type);
    d.updatedAt = at;
    d.revision++;
  }
  return entry;
}
export function receiveResend(state, input, config) {
  const now = timestamp(config.now),
    replyDomain = domain(config.replyDomain),
    prefix = aliasPrefix(config.aliasPrefix),
    transportId = bounded(input.providerId ?? input.transportId, 254, 'transport ID');
  const to = (Array.isArray(input.to) ? input.to : [input.to]).map(address);
  if (!to.length || to.length > 20) fail(400, 'Invalid recipient count.');
  const htmlOnly = !input.text?.trim() && typeof input.html === 'string' && input.html.trim();
  const body = htmlOnly
    ? 'HTML-only message (unrendered source):\n' + input.html.slice(0, 19800)
    : input.text;
  const attachments = (input.attachments ?? []).map((a) => ({
    id: header(a.id, 254, 'attachment ID'),
    name: bounded(a.name, 255, 'attachment filename'),
    type: header(a.type, 150, 'attachment type'),
    size:
      Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : fail(400, 'Invalid attachment size.'),
    downloaded: false,
  }));
  if (attachments.length > 100) fail(400, 'Too many inbound attachments.');
  const normalized = {
    from: address(input.from),
    to,
    subject:
      typeof input.subject === 'string' && input.subject.length <= 250
        ? input.subject.trim()
        : fail(400, 'Invalid subject.'),
    text: bounded(body, 20000, 'message'),
    inReplyTo: input.inReplyTo ? messageHeader(input.inReplyTo) : '',
    messageId: input.messageId ? messageHeader(input.messageId) : null,
    files: files(input.files ?? []),
    attachments,
    htmlOnly: !!htmlOnly,
    textSource: htmlOnly
      ? 'html-source'
      : input.textSource === 'html-extracted'
        ? 'html-extracted'
        : 'plain-text',
    textTruncated: input.textTruncated === true || (!!htmlOnly && input.html.length > 19800),
    contentTruncated: input.textTruncated === true || (!!htmlOnly && input.html.length > 19800),
  };
  const payloadHash = hash(normalized),
    duplicate = state.messages.find((m) => m.origin === 'resend' && m.transportId === transportId);
  if (duplicate) {
    if (duplicate.payloadHash !== payloadHash)
      fail(409, 'Message identity reused with different content.');
    return duplicate;
  }
  limit(state.messages, 200, 'Message');
  limit(state.notifications, 400, 'Notification');
  const realOpportunities = state.opportunities.filter((o) => o.runMode !== 'fixture');
  const ownAliases = new Set(
    realOpportunities.map((o) => nativeMailAlias(o.id, { replyDomain, aliasPrefix: prefix })),
  );
  const foreignAlias = to.some(
    (recipient) =>
      recipient.startsWith('op-') &&
      recipient.endsWith('@' + replyDomain) &&
      !ownAliases.has(recipient),
  );
  const aliasTargets = realOpportunities
    .filter((o) => to.includes(nativeMailAlias(o.id, { replyDomain, aliasPrefix: prefix })))
    .map((o) => o.id);
  const threadTargets = [
    ...(state.mailDispatches ?? [])
      .filter((d) => normalized.inReplyTo && d.providerMessageId === normalized.inReplyTo)
      .map((d) => d.opportunityId),
    ...state.messages
      .filter(
        (m) =>
          m.origin === 'resend' &&
          m.messageId &&
          m.messageId === normalized.inReplyTo &&
          m.opportunityId,
      )
      .map((m) => m.opportunityId),
  ];
  const targets = new Set(
    [...aliasTargets, ...threadTargets].filter((key) =>
      realOpportunities.some((o) => o.id === key),
    ),
  );
  const m = {
    ...normalized,
    to: to.join(', '),
    recipients: to,
    id: id(),
    origin: 'resend',
    transportId,
    providerId: input.providerId ?? transportId,
    payloadHash,
    opportunityId: !foreignAlias && targets.size === 1 ? [...targets][0] : null,
    receivedAt: now,
    direction: 'inbound',
    revision: 0,
    analysis: analyzeMail(normalized.text),
    task: { done: false, revision: 0 },
  };
  state.messages.push(m);
  (state.notifications ??= []).push({
    id: id(),
    messageId: m.id,
    opportunityId: m.opportunityId,
    kind: 'mail-received',
    read: false,
    revision: 0,
    createdAt: now,
  });
  return m;
}
export function markNotification(state, key, input, { now } = {}) {
  const n = state.notifications?.find((n) => n.id === key) ?? fail(404, 'Notification not found.');
  revision(input.revision, n.revision);
  if (typeof input.read !== 'boolean') fail(400, 'Notification read state required.');
  const at = timestamp(now);
  n.read = input.read;
  n.readAt = input.read ? at : null;
  n.revision++;
  return n;
}
export function publicDispatch(d) {
  return {
    id: d.id,
    kind: d.kind,
    opportunityId: d.opportunityId,
    messageId: d.messageId,
    to: d.to,
    subject: d.subject,
    body: d.body,
    status: d.status,
    revision: d.revision,
    packetRevision: d.packetRevision,
    replyRevision: d.replyRevision,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    providerId: d.providerId,
    replyTo: d.replyTo,
    attempts: d.attempts,
    lastError: d.lastError,
  };
}
