import { withDelegation } from './mcp-context.mjs';
import { z } from 'zod';
const id = z.string().min(1).max(100),
  rev = z.number().int().nonnegative(),
  short = z.string().max(200),
  empty = z.object({}).strict();
export function registerMcpTools(server, { access, context, call, search, storage, importAction }) {
  const tool = (name, scope, schema, fn) =>
    server.registerTool(
      name,
      {
        description: name.replaceAll('_', ' '),
        inputSchema: schema,
        annotations: {
          readOnlyHint: scope === 'mcp:read',
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          access.assertActive(context, [scope]);
          const scopedContext = {
            ...context,
            assertActive: () => access.assertActive(context, [scope]),
          };
          const data = await withDelegation(scopedContext, () => fn(args));
          access.assertActive(context, [scope]);
          const result = {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
          };
          if (Buffer.byteLength(JSON.stringify(result)) > 480 * 1024)
            throw Object.assign(
              Error('Result too large. Use a more specific tool or smaller page.'),
              { status: 413 },
            );
          return result;
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  error.status && error.status < 500
                    ? error.message
                    : 'Unable to complete this action.',
              },
            ],
          };
        }
      },
    );
  const state = () => call('GET', '/api/state');
  const uuid = z.string().uuid(),
    batch = z.object({ batchId: uuid }).strict();
  tool(
    'begin_import',
    'mcp:import',
    z
      .object({
        batchId: uuid,
        sourceAccount: z.string().min(1).max(254),
        items: z
          .array(
            z
              .object({
                itemId: uuid,
                kind: z.enum(['vacancy', 'message']),
                bytes: z.number().int().min(1).max(1048576),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                chunks: z.number().int().min(1).max(128),
                subject: z.string().max(250).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(60),
      })
      .strict(),
    (a) => importAction('begin', a),
  );
  tool(
    'stage_import_chunk',
    'mcp:import',
    z
      .object({
        batchId: uuid,
        itemId: uuid,
        index: z.number().int().min(0).max(127),
        data: z.string().min(1).max(65536),
      })
      .strict(),
    (a) => importAction('chunk', a),
  );
  tool(
    'preview_import',
    'mcp:import',
    z
      .object({
        batchId: uuid,
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    (a) => importAction('preview', a),
  );
  tool(
    'commit_import',
    'mcp:import',
    z
      .object({
        batchId: uuid,
        previewHash: z.string().regex(/^[a-f0-9]{64}$/),
        itemIds: z.array(uuid).min(1).max(60),
      })
      .strict(),
    (a) => importAction('commit', a),
  );
  tool('get_import_progress', 'mcp:import', batch, (a) => importAction('progress', a));
  tool('cancel_import', 'mcp:import', batch, (a) => importAction('cancel', a));
  tool('get_profile', 'mcp:read', empty, async () => ({ profile: (await state()).profile }));
  tool('get_workspace', 'mcp:read', empty, state);
  tool(
    'search_vacancies',
    'mcp:read',
    z
      .object(
        Object.fromEntries(
          [
            'q',
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
            'organizationId',
            'status',
            'offset',
          ].map((k) => [k, short.optional()]),
        ),
      )
      .strict(),
    search,
  );
  tool(
    'list_saved_vacancies',
    'mcp:read',
    z
      .object({ offset: rev.optional(), limit: z.number().int().min(1).max(100).optional() })
      .strict(),
    async (a) => ({
      opportunities: (await state()).opportunities.slice(
        a.offset ?? 0,
        (a.offset ?? 0) + (a.limit ?? 100),
      ),
    }),
  );
  tool(
    'save_vacancy',
    'mcp:write',
    z
      .object({ resultKey: id.optional(), vacancyId: id.optional(), baseRevision: rev })
      .strict()
      .refine((a) => Boolean(a.resultKey) !== Boolean(a.vacancyId), 'Choose one vacancy identity.'),
    (a) => call('POST', a.vacancyId ? '/api/catalog-opportunities' : '/api/opportunities', a),
  );
  tool('get_application', 'mcp:read', z.object({ opportunityId: id }).strict(), async (a) => {
    const s = await state();
    const opportunity = s.opportunities.find((o) => o.id === a.opportunityId);
    if (!opportunity) throw Object.assign(Error('Application not found.'), { status: 404 });
    return {
      opportunity,
      application: s.applications.find((x) => x.opportunityId === a.opportunityId) ?? null,
      messages: s.messages.filter((x) => x.opportunityId === a.opportunityId),
      notifications: s.notifications.filter((x) => x.opportunityId === a.opportunityId),
    };
  });
  tool(
    'save_application',
    'mcp:write',
    z
      .object({
        opportunityId: id,
        revision: rev,
        cvVersion: z.string().max(150),
        cvText: z.string().max(20000),
        coverLetter: z.string().max(10000),
        answers: z.string().max(10000),
        preparedRequestId: id.optional(),
        preparedProfileVersion: id.optional(),
        preparedOpportunityHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    async ({ opportunityId, ...body }) => {
      const packet = storage
        .readSync('workspace:' + context.accountId)
        ?.applications.find((x) => x.opportunityId === opportunityId);
      return call('POST', '/api/applications/' + opportunityId, {
        ...body,
        files: packet?.files ?? [],
      });
    },
  );
  tool(
    'prepare_application',
    'mcp:prepare',
    z
      .object({
        opportunityId: id,
        requestId: z.string().uuid(),
        baseRevision: rev,
        revision: rev,
        profileVersion: id,
        questions: z.array(z.string().min(1).max(1000)).max(10),
        consent: z.literal(true),
      })
      .strict(),
    ({ opportunityId, ...body }) =>
      call('POST', '/api/applications/' + opportunityId + '/prepare', body),
  );
  tool(
    'get_preparation_status',
    'mcp:read',
    z.object({ opportunityId: id, requestId: z.string().uuid() }).strict(),
    (a) =>
      call(
        'GET',
        '/api/applications/' + a.opportunityId + '/prepare/status?requestId=' + a.requestId,
      ),
  );
  tool(
    'cancel_preparation',
    'mcp:prepare',
    z
      .object({ opportunityId: id, requestId: z.string().uuid(), baseRevision: rev.optional() })
      .strict(),
    ({ opportunityId, ...body }) =>
      call('POST', '/api/applications/' + opportunityId + '/prepare/cancel', body),
  );
  tool(
    'get_decision_history',
    'mcp:read',
    z
      .object({
        vacancyKey: z.string().max(1000).optional(),
        opportunityId: id.optional(),
        applicationAttemptId: id.optional(),
        actorRole: id.optional(),
        errorsOnly: z.boolean().optional(),
        after: rev.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    (a) =>
      call(
        'GET',
        '/api/audit?' + new URLSearchParams(Object.entries(a).map(([k, v]) => [k, String(v)])),
      ),
  );
  tool(
    'list_notifications',
    'mcp:read',
    z
      .object({ offset: rev.optional(), limit: z.number().int().min(1).max(100).optional() })
      .strict(),
    async (a) => ({
      notifications: (await state()).notifications.slice(
        a.offset ?? 0,
        (a.offset ?? 0) + (a.limit ?? 100),
      ),
    }),
  );
  tool(
    'set_notification_read',
    'mcp:write',
    z.object({ notificationId: id, revision: rev, read: z.boolean() }).strict(),
    ({ notificationId, revision, read }) =>
      call('POST', '/api/mail/notifications/' + notificationId, { revision, read }),
  );
  tool(
    'get_updates',
    'mcp:read',
    z
      .object({
        cursor: z.string().max(512).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    async (a) => {
      const audit = storage.readSync('audit:' + context.accountId),
        events = audit?.events ?? [],
        epoch = access.syncHistoryEpoch(context.accountId, events[0]?.hash ?? ''),
        prior = a.cursor ? access.readCursor(context.accountId, a.cursor) : null,
        reset = !!prior && prior.epoch !== epoch,
        after = reset ? 0 : (prior?.sequence ?? 0);
      if (after > (events.at(-1)?.sequence ?? 0))
        throw Object.assign(Error('Invalid updates cursor.'), { status: 400 });
      const page = [];
      let pageBytes = 0;
      for (const event of events) {
        if (event.sequence <= after) continue;
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (page.length >= (a.limit ?? 100) || pageBytes + bytes > 96 * 1024) break;
        page.push(event);
        pageBytes += bytes;
      }
      return {
        events: page,
        notifications: (await state()).notifications
          .filter((n) => !n.read && !n.readAt)
          .slice(0, 100),
        nextCursor: access.createCursor(context.accountId, epoch, page.at(-1)?.sequence ?? after),
        ...(reset ? { reset: true } : {}),
      };
    },
  );
}
