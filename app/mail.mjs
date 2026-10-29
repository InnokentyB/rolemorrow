import { hash, id } from './domain.mjs';
export class MailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, text) => {
  throw new MailError(status, text);
};
const text = (value, max, name) => {
  if (typeof value !== 'string' || value.length > max)
    fail(400, `Check ${name} (maximum ${max} characters).`);
  return value.trim();
};
const email = (value) => {
  const s = text(value, 254, 'email');
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s))
    fail(400, 'Enter a plain email address.');
  return s.toLowerCase();
};
const rev = (actual, expected) => {
  if (!Number.isInteger(actual) || actual < 0)
    fail(400, 'A saved revision is required. Reload before editing.');
  if (actual !== expected)
    fail(409, 'Another window changed this item. Your draft is kept; reload before saving again.');
};
export const testAlias = (o) => `op-${o.id}@apply.example.com`;
export function files(input) {
  if (!Array.isArray(input) || input.length > 2) fail(400, 'Attach at most two PDF or text files.');
  return input.map((f) => {
    const name = text(f.name, 120, 'filename');
    if (!/^[A-Za-z0-9 _().-]+$/.test(name) || name.includes('..'))
      fail(400, 'Use a simple filename without paths.');
    if (
      !['application/pdf', 'text/plain'].includes(f.type) ||
      typeof f.base64 !== 'string' ||
      f.base64.length > 350000
    )
      fail(400, 'Only PDF/text files up to 256 KiB each are supported.');
    const data = Buffer.from(f.base64, 'base64');
    if (!data.length || data.length > 262144 || data.toString('base64') !== f.base64)
      fail(400, 'Invalid attachment content.');
    if (f.type === 'application/pdf' && data.subarray(0, 5).toString() !== '%PDF-')
      fail(400, 'PDF signature is missing.');
    if (f.type === 'text/plain') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        fail(400, 'Text attachment must be UTF-8.');
      }
    }
    return {
      id: hash({ name, base64: f.base64 }).slice(0, 24),
      name,
      type: f.type,
      size: data.length,
      base64: f.base64,
    };
  });
}
export function analyzeMail(body) {
  const cues = [
    [
      'interview',
      /inv(?:ite|itation)[^.\n]{0,100}interview|interview[^.\n]{0,60}(?:schedule|availability)/i,
    ],
    [
      'rejection',
      /not (?:be )?moving forward|unfortunately[^.\n]{0,120}(?:proceed|selected|application)|regret to inform/i,
    ],
    ['bounce', /delivery (?:failed|failure)|undeliverable|address not found/i],
    ['assignment', /take.home assignment|complete[^.\n]{0,60}(?:assignment|assessment)/i],
    ['question', /could you (?:confirm|share|provide)|please (?:confirm|provide|share)/i],
    ['acknowledgment', /received your application|thank you for (?:your application|applying)/i],
  ];
  const matches = cues
    .map(([kind, re]) => ({ kind, match: body.match(re) }))
    .filter((x) => x.match);
  let kind = matches[0]?.kind ?? 'needs-review';
  if (
    matches.some((x) => x.kind === 'rejection') &&
    matches.some((x) => ['interview', 'assignment'].includes(x.kind))
  )
    kind = 'needs-review';
  if (matches.some((x) => x.kind === 'bounce'))
    kind = matches.some((x) => x.kind !== 'bounce') ? 'needs-review' : 'bounce';
  const tasks = {
    interview: 'Choose interview time',
    rejection: 'Review rejection',
    bounce: 'Check delivery issue',
    assignment: 'Review assignment',
    question: 'Reply to recruiter',
    'needs-review': 'Review message',
    acknowledgment: null,
  };
  return {
    kind,
    method: 'Rule-based suggestion — review the original',
    excerpt:
      kind === 'needs-review' && matches.length > 1
        ? matches.map((x) => x.match[0]).join(' | ')
        : (matches.find((x) => x.kind === kind)?.match[0] ?? body.slice(0, 180)),
    action: tasks[kind],
    proposedStage: kind === 'interview' ? 'interview' : kind === 'rejection' ? 'rejected' : null,
  };
}
const cleanFile = (f) => ({ ...f, base64: undefined });
export const publicApplication = (a) => ({
  ...a,
  files: a.files.map(cleanFile),
  history: a.history.map((h) => ({ ...h, files: h.files.map(cleanFile) })),
});
export const publicMessage = (m) => ({ ...m, files: m.files.map(cleanFile) });
const packetSnapshot = ({ history: _history, ...snapshot }) => snapshot;
export function mailAction(state, path, body) {
  const now = new Date().toISOString();
  const opportunity = (key) =>
    state.opportunities.find((o) => o.id === key) ?? fail(404, 'Saved job not found.');
  if (path === '/api/mail/send')
    fail(
      503,
      'Live mail is not configured. Choose a domain and connect a verified provider. Nothing was sent.',
    );
  if (path.startsWith('/api/applications/')) {
    const o = opportunity(path.split('/').at(-1));
    let a = state.applications.find((v) => v.opportunityId === o.id);
    rev(body.revision, a?.revision ?? 0);
    const next = {
      opportunityId: o.id,
      revision: (a?.revision ?? 0) + 1,
      cvVersion: text(body.cvVersion, 150, 'CV version'),
      cvText: text(body.cvText, 20000, 'CV text'),
      coverLetter: text(body.coverLetter, 10000, 'cover letter'),
      answers: text(body.answers, 10000, 'screening answers'),
      files: files(body.files ?? []),
      profileVersion: state.profile?.version ?? null,
      savedAt: now,
      history: a ? [...a.history, packetSnapshot(a)] : [],
    };
    if (!next.cvVersion || (!next.cvText && !next.files.length))
      fail(400, 'Name a CV version and add CV text or a file.');
    if (next.history.length >= 40) fail(400, 'Application revision limit reached (40).');
    if (a) Object.assign(a, next);
    else state.applications.push(next);
    return;
  }
  if (path === '/api/mail/intake') {
    if (!['test', 'manual'].includes(body.origin))
      fail(400, 'Only test or manual intake is enabled.');
    const m = {
      id: id(),
      origin: body.origin,
      transportId: text(body.transportId, 128, 'transport ID'),
      from: email(body.from),
      to: email(body.to),
      subject: text(body.subject, 250, 'subject'),
      text: text(body.text, 20000, 'message'),
      inReplyTo: text(body.inReplyTo ?? '', 128, 'parent message'),
      files: files(body.files ?? []),
      receivedAt: now,
      direction: 'inbound',
      revision: 0,
    };
    if (!m.transportId || !m.text) fail(400, 'Message ID and body are required.');
    m.payloadHash = hash({
      from: m.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      inReplyTo: m.inReplyTo,
      files: m.files,
    });
    const duplicate = state.messages.find(
      (v) => v.origin === m.origin && v.transportId === m.transportId,
    );
    if (duplicate) {
      if (duplicate.payloadHash !== m.payloadHash)
        fail(409, 'Message ID already exists with different content.');
      return;
    }
    if (state.messages.length >= 200) fail(400, 'Message limit reached (200).');
    const matches = state.opportunities.filter((o) => testAlias(o) === m.to);
    const parents = state.messages.filter(
      (v) => v.origin === m.origin && v.transportId === m.inReplyTo && v.opportunityId,
    );
    const targets = new Set([...matches.map((o) => o.id), ...parents.map((p) => p.opportunityId)]);
    m.opportunityId = targets.size === 1 ? [...targets][0] : null;
    m.analysis = analyzeMail(m.text);
    m.task = { done: false, revision: 0 };
    state.messages.push(m);
    return;
  }
  const match = path.match(/^\/api\/mail\/(link|replies|tasks|proposals|analysis)\/([^/]+)$/);
  if (!match) fail(404, 'Mail action not found.');
  const [, action, messageId] = match;
  const m = state.messages.find((v) => v.id === messageId) ?? fail(404, 'Message not found.');
  if (m.origin === 'gmail-import')
    fail(
      400,
      'Historical Gmail evidence is read-only. Reply and manage the conversation in its source mailbox.',
    );
  if (action === 'analysis') {
    rev(body.revision, m.revision);
    const kind = body.kind;
    if (
      ![
        'interview',
        'rejection',
        'question',
        'assignment',
        'acknowledgment',
        'bounce',
        'needs-review',
      ].includes(kind)
    )
      fail(400, 'Choose a supported interpretation.');
    const excerpt = text(body.excerpt ?? '', 500, 'supporting excerpt');
    if (kind !== 'needs-review' && (!excerpt || !m.text.includes(excerpt)))
      fail(400, 'Copy an exact supporting excerpt from the original email.');
    if (excerpt && !m.text.includes(excerpt))
      fail(400, 'Excerpt must appear in the original email.');
    m.analysisHistory = [...(m.analysisHistory ?? []), { ...m.analysis, changedAt: now }];
    if (m.analysisHistory.length > 20) fail(400, 'Interpretation correction limit reached (20).');
    const actionLabels = {
      interview: 'Choose interview time',
      rejection: 'Review rejection',
      question: 'Reply to recruiter',
      assignment: 'Review assignment',
      acknowledgment: null,
      bounce: 'Check delivery issue',
      'needs-review': 'Review message',
    };
    m.analysis = {
      kind,
      method: 'Candidate correction',
      excerpt: excerpt || 'No excerpt selected; review the original.',
      action: actionLabels[kind],
      proposedStage: kind === 'interview' ? 'interview' : kind === 'rejection' ? 'rejected' : null,
    };
    m.revision++;
    m.task = { done: false, revision: m.task.revision + 1 };
    return;
  }
  if (action === 'link') {
    rev(body.revision, m.revision);
    if (m.opportunityId) fail(409, 'Message already linked.');
    const o = opportunity(body.opportunityId);
    m.opportunityId = o.id;
    m.revision++;
    m.linkedBy = 'candidate';
    return;
  }
  if (action === 'replies') {
    if (!m.opportunityId) fail(400, 'Link the message to a saved job first.');
    let draft = state.replyDrafts.find((v) => v.messageId === m.id);
    rev(body.revision, draft?.revision ?? 0);
    const reply = {
      messageId: m.id,
      opportunityId: m.opportunityId,
      to: m.from,
      subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject,
      body: text(body.body, 10000, 'reply'),
      revision: (draft?.revision ?? 0) + 1,
      savedAt: now,
      status: 'draft',
    };
    if (!reply.body) fail(400, 'Write a reply before saving the draft.');
    if (draft) Object.assign(draft, reply);
    else state.replyDrafts.push(reply);
    return;
  }
  if (action === 'tasks') {
    rev(body.revision, m.task.revision);
    if (typeof body.done !== 'boolean') fail(400, 'Task state required.');
    m.task = { done: body.done, revision: m.task.revision + 1 };
    return;
  }
  if (action === 'proposals') {
    rev(body.revision, m.revision);
    if (!m.opportunityId || !m.analysis.proposedStage) fail(400, 'No linked stage suggestion.');
    const o = opportunity(m.opportunityId);
    if (m.origin === 'test' && o.runMode !== 'fixture')
      fail(400, 'Test mail cannot change a real application stage.');
    rev(body.decisionRevision, o.decisionRevision);
    if (o.stage === m.analysis.proposedStage) return;
    o.stage = m.analysis.proposedStage;
    o.decisionRevision++;
    o.updatedAt = now;
    o.events.push({
      at: now,
      stage: o.stage,
      origin: 'candidate-confirmed-message',
      messageId: m.id,
    });
    return;
  }
}
