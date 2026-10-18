# Architecture

Browser (vanilla ES modules) → localhost Node HTTP server → atomic private JSON state. Live search calls Tavily and fetches validated public pages; NVIDIA models on Nebius extract requirements and assess quoted candidate evidence. The fictional adapter uses deterministic fixtures without network calls.

- `app/server.mjs`: same-origin JSON writes, local Host validation, CSP, routing, bounded requests and atomic state mutation.
- `app/network.mjs`: public URL/DNS/redirect validation, bounded retrieval and sanitized network errors.
- `app/discovery.mjs`: official employer/linked ATS source graph and bounded discovery.
- `app/providers.mjs`: Nebius/Tavily adapters, schema-constrained inference and fictional providers.
- `app/domain.mjs`: profile validation, quote/reference guards, matching and preferences.
- `app/opportunities.mjs`: durable candidate decisions, independent of SearchRun observations.
- `app/mail.mjs`: application packet versions, bounded files, local normalized mail intake, replay deduplication, rule-based suggestions, tasks and unsent reply drafts.
- `public/`: profile/employers/results/saved-jobs/applications/inbox interface.

SearchRun owns dated observations and assessments. Opportunity owns candidate stage/note/action; rediscovery never overwrites those decisions. Application packets and messages reference an opportunity. Test aliases use reserved `example.com`; unknown/conflicting message associations remain unassigned. No live mail transport or public ingestion endpoint is enabled.

Decisions use revisions to reject stale concurrent writes. Editing a profile marks prior search assessments stale. Untrusted source/email text is rendered as text and cannot issue agent instructions. No background scheduler, automatic application, or mail sender runs.

## Boundary before public service

Local Host/Origin checks are not user authentication. Before an Internet-accessible service: add authenticated users, server-enforced ownership on every record/file/action, isolated demo sessions, rate/budget limits, durable job queues and storage, tested backup/restore, mail-ingress authentication/replay handling and a retention policy. Do not publish the personal state volume or solve access by removing guards.
