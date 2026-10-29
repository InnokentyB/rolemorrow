import { Readable } from 'node:stream';
import { PREPARATION_TIMING } from './preparation-policy.mjs';
import { EventEmitter } from 'node:events';
import { delegatedContext, assertDelegation, withDelegation } from './mcp-context.mjs';
import { createHash } from 'node:crypto';
import { createCareerImportManager } from './career-import.mjs';
import {
  createAudit,
  appendAudit,
  recoverAudit,
  queryAudit,
  exportAudit,
  snapshotDigest,
} from './agent-audit.mjs';
import {
  validatePreparationRequest,
  renderPreparation,
  preparationSnapshotHash,
} from './application-preparation.mjs';
import { cachedSnapshot, simulateDispatch, simulateReply } from './controlled-local.mjs';
import { AI_PERMISSION_VERSION } from './policies.mjs';
import { checkSavedSource } from './source-check.mjs';
import { externalListing } from './url-intake.mjs';
import { nextActions } from '../public/actions.js';
import { rankResults } from '../public/matching.js';
import http from 'node:http';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateProfile,
  cleanText,
  hash,
  id,
  officialJob,
  validateJob,
  validateAssessment,
  classify,
  intakeQuestions,
} from './domain.mjs';
import { getProviders, createFixtureProviders, liveJobLimit } from './providers.mjs';
import { validatePublicUrl } from './network.mjs';
import { opportunityKey, observe, saveOpportunity, validateDecision } from './opportunities.mjs';
import { mailAction, MailError, publicApplication, publicMessage } from './mail.mjs';
import {
  prepareDispatch,
  claimDispatch,
  settleDispatch,
  deliveryEvent,
  receiveResend,
  markNotification,
  publicDispatch,
} from './mail-transport.mjs';
import { createResendAdapter, verifyResendWebhook } from './resend.mjs';
export const EVIDENCE_POLICY = '2026-10-18-profession-level-v2';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const blank = () => ({
  revision: 0,
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
  mailReceivingPaused: false,
  mailSchema: 1,
});
export function createServer({
  providers,
  mailProvider,
  organizationCatalog,
  onCompaniesSaved,
  storeFile = join(process.cwd(), 'data', 'state.json'),
  storage,
  legacyUntracked = false,
  accountId,
  accountGeneration = 0,
  preparationTimeoutMs = PREPARATION_TIMING.http,
  preparationQuota,
  applicationPreparer,
  importManager: suppliedImportManager,
  catalogVacancies,
  env = process.env,
} = {}) {
  let state = storage
    ? (storage.readSync('workspace:' + accountId) ?? blank())
    : existsSync(storeFile)
      ? JSON.parse(readFileSync(storeFile, 'utf8'))
      : blank();
  let active = null,
    workspaceGeneration = 0;
  const sourceChecks = new Set();
  const importManager = suppliedImportManager ?? createCareerImportManager();
  const preparations = new Map();
  const preparationAdmissions = new Map();
  let preparing = null;
  let preparationClosed = false;
  const preparationMode = (opportunity) =>
    env.CONTROLLED_LOCAL_MODE === '1' || opportunity?.runMode === 'fixture' ? 'fixture' : 'live';
  const preparationProvider = (opportunity) => {
    const base =
      providers ??
      (preparationMode(opportunity) === 'fixture'
        ? createFixtureProviders()
        : getProviders({ env }));
    return applicationPreparer ? { ...base, prepareApplication: applicationPreparer } : base;
  };
  const preparationAvailable = (opportunity) =>
    typeof preparationProvider(opportunity).prepareApplication === 'function' &&
    (preparationMode(opportunity) === 'fixture' ||
      (env.ALLOW_LIVE === '1' &&
        !!env.NEBIUS_API_KEY &&
        /^nvidia\//i.test(env.NEBIUS_ASSESSMENT_MODEL || env.NEBIUS_MODEL || '')));
  const cancelPreparation = () => {
    preparing?.controller.abort(
      new MailError(409, 'Preparation cancelled. Your saved packet is unchanged.'),
    );
  };
  state.opportunities ??= [];
  state.applications ??= [];
  state.messages ??= [];
  state.replyDrafts ??= [];
  state.mailDispatches ??= [];
  state.mailEvents ??= [];
  state.notifications ??= [];
  state.webhookReceipts ??= [];
  const transport =
    mailProvider ??
    createResendAdapter({ sendKey: env.RESEND_API_KEY, receiveKey: env.RESEND_RECEIVE_API_KEY });
  const allowlist = (env.MAIL_RECIPIENT_ALLOWLIST ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const sendReady = () =>
    env.MAIL_ALLOW_SEND === '1' &&
    !!env.RESEND_API_KEY &&
    !!env.MAIL_FROM &&
    !!env.MAIL_REPLY_DOMAIN &&
    (allowlist.length > 0 || env.MAIL_ALLOW_ANY_RECIPIENT === '1');
  const receiveReady = () =>
    !state.mailReceivingPaused &&
    !!env.RESEND_RECEIVE_API_KEY &&
    !!env.RESEND_WEBHOOK_SECRET &&
    !!env.MAIL_REPLY_DOMAIN;
  const allowedRecipient = (to) => {
    if (!allowlist.includes(to.toLowerCase()) && env.MAIL_ALLOW_ANY_RECIPIENT !== '1')
      throw new MailError(403, 'This recipient is outside the configured test allowlist.');
  };
  // Actual mounted source, not a Git revision or a caller-controlled environment claim.
  const auditCodeFiles = readdirSync(new URL('./', import.meta.url))
    .filter((file) => file.endsWith('.mjs'))
    .sort();
  if (auditCodeFiles.length > 256)
    throw Error('Audit source bundle exceeds its bounded file inventory.');
  const auditSources = [
    ...auditCodeFiles.map((file) => ({ file: 'app/' + file, url: new URL(file, import.meta.url) })),
    ...['package-lock.json', 'public/matching.js', 'public/actions.js'].map((file) => ({
      file,
      url: new URL('../' + file, import.meta.url),
    })),
  ].map(({ file, url }) => {
    const source = readFileSync(url, 'utf8');
    if (Buffer.byteLength(source) > 2 * 1024 * 1024)
      throw Error('Audit source file exceeds its bounded size.');
    return { file, source };
  });
  const auditCodeRevision = hash(auditSources);
  const auditEnabled = !!storage;
  if (env.PUBLIC_SERVICE === '1' && !auditEnabled && legacyUntracked !== true)
    throw Object.assign(Error('Public service requires private decision history storage.'), {
      status: 503,
    });
  const auditKey = 'audit:' + accountId;
  const auditActor = (type = 'system', role = 'validation', mode = 'manual', extra = {}) => ({
    type,
    role,
    mode,
    id: type === 'user' ? accountId : null,
    codeRevision: auditCodeRevision,
    promptHash: null,
    provider: null,
    model: null,
    ...extra,
    ...((type === 'user' || (type === 'agent' && role === 'preparation')) && delegatedContext()
      ? {
          type: 'agent',
          role:
            'delegated:' + delegatedContext().clientId + (type === 'agent' ? ':preparation' : ''),
          id: delegatedContext().grantId,
        }
      : {}),
  });
  const auditIdentity = (result, mode) => opportunityKey(result, mode);
  const auditProfile = (profile) => ({
    kind: 'profile',
    data: {
      profileVersion: profile?.version ?? null,
      facts: profile?.facts ?? [],
      goal: profile?.goal ?? null,
      preferences: profile?.preferences ?? null,
    },
  });
  const auditJob = (job) => ({
    kind: 'job',
    data: Object.fromEntries(
      [
        'id',
        'title',
        'text',
        'url',
        'company',
        'requirements',
        'countries',
        'workMode',
        'salary',
        'source',
        'profileVersion',
        'evidencePolicy',
        'authorizationRequirement',
        'companyIndustry',
      ]
        .filter((key) => job?.[key] !== undefined)
        .map((key) => [key, job[key]]),
    ),
  });
  const auditPacket = (packet) => ({
    kind: 'packet',
    data: {
      cvVersion: packet.cvVersion,
      cvText: packet.cvText,
      coverLetter: packet.coverLetter,
      answers: packet.answers,
      revision: packet.revision,
      profileVersion: packet.profileVersion ?? null,
      files: (packet.files ?? []).map((file) => ({
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
        hash: createHash('sha256')
          .update(Buffer.from(file.base64 ?? '', 'base64'))
          .digest('hex'),
      })),
    },
  });
  function auditEvent(action, status, context = {}, extra = {}) {
    return {
      traceId: context.traceId ?? id(),
      action,
      status,
      reasonCode:
        status === 'start'
          ? 'operation-start'
          : status === 'failed'
            ? 'operation-failed'
            : status === 'cancelled'
              ? 'operation-cancelled'
              : status === 'stale'
                ? 'input-stale'
                : 'operation-recorded',
      reason:
        status === 'start'
          ? 'Operation started with saved inputs.'
          : status === 'failed'
            ? 'Operation failed; no provider outcome is inferred.'
            : status === 'cancelled'
              ? 'Operation was cancelled.'
              : status === 'stale'
                ? 'Saved inputs changed; late output was refused.'
                : 'Recorded operation outcome. No employer outcome is inferred.',
      actor: auditActor(),
      ...context,
      ...extra,
    };
  }
  function appendEvents(current, events, snapshots = []) {
    let next = current ?? createAudit();
    for (let index = 0; index < events.length; index++)
      next = appendAudit(next, events[index], { snapshots: index === 0 ? snapshots : [] });
    // One coordinator transaction advances the aggregate CAS exactly once; event sequence/hash still advances for every event.
    if (events.length) next.commitRevision = (current?.commitRevision ?? 0) + 1;
    return next;
  }
  function recordAudit(events, snapshots = [], fence = workspaceGeneration) {
    if (!auditEnabled) return;
    if (preparationClosed || fence !== workspaceGeneration)
      throw new MailError(409, 'Workspace changed before history could be recorded.');
    const lifecycle = storage.readSync('lifecycle')?.records?.[accountId];
    const exists = storage.readSync('auth')?.users?.some((user) => user.id === accountId);
    if (!exists || (lifecycle && (!lifecycle.active || lifecycle.generation !== accountGeneration)))
      throw new MailError(409, 'Account or workspace changed before history could be recorded.');
    const current = storage.readSync(auditKey),
      next = appendEvents(current, events, snapshots);
    storage.commitSync({
      transactionId: id(),
      accountId,
      generation: accountGeneration,
      expectedRevisions: { [auditKey]: current?.commitRevision ?? null },
      targets: [{ storeId: auditKey, value: next, revision: next.commitRevision }],
    });
  }
  function auditedContext(action, context = {}, snapshots = []) {
    const operation = {
        ...context,
        traceId: context.traceId ?? id(),
        spanId: context.spanId ?? id(),
        operationId: context.operationId ?? id(),
      },
      started = performance.now(),
      fence = workspaceGeneration;
    recordAudit(
      [auditEvent(action, 'start', operation, { snapshotRefs: snapshots.map(snapshotDigest) })],
      snapshots,
      fence,
    );
    let finished = false;
    return {
      context: operation,
      fence,
      finish(status = 'observed', extra = {}, saved = []) {
        if (finished) return;
        try {
          recordAudit(
            [
              auditEvent(action, status, operation, {
                durationMs: Math.max(0, Math.round(performance.now() - started)),
                ...extra,
                snapshotRefs: saved.map(snapshotDigest),
              }),
            ],
            saved,
            fence,
          );
          finished = true;
        } catch (error) {
          if (error.status === 507 && saved.length) {
            recordAudit(
              [
                auditEvent(action, 'failed', operation, {
                  durationMs: Math.max(0, Math.round(performance.now() - started)),
                  reasonCode: 'AUDIT_CAPACITY',
                  reason:
                    'Decision history capacity prevented retaining the exact output snapshot. That historical output is unavailable; no ready result was accepted.',
                }),
              ],
              [],
              fence,
            );
            finished = true;
          }
          throw error;
        }
      },
    };
  }

  async function auditStep(action, context, snapshots, fn) {
    const step = auditedContext(action, context, snapshots);
    try {
      const value = await fn(step.context);
      step.finish('observed');
      return value;
    } catch (error) {
      try {
        step.finish(
          error?.name === 'AbortError' ? 'cancelled' : error?.status === 409 ? 'stale' : 'failed',
        );
      } catch (auditError) {
        if (auditError.status !== 409) throw auditError;
      }
      throw error;
    }
  }

  function providerAuditCallback(context) {
    const stages = new Map();
    return async (event) => {
      if (
        ![
          'extraction',
          'extraction-repair',
          'requirement-review',
          'assessment-proposal',
          'assessment-repair',
          'evidence-review',
        ].includes(event?.stage)
      )
        throw new MailError(400, 'Invalid internal source stage.');
      const { companyCareers, ...eventContext } = context;
      const url = event.snapshot?.kind === 'job' ? event.snapshot.data?.url : null;
      if (url && companyCareers) {
        try {
          eventContext.vacancyKey = auditIdentity(
            { url, source: { linkedFrom: companyCareers } },
            context.actor.mode,
          );
        } catch {
          throw new MailError(400, 'Invalid internal source identity.');
        }
      }
      const snapshots = event.snapshot ? [event.snapshot] : [],
        actor = auditActor('agent', event.stage, context.actor.mode, {
          provider: event.provider ?? null,
          model: event.model ?? null,
          promptHash: event.promptHash ?? null,
        });
      if (event.status === 'start')
        stages.set(event.stage, auditedContext(event.stage, { ...eventContext, actor }, snapshots));
      else {
        const step = stages.get(event.stage);
        if (!step) throw new MailError(400, 'Agent stage has no recorded start.');
        step.finish(
          ['failed', 'cancelled', 'rejected'].includes(event.status) ? event.status : 'observed',
          event.usage ? { usage: event.usage } : {},
          snapshots,
        );
        stages.delete(event.stage);
      }
    };
  }
  function businessAudit(before, after, { packetLink = null, careerImport = null } = {}) {
    if (careerImport) {
      const context = delegatedContext();
      const actor = {
        ...auditActor('user', 'career-import', 'manual'),
        ...(context?.grantId
          ? {
              type: 'agent',
              role: 'delegated:' + context.clientId + ':career-import',
              id: context.grantId,
            }
          : {}),
      };
      return {
        events: [
          auditEvent(
            'career-import',
            'accepted',
            {
              traceId: careerImport.batchId,
              operationId: careerImport.itemId,
              actor,
              ...(careerImport.entityRefs?.opportunityId
                ? { opportunityId: careerImport.entityRefs.opportunityId }
                : {}),
            },
            {
              reasonCode: 'selected-career-source-import',
              reason:
                'Selected source item ' +
                careerImport.itemId +
                '; normalized SHA256 ' +
                careerImport.sourceDigest +
                '.',
            },
          ),
        ],
        snapshots: [],
      };
    }
    const events = [],
      snapshots = [],
      traceId = id();
    const add = (action, status, extra = {}, snapshot) => {
      if (snapshot) snapshots.push(snapshot);
      if (extra.opportunityId && !extra.vacancyKey) {
        const own = after.opportunities.find((row) => row.id === extra.opportunityId);
        if (own) extra = { ...extra, vacancyKey: own.identity };
      }
      events.push(
        auditEvent(
          action,
          status,
          {
            traceId,
            actor: auditActor('user', 'candidate', after.run?.mode ?? 'manual'),
            ...extra,
          },
          { ...(snapshot ? { snapshotRefs: [snapshotDigest(snapshot)] } : {}) },
        ),
      );
    };
    if (before.profile?.version !== after.profile?.version && after.profile)
      add('profile-save', 'accepted', {}, auditProfile(after.profile));
    if (hash(before.companies) !== hash(after.companies)) add('company-sources-save', 'accepted');
    if (after.run && (before.run?.id !== after.run.id || before.run?.status !== after.run.status))
      add(
        'search-' + after.run.status,
        after.run.status === 'cancelled'
          ? 'cancelled'
          : after.run.status === 'failed'
            ? 'failed'
            : 'accepted',
        { traceId: after.run.id, actor: auditActor('system', 'search', after.run.mode) },
      );
    for (const opportunity of after.opportunities) {
      const old = before.opportunities.find((row) => row.id === opportunity.id),
        context = { opportunityId: opportunity.id, vacancyKey: opportunity.identity };
      if (!old) add('opportunity-save', 'accepted', context, auditJob(opportunity.snapshot));
      else if (old.decisionRevision !== opportunity.decisionRevision)
        add('candidate-override', 'accepted', context, {
          kind: 'proposal',
          data: {
            stage: 'candidate-decision',
            document: {
              stage: opportunity.stage,
              note: opportunity.note,
              nextAction: opportunity.nextAction,
              dueDate: opportunity.dueDate,
            },
          },
        });
      if (old?.sourceCheckRevision !== opportunity.sourceCheckRevision && opportunity.sourceCheck)
        add('source-check', 'observed', {
          ...context,
          actor: auditActor('system', 'source-check', opportunity.runMode),
        });
    }
    for (const packet of after.applications)
      if (
        before.applications.find((row) => row.opportunityId === packet.opportunityId)?.revision !==
        packet.revision
      )
        add(
          'packet-save',
          'accepted',
          {
            opportunityId: packet.opportunityId,
            vacancyKey: after.opportunities.find((row) => row.id === packet.opportunityId)
              ?.identity,
            packetRevision: packet.revision,
            ...(packetLink?.opportunityId === packet.opportunityId
              ? {
                  traceId: packetLink.traceId,
                  parentSpanId: packetLink.parentSpanId,
                  reasonCode: 'verified-preparation',
                  reason:
                    'Candidate saved the exact prepared document text, verified against the owned accepted preparation and current profile and vacancy.',
                }
              : {
                  reasonCode: 'manual-packet',
                  reason: 'No verified preparation link; candidate-saved text.',
                }),
          },
          auditPacket(packet),
        );
    for (const dispatch of after.mailDispatches) {
      const old = before.mailDispatches.find((row) => row.id === dispatch.id);
      if (!old)
        add('dispatch-approval', 'accepted', {
          opportunityId: dispatch.opportunityId,
          applicationAttemptId: dispatch.id,
          packetRevision: dispatch.packetRevision ?? null,
          actor: auditActor(
            'user',
            'candidate',
            dispatch.status === 'simulated' ? 'fixture' : 'manual',
          ),
        });
      if (!old || old.status !== dispatch.status)
        add(
          old ? 'dispatch-result' : 'dispatch-intent',
          dispatch.simulated || dispatch.status === 'simulated'
            ? 'simulated'
            : dispatch.status === 'unknown'
              ? 'unknown'
              : dispatch.status === 'failed'
                ? 'failed'
                : dispatch.status === 'prepared' || dispatch.status === 'sending'
                  ? 'accepted'
                  : 'observed',
          {
            opportunityId: dispatch.opportunityId,
            applicationAttemptId: dispatch.id,
            packetRevision: dispatch.packetRevision ?? null,
            actor: auditActor(
              'system',
              'mail-transport',
              dispatch.simulated || dispatch.status === 'simulated' ? 'fixture' : 'manual',
            ),
          },
        );
    }
    for (const message of after.messages)
      if (!before.messages.some((row) => row.id === message.id))
        add('inbound-match', 'observed', {
          opportunityId: message.opportunityId ?? null,
          actor: auditActor(
            'system',
            'inbound-observation',
            message.synthetic || message.origin === 'test' ? 'fixture' : 'manual',
          ),
        });
    for (const draft of after.replyDrafts)
      if (
        before.replyDrafts.find((row) => row.messageId === draft.messageId)?.revision !==
        draft.revision
      )
        add('reply-draft-save', 'accepted', {
          opportunityId:
            after.messages.find((row) => row.id === draft.messageId)?.opportunityId ?? null,
        });
    for (const notification of after.notifications) {
      const old = before.notifications.find((row) => row.id === notification.id);
      if (!old)
        add('notification-create', 'observed', {
          opportunityId: notification.opportunityId ?? null,
          actor: auditActor(
            'system',
            'notification',
            notification.origin === 'test' ? 'fixture' : 'manual',
          ),
        });
      else if (old.readAt !== notification.readAt || old.read !== notification.read)
        add('notification-read', 'accepted', { opportunityId: notification.opportunityId ?? null });
    }
    if (!events.length)
      add('workspace-update', 'accepted', { actor: auditActor('system', 'workspace', 'manual') });
    return { events, snapshots };
  }

  function verifiedPacketLink(opportunityId, body) {
    if (body.preparedRequestId === undefined) return null;
    if (
      !auditEnabled ||
      typeof body.preparedRequestId !== 'string' ||
      body.preparedRequestId.length > 100
    )
      throw new MailError(409, 'Preparation link cannot be verified for this saved packet.');
    const opportunity = state.opportunities.find((row) => row.id === opportunityId);
    if (!opportunity)
      throw new MailError(409, 'Preparation link cannot be verified for this saved packet.');
    const audit = storage.readSync(auditKey) ?? createAudit();
    const accepted = audit.events.find(
      (event) =>
        event.action === 'preparation:request' &&
        event.status === 'accepted' &&
        event.traceId === body.preparedRequestId &&
        event.operationId === body.preparedRequestId &&
        event.opportunityId === opportunityId &&
        event.vacancyKey === opportunity.identity,
    );
    const snapshot = accepted?.snapshotRefs
      ?.map((digest) => audit.snapshots[digest])
      .find(
        (value) =>
          value?.kind === 'packet' &&
          value.data.profileVersion === state.profile?.version &&
          value.data.opportunityHash === preparationSnapshotHash(opportunity.snapshot) &&
          ['cvVersion', 'cvText', 'coverLetter', 'answers'].every(
            (key) => typeof body[key] === 'string' && value.data[key] === body[key],
          ),
      );
    if (!accepted || !snapshot)
      throw new MailError(
        409,
        'Prepared text, profile, vacancy or preparation identity changed. Save edited text without a verified preparation link.',
      );
    return { opportunityId, traceId: accepted.traceId, parentSpanId: accepted.spanId };
  }
  function auditFilters(url) {
    const allowed = new Set([
      'opportunityId',
      'vacancyKey',
      'applicationAttemptId',
      'after',
      'limit',
      'actorRole',
      'errorsOnly',
    ]);
    if (
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
    )
      throw new MailError(400, 'Invalid history query.');
    const filters = Object.fromEntries(url.searchParams);
    for (const key of ['after', 'limit'])
      if (filters[key] !== undefined) {
        if (!/^\d+$/.test(filters[key])) throw new MailError(400, 'Invalid history page.');
        filters[key] = Number(filters[key]);
      }
    if (filters.errorsOnly !== undefined) {
      if (!['true', 'false'].includes(filters.errorsOnly))
        throw new MailError(400, 'Invalid error filter.');
      filters.errorsOnly = filters.errorsOnly === 'true';
    }
    if (filters.opportunityId) {
      const own = state.opportunities.find((row) => row.id === filters.opportunityId);
      if (!own) throw new MailError(404, 'History not found.');
      filters.vacancyKey = own.identity;
      delete filters.opportunityId;
    }
    const audit = storage.readSync(auditKey) ?? createAudit();
    if (
      filters.vacancyKey &&
      !audit.events.some((event) => event.vacancyKey === filters.vacancyKey) &&
      !state.opportunities.some((row) => row.identity === filters.vacancyKey)
    )
      throw new MailError(404, 'History not found.');
    if (
      filters.applicationAttemptId &&
      !audit.events.some((event) => event.applicationAttemptId === filters.applicationAttemptId)
    )
      throw new MailError(404, 'History not found.');
    return { audit, filters };
  }
  if (auditEnabled) {
    const original = storage.readSync(auditKey);
    if (original) {
      const recovered = recoverAudit(original);
      if (recovered.commitRevision !== original.commitRevision)
        storage.commitSync({
          transactionId: id(),
          accountId,
          generation: accountGeneration,
          expectedRevisions: { [auditKey]: original.commitRevision },
          targets: [{ storeId: auditKey, value: recovered, revision: recovered.commitRevision }],
        });
    }
  }

  function mutate(change, { clearAudit = false, packetLink = null, careerImport = null } = {}) {
    assertDelegation();
    const next = structuredClone(state);
    change(next);
    next.revision = state.revision + 1;
    if (storage) {
      const key = 'workspace:' + accountId,
        current = storage.readSync(key);
      const previousAudit = storage.readSync(auditKey),
        changes = businessAudit(state, next, { packetLink, careerImport });
      let nextAudit;
      if (clearAudit) {
        nextAudit = createAudit();
        nextAudit.commitRevision = (previousAudit?.commitRevision ?? 0) + 1;
      } else nextAudit = appendEvents(previousAudit, changes.events, changes.snapshots);
      const connectionsKey = 'connections:' + accountId;
      const previousConnections = clearAudit ? storage.readSync(connectionsKey) : null;
      const nextConnections = previousConnections
        ? {
            ...structuredClone(previousConnections),
            commitRevision: previousConnections.commitRevision + 1,
            historyEpoch: id(),
            historyAnchor: '',
          }
        : null;
      storage.commitSync({
        transactionId: id(),
        accountId,
        generation: accountGeneration,
        expectedRevisions: {
          [key]: current?.revision ?? null,
          [auditKey]: previousAudit?.commitRevision ?? null,
          ...(nextConnections ? { [connectionsKey]: previousConnections.commitRevision } : {}),
        },
        targets: [
          { storeId: key, value: next, revision: next.revision },
          { storeId: auditKey, value: nextAudit, revision: nextAudit.commitRevision },
          ...(nextConnections
            ? [
                {
                  storeId: connectionsKey,
                  value: nextConnections,
                  revision: nextConnections.commitRevision,
                },
              ]
            : []),
        ],
      });
      state = next;
      return;
    }
    mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
    if (existsSync(storeFile) && !JSON.parse(readFileSync(storeFile, 'utf8')).opportunities) {
      try {
        writeFileSync(storeFile + '.pre-tracking.bak', readFileSync(storeFile), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    if (existsSync(storeFile) && JSON.parse(readFileSync(storeFile, 'utf8')).mailSchema !== 1) {
      try {
        writeFileSync(storeFile + '.pre-mail.bak', readFileSync(storeFile), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    next.mailSchema = 1;
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
      throw new MailError(400, 'Local workspace storage limit reached (32 MiB).');
    const tmp = storeFile + '.tmp';
    writeFileSync(tmp, serialized, { mode: 0o600 });
    renameSync(tmp, storeFile);
    state = next;
  }
  if (state.run?.status === 'running')
    mutate((s) => {
      s.run.status = 'failed';
      s.run.note = 'Previous process stopped. Start a new check.';
    });
  function publicState() {
    const opportunities = state.opportunities.map((o) => ({
      ...o,
      auditVacancyKey: o.identity,
      assessmentStale:
        o.snapshot.profileVersion !== state.profile?.version ||
        !!(o.snapshot.assessment && o.snapshot.evidencePolicy !== EVIDENCE_POLICY),
    }));
    return {
      ...state,
      publicService: env.PUBLIC_SERVICE === '1',
      audit: auditEnabled
        ? (() => {
            const audit = storage.readSync(auditKey) ?? createAudit();
            return {
              available: true,
              version: 1,
              count: audit.events.length,
              capacity: queryAudit(audit, { limit: 1 }).capacity,
            };
          })()
        : { available: false, reason: 'legacy-untracked' },
      preparation: {
        available: preparationAvailable(),
        mode: preparationAvailable() ? preparationMode() : 'unavailable',
      },
      mailDispatches: state.mailDispatches.map(publicDispatch),
      mailEvents: undefined,
      webhookReceipts: undefined,
      nextActions: nextActions({ ...state, opportunities }),
      opportunities,
      applications: state.applications.map(publicApplication),
      messages: state.messages.map(publicMessage),
      mailTransport: {
        simulated: env.CONTROLLED_LOCAL_MODE === '1',
        mode:
          env.CONTROLLED_LOCAL_MODE === '1' ? 'simulated' : sendReady() ? 'resend' : 'test/manual',
        liveReady: sendReady(),
        sendReady: sendReady(),
        receiveReady: receiveReady(),
        receivingPaused: state.mailReceivingPaused === true,
        receivingNote: state.mailReceivingPaused
          ? 'Receiving paused after workspace deletion. Re-enable deliberately before importing new correspondence.'
          : '',
        from: env.MAIL_FROM ?? '',
        replyDomain: env.MAIL_REPLY_DOMAIN ?? '',
        replyAliasPrefix: env.MAIL_ALIAS_PREFIX ?? '',
        recipientAllowlist: env.PUBLIC_SERVICE === '1' ? [] : allowlist,
        recipientRestricted: env.MAIL_ALLOW_ANY_RECIPIENT !== '1',
        note: sendReady()
          ? 'Real sending configured. Review recipients and saved content before confirming. Acceptance is not delivery.'
          : 'Live sending is disabled until credentials, sender and recipient policy are configured.',
      },
      run: state.run
        ? {
            ...state.run,
            stale:
              state.run.stale ||
              (state.run.mode !== 'manual' && state.run.evidencePolicy !== EVIDENCE_POLICY),
            results: rankResults(state.run.results).map((r) => ({
              ...r,
              auditVacancyKey: auditIdentity(r, state.run.mode),
              opportunityId:
                state.opportunities.find((o) => o.identity === opportunityKey(r, state.run.mode))
                  ?.id ?? null,
            })),
          }
        : null,
      history: undefined,
      config: {
        liveMaxJobsPerCompany: liveJobLimit(env),
        liveReady:
          env.ALLOW_LIVE === '1' &&
          !!env.NEBIUS_API_KEY &&
          !!env.TAVILY_API_KEY &&
          /^nvidia\//.test(env.NEBIUS_MODEL ?? '') &&
          (!env.NEBIUS_ASSESSMENT_MODEL || /^nvidia\//.test(env.NEBIUS_ASSESSMENT_MODEL)),
        modeLabel: 'Fictional example · no external requests',
      },
      intakeQuestions: intakeQuestions(state.profile),
    };
  }
  // A process may stop after provider acceptance but before the receipt is persisted.
  if (state.mailDispatches.some((d) => d.status === 'sending'))
    mutate((s) => {
      for (const d of s.mailDispatches)
        if (d.status === 'sending') {
          d.status = 'unknown';
          d.revision++;
          d.lastError =
            'Previous send interrupted; reconcile or retry the same snapshot within its idempotency window.';
        }
    });
  async function transmit(dispatchId) {
    let claimed;
    mutate((s) => {
      claimed = claimDispatch(s, dispatchId);
    });
    const pending = state.mailDispatches.find((d) => d.id === dispatchId);
    let outcome;
    try {
      const sent = await auditStep(
        'dispatch-provider',
        {
          opportunityId: pending.opportunityId,
          applicationAttemptId: pending.id,
          packetRevision: pending.packetRevision ?? null,
          operationId: claimed.idempotencyKey,
          actor: auditActor('system', 'mail-transport', 'live', { provider: 'resend' }),
        },
        [],
        () => transport.send(claimed.payload, { idempotencyKey: claimed.idempotencyKey }),
      );
      outcome = { status: 'accepted', providerId: sent.id, messageId: sent.messageId };
    } catch {
      outcome = { status: 'unknown' };
    }
    // Never resurrect a deleted workspace or overwrite a replacement dispatch.
    if (
      state.mailDispatches.some((d) => d.id === dispatchId && d.fingerprint === pending.fingerprint)
    )
      mutate((s) => {
        settleDispatch(s, dispatchId, outcome);
      });
  }
  const stillCurrent = (runId) =>
    active?.id === runId && state.run?.id === runId && state.run.status === 'running';
  async function execute(runId, snapshot, adapter, signal) {
    let position = 0;
    async function worker() {
      while (position < snapshot.companies.length && stillCurrent(runId)) {
        const index = position++,
          company = snapshot.companies[index],
          companySpan = id();
        let coverage = {
          company: company.name,
          status: 'checked',
          count: 0,
          note: '',
          checkedAt: new Date().toISOString(),
        };
        const results = [];
        try {
          const discovered = await auditStep(
            'discovery',
            {
              traceId: runId,
              spanId: companySpan,
              actor: auditActor('agent', 'discovery', snapshot.mode),
            },
            [auditProfile(snapshot.profile)],
            () =>
              adapter.discover(company, {
                signal,
                profile: snapshot.profile,
                onAudit: providerAuditCallback({
                  traceId: runId,
                  parentSpanId: companySpan,
                  companyCareers: company.careers,
                  actor: auditActor('agent', 'discovery', snapshot.mode),
                }),
              }),
          );
          if (!Array.isArray(discovered?.jobs)) throw Error('Bad discovery result');
          coverage.status = discovered.coverage === 'partial' ? 'partial' : 'checked';
          coverage.note = typeof discovered.note === 'string' ? discovered.note.slice(0, 500) : '';
          if (discovered.measurement)
            coverage.measurement = structuredClone(discovered.measurement);
          const atsLinks = Array.isArray(discovered.atsLinks) ? discovered.atsLinks : [];
          const seen = new Set();
          let excluded = 0;
          for (const raw of discovered.jobs.slice(0, 100)) {
            if (!stillCurrent(runId)) return;
            let job;
            try {
              validatePublicUrl(raw.url);
              job = validateJob(raw);
              if (!officialJob(company, job, atsLinks)) throw Error('Source not employer verified');
            } catch {
              recordAudit([
                auditEvent(
                  'normalization',
                  'rejected',
                  {
                    traceId: runId,
                    vacancyKey: hash(String(raw?.url ?? '').slice(0, 4096)),
                    actor: auditActor('system', 'source-validation', snapshot.mode),
                  },
                  {
                    reasonCode: 'unverified-source',
                    reason:
                      'Unsafe, unverified or unusable listing was excluded. No unsafe URL is retained or fetched.',
                  },
                ),
              ]);
              excluded++;
              continue;
            }
            const key = company.homepage + '|' + (job.id ?? job.url);
            if (seen.has(key)) {
              recordAudit([
                auditEvent(
                  'deduplication',
                  'rejected',
                  {
                    traceId: runId,
                    vacancyKey: auditIdentity(
                      { ...job, source: { linkedFrom: company.careers } },
                      snapshot.mode,
                    ),
                    actor: auditActor('system', 'deduplication', snapshot.mode),
                  },
                  {
                    reasonCode: 'duplicate-listing',
                    reason: 'Duplicate listing was excluded from this check.',
                  },
                ),
              ]);
              continue;
            }
            seen.add(key);
            if (results.length === 20) {
              coverage.status = 'partial';
              coverage.note = '20-listing limit reached; additional vacancies not assessed.';
              break;
            }
            const result = {
              ...job,
              key,
              company: company.name,
              companyIndustry: company.industry ?? '',
              source: {
                url: job.url,
                hash: hash(job.text),
                checkedAt: new Date().toISOString(),
                authority: snapshot.mode === 'fixture' ? 'fictional fixture' : 'employer source',
                linkedFrom: company.careers,
                discoveryEvidence: Array.isArray(raw.discoveryEvidence)
                  ? raw.discoveryEvidence.slice(0, 8).map((u) => validatePublicUrl(u).href)
                  : [],
              },
              assessment: null,
              category: null,
              error: null,
              evidencePolicy: EVIDENCE_POLICY,
              profileVersion: snapshot.profile.version,
            };
            const validated = {
              traceId: runId,
              parentSpanId: companySpan,
              vacancyKey: auditIdentity(result, snapshot.mode),
              actor: auditActor('system', 'source-validation', snapshot.mode),
            };
            const sourceSnapshot = auditJob(result);
            recordAudit(
              [
                auditEvent('normalization', 'accepted', validated, {
                  reasonCode: 'validated-listing',
                  reason: 'Listing shape and public employer source passed validation.',
                  snapshotRefs: [snapshotDigest(sourceSnapshot)],
                }),
                auditEvent(
                  'deduplication',
                  'accepted',
                  { ...validated, actor: auditActor('system', 'deduplication', snapshot.mode) },
                  {
                    reasonCode: 'unique-listing',
                    reason: 'This listing is unique within this source pass.',
                  },
                ),
              ],
              [sourceSnapshot],
            );
            try {
              const context = {
                traceId: runId,
                parentSpanId: companySpan,
                vacancyKey: auditIdentity(result, snapshot.mode),
                actor: auditActor('agent', 'assessment', snapshot.mode),
              };
              const proposed = await auditStep(
                'assessment',
                context,
                [auditProfile(snapshot.profile), auditJob(result)],
                () =>
                  adapter.assess(job, snapshot.profile, {
                    signal,
                    onAudit: providerAuditCallback(context),
                  }),
              );
              const a = validateAssessment(proposed, job, snapshot.profile);
              Object.assign(result, {
                assessment: a,
                ...classify(job, a, snapshot.profile, { industry: company.industry }),
              });
              const output = {
                kind: 'proposal',
                data: {
                  stage: 'assessment',
                  profileVersion: snapshot.profile.version,
                  assessment: a,
                  classification: Object.fromEntries(
                    [
                      'category',
                      'constraints',
                      'preferenceNotes',
                      'conditionState',
                      'evidenceFit',
                      'preferenceBand',
                      'experience',
                      'direction',
                      'levelReview',
                      'clarifications',
                      'intakeQuestions',
                    ]
                      .filter((key) => result[key] !== undefined)
                      .map((key) => [key, result[key]]),
                  ),
                },
              };
              recordAudit(
                [
                  auditEvent(
                    'recommendation',
                    result.category === 'Low priority' ? 'rejected' : 'proposed',
                    { ...context, actor: auditActor('system', 'classification', snapshot.mode) },
                    {
                      reasonCode: 'evidence-classification',
                      reason:
                        'Classification combines recorded requirement evidence, career preferences and vacancy restrictions. This is not a candidate decision or employer outcome.',
                      snapshotRefs: [snapshotDigest(output)],
                    },
                  ),
                ],
                [output],
              );
            } catch (error) {
              if (error?.status === 507 || error?.auditFailure) throw error;
              result.error =
                'Assessment unavailable: provider failed or evidence did not pass validation. Retry this check.';
              coverage.status = 'partial';
            }
            results.push(result);
          }
          if (excluded) {
            coverage.status = 'partial';
            coverage.note = `${excluded} unverified or unusable listings excluded. ${coverage.note}`;
          }
          if (!results.length && coverage.status === 'checked')
            coverage.note = 'No vacancies found in the checked source.';
        } catch (error) {
          if (error?.status === 507 || error?.auditFailure) throw error;
          coverage.status = 'unavailable';
          coverage.note =
            'Source unavailable. Try the check again; this does not mean there are no vacancies.';
        }
        coverage.count = results.length;
        if (!stillCurrent(runId)) return;
        mutate((s) => {
          s.run.coverage[index] = coverage;
          s.run.results.push(...results);
          for (const result of results) {
            const existing = s.opportunities.find(
              (o) => o.identity === opportunityKey(result, s.run.mode),
            );
            if (existing) observe(existing, result, s.run);
          }
          s.run.completedCompanies++;
        });
      }
    }
    try {
      await Promise.all([worker(), worker()]);
      if (stillCurrent(runId))
        mutate((s) => {
          s.run.status = s.run.coverage.every((c) => c.status === 'unavailable')
            ? 'failed'
            : s.run.coverage.some((c) => c.status !== 'checked')
              ? 'partial'
              : 'complete';
          s.run.finishedAt = new Date().toISOString();
        });
    } catch {
      if (stillCurrent(runId))
        try {
          mutate((s) => {
            s.run.status = 'failed';
            s.run.note = 'Could not save the check. Retry after checking local storage.';
          });
        } catch {
          active?.controller.abort();
        }
    }
  }
  function eraseWorkspace() {
    cancelPreparation();
    preparations.clear();
    active?.controller.abort();
    active = null;
    mutate(
      (s) => {
        const receipts = s.webhookReceipts,
          events = s.mailEvents;
        Object.assign(s, blank(), {
          webhookReceipts: receipts,
          mailEvents: events,
          mailReceivingPaused: true,
        });
      },
      { clearAudit: true },
    );
    workspaceGeneration++;
    importManager.invalidate(accountId);
    for (const backup of ['.pre-tracking.bak', '.pre-mail.bak'])
      if (existsSync(storeFile + backup)) unlinkSync(storeFile + backup);
  }
  const trustedRequests = new WeakSet();
  const handle = async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const host = req.headers.host ?? '';
    if (!trustedRequests.has(req) && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return send(403, { error: 'Local host required.' });
    const origin = trustedRequests.has(req) ? 'http://localhost' : `http://${host}`;
    if (
      !trustedRequests.has(req) &&
      req.method !== 'GET' &&
      (req.headers.origin !== origin ||
        !(req.headers['content-type'] ?? '').startsWith('application/json'))
    )
      return send(403, { error: 'Same-origin JSON request required.' });
    const path = new URL(req.url, origin).pathname;
    try {
      if (req.method === 'GET') {
        if (path.startsWith('/api/audit')) {
          if (!auditEnabled)
            return send(200, {
              available: false,
              reason: 'legacy-untracked',
              events: [],
              cursor: null,
            });
          const url = new URL(req.url, origin);
          if (path.startsWith('/api/audit/snapshots/')) {
            if (url.search) throw new MailError(400, 'Invalid snapshot query.');
            const digest = path.slice('/api/audit/snapshots/'.length);
            if (!/^[a-f0-9]{64}$/.test(digest))
              throw new MailError(400, 'Invalid snapshot identity.');
            const audit = storage.readSync(auditKey) ?? createAudit(),
              snapshot = audit.snapshots[digest];
            if (!snapshot) throw new MailError(404, 'Snapshot not found.');
            return send(200, snapshot);
          }
          if (!['/api/audit', '/api/audit/export'].includes(path))
            throw new MailError(404, 'Not found.');
          const { audit, filters } = auditFilters(url);
          if (path === '/api/audit/export') {
            const text = exportAudit(audit, filters);
            res.writeHead(200, {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'Content-Disposition': 'attachment; filename="rolemorrow-decision-history.jsonl"',
              'Cache-Control': 'no-store',
            });
            res.end(text);
            return;
          }
          return send(200, { available: true, version: 1, ...queryAudit(audit, filters) });
        }
        if (/^\/api\/applications\/[^/]+\/prepare\/status$/.test(path)) {
          const requestId = new URL(req.url, origin).searchParams.get('requestId');
          const record = preparations.get(requestId);
          if (!record || record.opportunityId !== path.split('/')[3])
            throw new MailError(404, 'Preparation not found.');
          return send(200, {
            requestId,
            opportunityId: record.opportunityId,
            status: record.status ?? 'running',
          });
        }
        if (path === '/api/state') return send(200, publicState());
        if (path === '/health') return send(200, { ok: true });
        if (path.startsWith('/api/application-files/') || path.startsWith('/api/message-files/')) {
          const [, , group, ownerId, fileId] = path.split('/');
          const owner =
            group === 'application-files'
              ? state.applications.find((a) => a.opportunityId === ownerId)
              : state.messages.find((m) => m.id === ownerId);
          const file =
            owner &&
            [...owner.files, ...(owner.history ?? []).flatMap((h) => h.files)].find(
              (f) => f.id === fileId,
            );
          if (!file) return send(404, { error: 'File not found.' });
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
          res.setHeader('Cache-Control', 'no-store');
          res.end(Buffer.from(file.base64, 'base64'));
          return;
        }
        const files = {
          '/': 'index.html',
          '/app.js': 'app.js',
          '/organization-catalog.js': 'organization-catalog.js',
          '/vacancy-browser.js': 'vacancy-browser.js',
          '/mail.js': 'mail.js',
          '/matching.js': 'matching.js',
          '/actions.js': 'actions.js',
          '/style.css': 'style.css',
        };
        if (!files[path]) return send(404, { error: 'Not found.' });
        const file = files[path];
        res.setHeader(
          'Content-Type',
          file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.js')
              ? 'text/javascript'
              : 'text/html; charset=utf-8',
        );
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(join(publicDir, file)));
        return;
      }
      let bytes = 0,
        chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (
          bytes >
          (path.startsWith('/api/applications/') || path === '/api/mail/intake' ? 1048576 : 64000)
        )
          return send(413, { error: 'Input too large.' });
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {
        return send(400, { error: 'Invalid JSON.' });
      }
      if (/^\/api\/applications\/[^/]+\/prepare\/cancel$/.test(path) && req.method === 'POST') {
        if (
          !body ||
          typeof body.requestId !== 'string' ||
          Object.keys(body).some((k) => !['requestId', 'baseRevision'].includes(k))
        )
          throw new MailError(400, 'Preparation request ID required.');
        const record = preparations.get(body.requestId);
        if (!record || record.opportunityId !== path.split('/')[3])
          throw new MailError(404, 'Preparation not found.');
        record.controller.abort(
          new MailError(409, 'Preparation cancelled. Your saved packet is unchanged.'),
        );
        return send(200, { cancelled: true });
      }
      if (/^\/api\/applications\/[^/]+\/prepare$/.test(path) && req.method === 'POST') {
        const input = validatePreparationRequest(body),
          opportunityId = path.split('/')[3];
        const o = state.opportunities.find((row) => row.id === opportunityId);
        if (!o) throw new MailError(404, 'Saved job not found.');
        if (!state.profile?.facts?.length)
          throw new MailError(
            400,
            'Save confirmed master-profile facts before preparing an application.',
          );
        const a = state.applications.find((row) => row.opportunityId === opportunityId);
        if (
          input.baseRevision !== state.revision ||
          input.profileVersion !== state.profile.version ||
          input.revision !== (a?.revision ?? 0)
        )
          throw new MailError(
            409,
            'Saved profile, vacancy or packet changed. Reload before preparing.',
          );
        const opportunityHash = preparationSnapshotHash(o.snapshot),
          generation = workspaceGeneration;
        const identity = hash({
          opportunityId,
          input: {
            baseRevision: input.baseRevision,
            revision: input.revision,
            profileVersion: input.profileVersion,
            questions: input.questions,
            consent: input.consent,
            requestId: input.requestId,
          },
          opportunityHash,
        });
        const admissionIdentity = preparationAdmissions.get(input.requestId);
        if (admissionIdentity !== undefined)
          throw new MailError(
            409,
            admissionIdentity === identity
              ? 'This preparation is awaiting admission. Retry the same request ID after it completes.'
              : 'Preparation request ID already belongs to different inputs.',
          );
        let record = preparations.get(input.requestId);
        if (!record && auditEnabled) {
          const prior = storage
            .readSync(auditKey)
            ?.events.find(
              (event) =>
                event.action === 'preparation:request' &&
                event.status === 'start' &&
                event.operationId === input.requestId,
            );
          if (prior) {
            if (prior.idempotencyKey !== identity)
              throw new MailError(
                409,
                'Preparation request ID already belongs to different or unverifiable inputs.',
              );
            throw new MailError(
              410,
              'This preparation already has a recorded attempt. Its outcome will not be replayed automatically. Review history and use a new request ID deliberately.',
            );
          }
        }
        const ownsRequest = !record;
        if (record && record.identity !== identity)
          throw new MailError(409, 'Preparation request ID already belongs to different inputs.');
        if (record?.evicted)
          throw new MailError(
            410,
            'This preparation result is no longer cached. Use a new request ID.',
          );
        if (!record) {
          if (preparing)
            throw new MailError(409, 'Another application preparation is already running.');
          if (preparations.size + preparationAdmissions.size >= 20)
            throw new MailError(
              429,
              'Preparation request limit reached for this workspace process. Restart deliberately before preparing more drafts.',
            );
          if (!preparationAvailable(o))
            throw new MailError(
              503,
              'Application preparation is unavailable. Your saved packet is unchanged.',
            );
          assertDelegation();
          preparationAdmissions.set(input.requestId, identity);
          let preparationAudit;
          try {
            preparationAudit = auditedContext(
              'preparation:request',
              {
                traceId: input.requestId,
                operationId: input.requestId,
                idempotencyKey: identity,
                opportunityId,
                vacancyKey: o.identity,
                actor: auditActor('agent', 'preparation', preparationMode(o)),
              },
              [auditProfile(state.profile), auditJob(o.snapshot)],
            );
            try {
              assertDelegation();
              await preparationQuota?.(input.requestId);
              assertDelegation();
              if (preparing || preparations.has(input.requestId))
                throw new MailError(
                  409,
                  'Another preparation began while reserving the budget. Retry the same request deliberately.',
                );
              const latestOpportunity = state.opportunities.find((row) => row.id === opportunityId);
              if (
                state.revision !== input.baseRevision ||
                state.profile?.version !== input.profileVersion ||
                !latestOpportunity ||
                preparationSnapshotHash(latestOpportunity.snapshot) !== opportunityHash
              )
                throw new MailError(
                  409,
                  'Workspace changed while reserving the preparation budget.',
                );
            } catch (error) {
              preparationAudit.finish('failed', {
                reasonCode: 'preparation-admission-refused',
                reason:
                  'Preparation admission was refused after reserving its history intent. No provider was called.',
              });
              throw error;
            }
          } finally {
            preparationAdmissions.delete(input.requestId);
          }
          const stages = new Map();
          const onAudit = async (event) => {
            if (
              !event ||
              ![
                'generation',
                'deterministic-check',
                'semantic-review',
                'repair',
                'fresh-review',
                'final-validation',
              ].includes(event.stage)
            )
              throw new MailError(400, 'Invalid internal preparation stage.');
            const context = {
              ...preparationAudit.context,
              spanId: id(),
              parentSpanId: preparationAudit.context.spanId,
              actor: auditActor(
                event.stage === 'deterministic-check' || event.stage === 'final-validation'
                  ? 'system'
                  : 'agent',
                event.stage,
                preparationMode(o),
                {
                  provider: event.provider ?? null,
                  model: event.model ?? null,
                  promptHash: event.promptHash ?? null,
                },
              ),
            };
            const snapshots = event.snapshot ? [event.snapshot] : [];
            if (event.status === 'start')
              stages.set(
                event.stage,
                auditedContext('preparation:' + event.stage, context, snapshots),
              );
            else {
              const step = stages.get(event.stage);
              if (!step) throw new MailError(400, 'Preparation stage has no recorded start.');
              step.finish(
                ['rejected', 'failed', 'cancelled', 'stale'].includes(event.status)
                  ? event.status
                  : 'observed',
                event.usage ? { usage: event.usage } : {},
                snapshots,
              );
              stages.delete(event.stage);
            }
          };
          const controller = new AbortController();
          record = { identity, opportunityId, controller, grantId: delegatedContext()?.grantId };
          preparations.set(input.requestId, record);
          preparing = record;
          const profile = structuredClone(state.profile),
            opportunity = structuredClone(o);
          const timeout = setTimeout(
            () =>
              controller.abort(
                new MailError(504, 'Preparation timed out. Your saved packet is unchanged.'),
              ),
            Math.min(PREPARATION_TIMING.http, Math.max(1, preparationTimeoutMs)),
          );
          record.promise = (async () => {
            try {
              const aborted = new Promise((resolve, reject) =>
                controller.signal.addEventListener(
                  'abort',
                  () => reject(controller.signal.reason),
                  { once: true },
                ),
              );
              const proposal = await Promise.race([
                Promise.resolve().then(() => {
                  assertDelegation();
                  return preparationProvider(opportunity).prepareApplication(
                    opportunity.snapshot,
                    profile,
                    input.questions,
                    { signal: controller.signal, onAudit },
                  );
                }),
                aborted,
              ]);
              controller.signal.throwIfAborted();
              assertDelegation();
              const current = storage ? storage.readSync('workspace:' + accountId) : state;
              const lifecycle = storage
                ? storage.readSync('lifecycle')?.records?.[accountId]
                : null;
              const authExists = storage
                ? storage.readSync('auth')?.users?.some((user) => user.id === accountId)
                : true;
              const accountActive = lifecycle
                ? lifecycle.active && authExists && lifecycle.generation === accountGeneration
                : authExists && accountGeneration === 0;
              const currentOpportunity = current?.opportunities?.find(
                (row) => row.id === opportunityId,
              );
              const currentPacket = current?.applications?.find(
                (row) => row.opportunityId === opportunityId,
              );
              if (
                preparationClosed ||
                generation !== workspaceGeneration ||
                !current ||
                current.profile?.version !== profile.version ||
                !currentOpportunity ||
                preparationSnapshotHash(currentOpportunity.snapshot) !== opportunityHash ||
                (currentPacket?.revision ?? 0) !== input.revision ||
                (storage && !accountActive)
              )
                throw new MailError(
                  409,
                  'Profile, vacancy, packet or account changed during preparation. Your saved packet is unchanged.',
                );
              const result = renderPreparation(proposal, profile, opportunity, input.questions, {
                method:
                  preparationMode(opportunity) === 'fixture'
                    ? 'fixture-grounded-documents-v2'
                    : 'nebius-grounded-documents-v2',
              });
              preparationAudit.finish('accepted', {}, [
                {
                  kind: 'packet',
                  data: {
                    cvVersion: result.draft.cvVersion,
                    cvText: result.draft.cvText,
                    coverLetter: result.draft.coverLetter,
                    answers: result.draft.answers,
                    profileVersion: profile.version,
                    opportunityHash,
                    files: [],
                  },
                },
              ]);
              record.status = 'complete';
              record.bytes = Buffer.byteLength(JSON.stringify(result));
              const retained = () =>
                [...preparations.values()].reduce((n, r) => n + (r.bytes || 0), 0);
              for (const previous of preparations.values()) {
                if (retained() <= 2 * 1024 * 1024) break;
                if (previous !== record && previous.bytes) {
                  previous.evicted = true;
                  previous.bytes = 0;
                  previous.promise = null;
                }
              }
              return result;
            } catch (error) {
              record.status = controller.signal.aborted ? 'cancelled' : 'failed';
              const status = controller.signal.aborted
                ? 'cancelled'
                : error?.status === 409
                  ? 'stale'
                  : 'failed';
              try {
                for (const step of stages.values()) step.finish(status);
                preparationAudit.finish(
                  status,
                  controller.signal.reason?.status === 504 ||
                    ['PREPARATION_STAGE_TIMEOUT', 'PREPARATION_TOTAL_TIMEOUT'].includes(error.code)
                    ? {
                        reasonCode:
                          error.code === 'PREPARATION_STAGE_TIMEOUT'
                            ? 'preparation-stage-timeout'
                            : 'preparation-timeout',
                        reason: 'Preparation timed out; the provider outcome is not inferred.',
                      }
                    : {},
                );
              } catch (auditError) {
                throw auditError;
              }
              if (error.status === 507)
                throw new MailError(
                  507,
                  'Decision history capacity reached. The draft was not accepted; the exact output snapshot is unavailable.',
                );
              if (error instanceof MailError) throw error;
              throw new MailError(
                502,
                'Application preparation failed. Your saved packet is unchanged. Retry deliberately with a new request ID.',
              );
            } finally {
              clearTimeout(timeout);
              if (preparing === record) preparing = null;
            }
          })();
        }
        const disconnect = () => {
          if (!res.writableEnded)
            record.controller.abort(
              new MailError(409, 'Preparation disconnected. Your saved packet is unchanged.'),
            );
        };
        if (ownsRequest) res.once('close', disconnect);
        try {
          return send(200, await record.promise);
        } finally {
          if (ownsRequest) res.removeListener('close', disconnect);
        }
      }
      if (body.baseRevision !== undefined && body.baseRevision !== state.revision)
        return send(409, { error: 'Another window changed this search. Reload before saving.' });
      if (path === '/api/catalog-opportunities' && req.method === 'POST') {
        if (!state.profile)
          return send(400, { error: 'Save your profile before reviewing catalog evidence.' });
        if (!Number.isInteger(body.baseRevision) || body.baseRevision !== state.revision)
          return send(409, { error: 'Workspace changed. Reload before saving.' });
        const row = await catalogVacancies?.get(body.vacancyId);
        if (!row) return send(404, { error: 'Cached vacancy unavailable.' });
        const snapshot = cachedSnapshot(row, state.profile);
        mutate((s) => saveOpportunity({ ...s, run: { mode: 'catalog' } }, snapshot));
        return send(200, publicState());
      }
      if (path === '/api/mail/simulated-reply' && req.method === 'POST') {
        if (env.CONTROLLED_LOCAL_MODE !== '1') return send(404, { error: 'Not found.' });
        mutate((s) => simulateReply(s, body));
        return send(200, publicState());
      }
      if (path === '/api/mail/dispatches' && req.method === 'POST') {
        if (
          body.kind === 'reply' &&
          state.messages.find((m) => m.id === body.messageId)?.origin === 'gmail-import'
        )
          throw new MailError(
            400,
            'Historical Gmail evidence is read-only. Reply in the source mailbox.',
          );
        if (env.CONTROLLED_LOCAL_MODE === '1') {
          mutate((s) => simulateDispatch(s, body));
          return send(200, publicState());
        }
        if (!sendReady())
          return send(503, { error: 'Live sending is not configured. Nothing was sent.' });
        let d;
        mutate((s) => {
          d = prepareDispatch(s, body, {
            sender: env.MAIL_FROM,
            replyDomain: env.MAIL_REPLY_DOMAIN,
            aliasPrefix: env.MAIL_ALIAS_PREFIX,
          });
          allowedRecipient(d.to);
        });
        if (d.status === 'prepared') await transmit(d.id);
        return send(200, publicState());
      }
      if (/^\/api\/mail\/dispatches\/[^/]+\/retry$/.test(path) && req.method === 'POST') {
        if (!sendReady())
          return send(503, { error: 'Live sending is not configured. Nothing was sent.' });
        const d = state.mailDispatches.find((d) => d.id === path.split('/')[4]);
        if (!d) return send(404, { error: 'Dispatch not found.' });
        if (body.confirm !== true)
          return send(400, { error: 'Confirm retrying the unchanged saved snapshot.' });
        if (body.revision !== d.revision)
          return send(409, { error: 'Dispatch changed. Reload before retrying.' });
        if (d.status !== 'unknown')
          return send(409, { error: 'Only an unknown outcome can be retried here.' });
        allowedRecipient(d.to);
        await transmit(d.id);
        return send(200, publicState());
      }
      if (/^\/api\/mail\/notifications\/[^/]+$/.test(path) && req.method === 'POST') {
        mutate((s) => markNotification(s, path.split('/')[4], body));
        return send(200, publicState());
      }
      if (
        (path.startsWith('/api/applications/') || path.startsWith('/api/mail/')) &&
        req.method === 'POST'
      ) {
        if (
          path.startsWith('/api/applications/') &&
          (body.preparedProfileVersion !== undefined || body.preparedOpportunityHash !== undefined)
        ) {
          const o = state.opportunities.find((row) => row.id === path.split('/')[3]);
          if (
            body.preparedProfileVersion !== state.profile?.version ||
            !o ||
            body.preparedOpportunityHash !== preparationSnapshotHash(o.snapshot)
          )
            throw new MailError(
              409,
              'The prepared draft refers to an older profile or vacancy. Prepare again before saving.',
            );
        }
        const packetLink = path.startsWith('/api/applications/')
          ? verifiedPacketLink(path.split('/')[3], body)
          : null;
        mutate((s) => mailAction(s, path, body), { packetLink });
        return send(200, publicState());
      }
      if (path === '/api/opportunities' && req.method === 'POST') {
        if (!Number.isInteger(body.baseRevision))
          return send(400, { error: 'Workspace revision required. Reload before saving.' });
        const result = state.run?.results.find((r) => r.key === body.resultKey);
        if (!result) return send(404, { error: 'Result no longer available. Reload Results.' });
        const existing = state.opportunities.find(
          (o) => o.identity === opportunityKey(result, state.run.mode),
        );
        if (existing) return send(200, publicState());
        if (state.opportunities.length >= 500)
          return send(400, { error: 'Saved job limit reached (500).' });
        mutate((s) => saveOpportunity(s, result));
        return send(200, publicState());
      }
      if (/^\/api\/opportunities\/[^/]+\/source-review$/.test(path) && req.method === 'POST') {
        const o = state.opportunities.find((v) => v.id === path.split('/')[3]);
        if (!o) return send(404, { error: 'Saved job not found.' });
        if (
          !Number.isInteger(body.sourceCheckRevision) ||
          body.sourceCheckRevision !== o.sourceCheckRevision
        )
          return send(409, {
            error: 'Source observation changed. Review the latest check before acknowledging it.',
          });
        mutate((s) => {
          const item = s.opportunities.find((v) => v.id === o.id);
          item.sourceReviewRequired = false;
          item.sourceReviewedAt = new Date().toISOString();
        });
        return send(200, publicState());
      }
      if (/^\/api\/opportunities\/[^/]+\/recheck$/.test(path) && req.method === 'POST') {
        const opportunityId = path.split('/')[3],
          o = state.opportunities.find((v) => v.id === opportunityId);
        if (!o) return send(404, { error: 'Saved job not found.' });
        if (!o.snapshot?.url)
          return send(400, {
            error:
              'This imported vacancy has no verified public posting URL. Review the original source; no request was made.',
          });
        if (o.runMode !== 'fixture' && (env.ALLOW_LIVE !== '1' || body.consent !== true))
          return send(403, {
            error:
              'Enable live access and confirm checking this public source. No profile is transmitted.',
          });
        if (o.snapshot.source.authority === 'user-supplied unverified')
          return send(400, {
            error: 'Unverified descriptions cannot be checked as official postings.',
          });
        if (sourceChecks.size >= 2 || sourceChecks.has(o.id))
          return send(409, { error: 'This vacancy source is already being checked.' });
        sourceChecks.add(o.id);
        const original = hash(o.snapshot);
        try {
          const copy = structuredClone(o);
          const read = providers?.recheck
            ? (_url, options) => providers.recheck(copy, options)
            : o.runMode === 'fixture'
              ? async () => ({
                  url: o.snapshot.url,
                  text: `${o.snapshot.title}. ${o.snapshot.text}`,
                })
              : undefined;
          const observation = await auditStep(
            'source-check',
            {
              opportunityId: o.id,
              vacancyKey: o.identity,
              actor: auditActor('system', 'source-check', o.runMode),
            },
            [auditJob(o.snapshot)],
            () => checkSavedSource(copy, { read, signal: AbortSignal.timeout(22000) }),
          );
          const current = state.opportunities.find((v) => v.id === o.id);
          if (!current || hash(current.snapshot) !== original)
            return send(409, {
              error: 'Saved source changed during the check. Retry on the current record.',
            });
          mutate((s) => {
            const item = s.opportunities.find((v) => v.id === o.id);
            item.sourceCheck = observation;
            item.sourceCheckRevision = (item.sourceCheckRevision ?? 0) + 1;
            if (['changed', 'possibly-closed', 'not-found'].includes(observation.status))
              item.sourceReviewRequired = true;
            if (observation.contentHash) item.lastReadableSourceCheck = observation;
            item.sourceCheckHistory = [...(item.sourceCheckHistory ?? []), observation].slice(-20);
          });
          return send(200, publicState());
        } finally {
          sourceChecks.delete(o.id);
        }
      }
      if (path.startsWith('/api/opportunities/') && req.method === 'POST') {
        const opportunity = state.opportunities.find(
          (o) => o.id === path.slice('/api/opportunities/'.length),
        );
        if (!opportunity) return send(404, { error: 'Saved job not found. Reload saved jobs.' });
        const decision = validateDecision(body);
        if (body.decisionRevision !== opportunity.decisionRevision)
          return send(409, {
            error:
              'Another window updated this decision. Your draft is kept; reload saved jobs before saving again.',
          });
        mutate((s) => {
          const o = s.opportunities.find((v) => v.id === opportunity.id);
          const now = new Date().toISOString();
          if (o.stage !== decision.stage)
            o.events.push({ at: now, stage: decision.stage, origin: 'candidate' });
          Object.assign(o, decision, { decisionRevision: o.decisionRevision + 1, updatedAt: now });
        });
        return send(200, publicState());
      }
      if (path === '/api/profile' && req.method === 'POST') {
        const p = validateProfile(body);
        active?.controller.abort();
        active = null;
        mutate((s) => {
          s.profile = { ...p, version: hash(p), savedAt: new Date().toISOString() };
          if (s.run) {
            s.run.stale = true;
            if (s.run.status === 'running') s.run.status = 'cancelled';
          }
        });
        return send(200, publicState());
      }
      if (path === '/api/companies' && req.method === 'POST') {
        if (
          !Array.isArray(body.companies) ||
          body.companies.length < 1 ||
          body.companies.length > 5
        )
          return send(400, { error: 'Choose between one and five companies.' });
        const companies = body.companies.map((c) => {
          const homepage = validatePublicUrl(c.homepage),
            careers = validatePublicUrl(c.careers);
          if (
            homepage.hostname.replace(/^www\./, '') !== careers.hostname.replace(/^www\./, '') &&
            !careers.hostname.endsWith('.' + homepage.hostname.replace(/^www\./, ''))
          )
            throw Error(
              'Careers URL must belong to the official homepage. Linked ATS pages are discovered from there.',
            );
          const name = cleanText(c.name, 100),
            industry = cleanText(c.industry ?? '', 150);
          if (!name) throw Error('Add a company name.');
          return {
            name,
            homepage: homepage.href.replace(/\/$/, ''),
            careers: careers.href,
            industry,
          };
        });
        for (const company of companies) {
          const organization = await organizationCatalog?.resolve(company);
          if (organization) {
            company.organizationId = organization.id;
            company.name = organization.name;
            company.homepage = organization.homepage;
            company.catalogDomain = organization.domain;
          }
        }
        if (new Set(companies.map((c) => c.organizationId ?? c.homepage)).size !== companies.length)
          throw Error('Remove duplicate companies.');
        active?.controller.abort();
        active = null;
        mutate((s) => {
          s.companies = companies;
          if (s.run) {
            s.run.stale = true;
            if (s.run.status === 'running') s.run.status = 'cancelled';
          }
        });
        try {
          await onCompaniesSaved?.(companies);
        } catch {
          console.error('Company catalog suggestion unavailable.');
        }
        return send(200, publicState());
      }
      if (path === '/api/scans' && req.method === 'POST') {
        if (!state.profile || !state.companies.length)
          return send(400, {
            error: 'Save your profile, career goal and companies before checking.',
          });
        if (!['fixture', 'live'].includes(body.mode))
          return send(400, { error: 'Choose a supported search mode.' });
        if (body.mode === 'live' && (!publicState().config.liveReady || body.consent !== true))
          return send(403, {
            error:
              'Live search is disabled. Server authorization, both keys, NVIDIA model and your data-sharing confirmation are required.',
          });
        active?.controller.abort();
        const runId = id(),
          controller = new AbortController();
        active = { id: runId, controller };
        const snapshot = {
          profile: structuredClone(state.profile),
          companies: structuredClone(state.companies),
          mode: body.mode,
        };
        mutate((s) => {
          if (s.run) s.history = [...s.history, s.run].slice(-5);
          s.run = {
            id: runId,
            mode: body.mode,
            evidencePolicy: EVIDENCE_POLICY,
            models:
              body.mode === 'live'
                ? {
                    extraction: env.NEBIUS_MODEL,
                    assessment: env.NEBIUS_ASSESSMENT_MODEL || env.NEBIUS_MODEL,
                  }
                : null,
            status: 'running',
            stale: false,
            profileVersion: s.profile.version,
            companyVersion: hash(s.companies),
            startedAt: new Date().toISOString(),
            ...(body.mode === 'live'
              ? {
                  authorization: {
                    kind: 'live-profile-check',
                    version: AI_PERMISSION_VERSION,
                    approvedAt: new Date().toISOString(),
                    profileVersion: s.profile.version,
                    companyVersion: hash(s.companies),
                    scope: 'Saved career profile to Nebius; employer and target role to Tavily',
                    status: 'approved-request',
                  },
                }
              : {}),
            coverage: s.companies.map((c) => ({
              company: c.name,
              status: 'pending',
              count: 0,
              note: '',
            })),
            results: [],
            completedCompanies: 0,
          };
        });
        send(202, publicState());
        const adapter =
          providers ?? (body.mode === 'fixture' ? createFixtureProviders() : getProviders({ env }));
        setImmediate(() => execute(runId, snapshot, adapter, controller.signal));
        return;
      }
      if (path === '/api/intake/url' && req.method === 'POST') {
        if (!Number.isInteger(body.baseRevision))
          return send(400, { error: 'Workspace revision required. Reload before saving.' });
        if (body.readSource === true && (env.ALLOW_LIVE !== '1' || body.consent !== true))
          return send(403, {
            error:
              'Enable live access and confirm reading this public URL. No profile is transmitted.',
          });
        const revision = state.revision,
          workspace = state;
        const result = await externalListing(body, { read: providers?.readExternal });
        if (workspace !== state || revision !== state.revision)
          return send(409, {
            error: 'Workspace changed while reading this URL. Reload and retry.',
          });
        const identity = (r) =>
          opportunityKey({ ...r, source: { ...r.source, linkedFrom: null } }, 'manual');
        if (
          state.opportunities.some(
            (o) => o.runMode !== 'fixture' && identity(o.snapshot) === identity(result),
          )
        )
          return send(200, publicState());
        if (state.opportunities.length >= 500)
          return send(400, { error: 'Saved job limit reached (500).' });
        mutate((s) => {
          result.profileVersion = s.profile?.version ?? null;
          saveOpportunity({ ...s, run: { mode: 'manual' } }, result);
        });
        return send(200, publicState());
      }
      if (path === '/api/manual' && req.method === 'POST') {
        if (!state.profile || !state.companies.length)
          return send(400, { error: 'Save your profile and companies first.' });
        if (state.run?.status === 'running')
          return send(409, {
            error: 'Wait for this check to finish, or cancel it before adding text.',
          });
        const company = state.companies.find((c) => c.name === body.company);
        if (!company) throw Error('Unknown selected company.');
        const title = cleanText(body.title, 250),
          text = cleanText(body.text, 40000),
          url = validatePublicUrl(body.url).href;
        if (!title || !text) throw Error('Job title and public description are required.');
        if ((state.run?.results.length ?? 0) >= 100)
          return send(400, { error: 'Saved listing limit reached. Start a new check.' });
        mutate((s) => {
          if (!s.run)
            s.run = {
              id: id(),
              mode: 'manual',
              status: 'partial',
              stale: false,
              profileVersion: s.profile.version,
              companyVersion: hash(s.companies),
              startedAt: new Date().toISOString(),
              ...(body.mode === 'live'
                ? {
                    authorization: {
                      kind: 'live-profile-check',
                      version: AI_PERMISSION_VERSION,
                      approvedAt: new Date().toISOString(),
                      profileVersion: s.profile.version,
                      companyVersion: hash(s.companies),
                      scope: 'Saved career profile to Nebius; employer and target role to Tavily',
                      status: 'approved-request',
                    },
                  }
                : {}),
              coverage: [],
              results: [],
              completedCompanies: 0,
            };
          s.run.status = 'partial';
          const key = 'manual-' + id();
          s.run.results.push({
            id: key,
            key,
            title,
            text,
            url,
            company: company.name,
            requirements: [],
            countries: [],
            workMode: 'unknown',
            salary: null,
            assessment: null,
            category: null,
            error:
              'User-supplied text, unverified. Automated assessment has not run. Review the employer source before relying on this description.',
            source: {
              url,
              hash: hash(text),
              checkedAt: new Date().toISOString(),
              authority: 'user-supplied unverified',
              linkedFrom: null,
            },
            profileVersion: s.profile.version,
          });
          s.run.coverage.push({
            company: company.name,
            status: 'unverified',
            count: 1,
            note: 'Manually supplied public description; availability and contents not verified.',
          });
        });
        return send(200, publicState());
      }
      if (path === '/api/cancel' && req.method === 'POST') {
        active?.controller.abort();
        active = null;
        mutate((s) => {
          if (s.run?.status === 'running') {
            s.run.status = 'cancelled';
            s.run.note =
              'Cancelled. Completed results retained; unfinished companies were not checked.';
          }
        });
        return send(200, publicState());
      }
      if (path === '/api/data' && req.method === 'DELETE') {
        eraseWorkspace();
        return send(200, publicState());
      }
      send(404, { error: 'Not found.' });
    } catch (error) {
      send(
        error instanceof MailError
          ? error.status
          : Number.isInteger(error.status)
            ? error.status
            : 400,
        {
          error:
            error?.status === 507
              ? 'Decision history capacity reached. New tracked work is stopped; reading and exporting remain available.'
              : error instanceof MailError
                ? error.message
                : path === '/api/profile' ||
                    path === '/api/companies' ||
                    path === '/api/intake/url' ||
                    path.startsWith('/api/opportunities')
                  ? error.message
                  : 'Unable to complete this action. Check your inputs and retry.',
        },
      );
    }
  };
  // Only this separate port can be published behind an HTTPS webhook edge.
  // It serves no application UI, files, state, or user mutation endpoints.
  const webhookInFlight = new Set();
  const server = http.createServer(handle);
  server.businessCall = (context, method, url, body) =>
    withDelegation(
      context,
      () =>
        new Promise((resolve, reject) => {
          try {
            context.assertActive();
          } catch (error) {
            reject(error);
            return;
          }
          const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
          Object.assign(req, { method, url, headers: {}, socket: {} });
          trustedRequests.add(req);
          const res = new EventEmitter();
          let status = 200;
          res.writableEnded = false;
          res.setHeader = () => {};
          res.writeHead = (code) => {
            status = code;
          };
          res.end = (text) => {
            res.writableEnded = true;
            try {
              const data = JSON.parse(text);
              if (status >= 400)
                reject(Object.assign(Error(data.error ?? 'Action refused.'), { status }));
              else {
                context.assertActive();
                resolve(data);
              }
            } catch (error) {
              reject(error);
            }
          };
          Promise.resolve(handle(req, res)).catch(reject);
        }),
    );
  server.cancelDelegation = (grantId) => {
    for (const record of preparations.values())
      if (record.grantId === grantId)
        record.controller.abort(new MailError(401, 'Connection revoked.'));
  };
  server.ingress = http.createServer(async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || req.url !== '/hooks/resend')
      return respond(404, { error: 'Not found.' });
    if (!env.RESEND_WEBHOOK_SECRET) return respond(503, { error: 'Webhook is not configured.' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
      return respond(415, { error: 'JSON required.' });
    let signed, raw;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262144) return respond(413, { error: 'Event too large.' });
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks);
      signed = verifyResendWebhook(raw, req.headers, env.RESEND_WEBHOOK_SECRET);
    } catch {
      return respond(401, { error: 'Invalid event signature or payload.' });
    }
    const fingerprint = hash(raw),
      prior = state.webhookReceipts.find((r) => r.id === signed.id);
    // Deletion revokes importing new mail. Acknowledge valid deliveries without fetching
    // their private bodies; retain only bounded replay identities, never correspondence.
    if (state.mailReceivingPaused && signed.event.type === 'email.received') {
      if (prior && prior.hash !== fingerprint) return respond(409, { received: false });
      try {
        if (!prior && state.webhookReceipts.length < 1000)
          mutate((s) => {
            s.webhookReceipts.push({
              id: signed.id,
              hash: fingerprint,
              receivedAt: new Date().toISOString(),
              discarded: true,
            });
          });
      } catch {
        return respond(503, { error: 'Event could not be stored.' });
      }
      return respond(200, { received: true, discarded: true });
    }
    if (prior)
      return respond(prior.hash === fingerprint ? 200 : 409, {
        received: prior.hash === fingerprint,
      });
    if (webhookInFlight.has(signed.id) || webhookInFlight.size >= 2)
      return respond(503, { error: 'Event processing busy; retry.' });
    webhookInFlight.add(signed.id);
    const generation = workspaceGeneration;
    try {
      if (state.webhookReceipts.length >= 1000)
        throw new MailError(503, 'Webhook retention limit reached.');
      const event = signed.event;
      let received;
      if (event.type === 'email.received') {
        if (!receiveReady()) throw new MailError(503, 'Receiving credentials are not configured.');
        received = await transport.receive(event.data?.email_id);
        if (received.providerId !== event.data?.email_id)
          throw new MailError(400, 'Received email identity mismatch.');
        if (env.MAIL_ALIAS_PREFIX) {
          const aliases = (received.to ?? []).filter(
            (to) =>
              typeof to === 'string' &&
              to.toLowerCase().endsWith('@' + env.MAIL_REPLY_DOMAIN.toLowerCase()),
          );
          const own = 'op-' + env.MAIL_ALIAS_PREFIX;
          if (
            !aliases.some((to) => to.toLowerCase().startsWith(own)) ||
            aliases.some((to) => !to.toLowerCase().startsWith(own))
          )
            received = null;
        }
        if (
          received &&
          (!Array.isArray(received.to) ||
            !received.to.some(
              (to) =>
                typeof to === 'string' &&
                to.toLowerCase().endsWith('@' + env.MAIL_REPLY_DOMAIN.toLowerCase()),
            ))
        )
          received = null;
      }
      if (generation !== workspaceGeneration)
        throw new MailError(409, 'Workspace deleted during receiving.');
      mutate((s) => {
        if (s.webhookReceipts.length >= 1000)
          throw new MailError(503, 'Webhook retention limit reached.');
        if (received)
          receiveResend(s, received, {
            replyDomain: env.MAIL_REPLY_DOMAIN,
            aliasPrefix: env.MAIL_ALIAS_PREFIX,
          });
        else if (['email.delivered', 'email.bounced', 'email.failed'].includes(event.type))
          deliveryEvent(s, {
            id: signed.id,
            providerId: event.data?.email_id,
            type: event.type.slice(6),
          });
        s.webhookReceipts.push({
          id: signed.id,
          hash: fingerprint,
          receivedAt: new Date().toISOString(),
        });
      });
      respond(200, { received: true });
    } catch (error) {
      respond(error instanceof MailError ? error.status : 503, {
        error: 'Event could not be stored. Retry or inspect configuration.',
      });
    } finally {
      webhookInFlight.delete(signed.id);
    }
  });
  server.importAction = async (owner, method, body, { assertActive } = {}) => {
    if (!owner || owner.accountId !== accountId || typeof assertActive !== 'function')
      throw new MailError(403, 'Verified import authority required.');
    const check = () => {
      assertActive();
      if (preparationClosed) throw new MailError(409, 'Workspace is closed.');
      const life = storage?.readSync('lifecycle')?.records?.[accountId];
      if (life && (!life.active || life.generation !== accountGeneration))
        throw new MailError(401, 'Account no longer exists.');
    };
    check();
    const actualOwner = { ...owner, generation: workspaceGeneration };
    if (!['begin', 'chunk', 'preview', 'commit', 'progress', 'cancel'].includes(method))
      throw new MailError(404, 'Not found.');
    const result =
      method === 'commit'
        ? await importManager.commit(actualOwner, body, {
            getState: () => state,
            mutate: (change, options) => {
              check();
              mutate(change, options);
            },
            assertActive: check,
          })
        : importManager[method](actualOwner, body, state);
    check();
    return result;
  };
  server.eraseWorkspace = eraseWorkspace;
  server.on('close', () => {
    preparationClosed = true;
    if (!suppliedImportManager) importManager.close();
    cancelPreparation();
    preparations.clear();
    active?.controller.abort();
    active = null;
    if (server.ingress.listening) server.ingress.close();
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const port = Number(process.env.PORT ?? 3027);
  server.listen(port, '127.0.0.1', () =>
    console.log(`Career Search: http://127.0.0.1:${port} (local only)`),
  );
}
