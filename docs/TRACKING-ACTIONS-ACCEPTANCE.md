# Saved source checks and next actions

TDPD / Test-Driven Product Development, an original method by Innokenty Bodrov.

Approved scope: manual recheck of saved vacancy sources and combined next-action overview. No generated application content, real sending, scheduled monitoring or automatic application-stage changes.

R01: a saved role can be checked explicitly. Fixture checks never use the network. Real checks send only a public source URL, with explicit confirmation; require live access. Same-origin JSON, public URL/DNS protections and same-host/path retrieval remain enforced. Unverified manually supplied jobs are not rechecked automatically.
R02: first successful check records a page baseline; later text changes produce a review signal, not a claim that requirements changed. Source 404/410 means not found, explicit closure wording means possibly closed, access errors/JS shells/redirect to board mean unavailable. Missing source cannot prove closure. Original assessment, source text, candidate decision, packet and correspondence remain unchanged. A check is not a new fit assessment.
R03: duplicate checks are rejected; deletion or replacement of the saved snapshot during a request prevents a late write. Persist bounded observation history and retain the prior successful baseline across errors. Restart preserves observations. No queue or publisher is activated.
A01: Inbox combines next actions from existing saved decisions, packet state, assessment clarifications, source checks and correspondence tasks. No second task table. Exclude terminal/archived roles; overdue uses UTC calendar dates, explicitly labeled. Stages and completion are not inferred from packet availability.
A02: each row navigates to its existing saved role, application or correspondence; existing controls remain the only write path. Empty states and mobile wrapping remain actionable.

RED/API: unchanged→changed→unavailable→unchanged, not-found/closure, consent, conflict/deletion, persistence, decisions preserved. RED/browser: recheck saved role, inspect status and Inbox overview, follow next action. Human review must accept clarity and usefulness; no automatic acceptance claim.

R04: source review is sticky across unchanged/unavailable checks. Acknowledgement is explicit and guards the latest observation revision; it does not update assessment or application content. Last readable baseline survives bounded history truncation. A first readable page can flag missing saved core wording, while stating that wording/formatting differences do not prove semantic change.

Engineering evidence: source-check endpoint first failed RED with 404; focused API and projection checks pass in the isolated container suite (105 checks total). Tests cover changes, errors, duplicate rejection, deletion during request, persistence, consent, manual authority refusal, stale acknowledgement, UTC actions and first-check missing wording. A bounded live dependency check read three public URLs: Nuitée returned a readable baseline; Zego and Constructor were unavailable. No personal profile was transmitted and no real state was changed. This does not establish broad page compatibility. No account/security boundary was expanded.

Compatibility: additive Opportunity fields (`sourceCheck`, bounded `sourceCheckHistory`, `lastReadableSourceCheck`, `sourceCheckRevision`, `sourceReviewRequired`, `sourceReviewedAt`). The original snapshot/decision/packet/message aggregates remain authoritative. Rollback uses the previous runtime image and verified private state backup. Human usefulness acceptance remains pending.
