# Rolemorrow user acceptance paths

TDPD / Test-Driven Product Development, an original method by Innokenty Bodrov.

Problem: the working screens need to form an understandable journey. A candidate should see their current position, choose a next action, recover from empty/filter states, and distinguish preparation from an actual application.

Scope: existing single-user HTML workspace and canonical SearchRun → Opportunity → application packet → correspondence lifecycle. Add navigation guidance only; no new durable completion flags, automatic stage changes, account boundaries or sending. Guidance derives from saved state; preferences and fictional examples remain optional. Personal data is not changed for acceptance.

| Scenario | Initial state and action | Expected result | Evidence |
|---|---|---|---|
| U01 | Fresh workspace → inspect guidance → example → check → save → packet | Next action follows saved state; no invented completion or external submission | journey-e2e.mjs |
| U02 | Applications has no saved job, or inbox has no messages → use empty-state action | Reach the existing relevant workspace without a dead end | journey-e2e.mjs |
| U03 | Navigate using guidance, then search for absent role and clear filters | Heading receives focus; all listings return; mobile has no horizontal overflow | journey-e2e.mjs |
| U04 | Run fails, is cancelled, becomes stale, or finishes partially | Existing explicit uncertainty and recovery preserved; guidance never labels a failed check complete | platform-e2e.mjs and manual review |
| U05 | Owner follows the demonstrated path | Understand evidence, missing clauses, next action and preparation/sending boundary without agent instructions | Human verdict pending |

Manual acceptance script: open the fictional demo; explain why the first and partial matches differ; find the missing clause; open a saved role; review its packet and test message; edit an unsent reply; return to Results. Report where wording, order or navigation causes hesitation. Judge usefulness and appearance on desktop and phone. Automated checks cannot supply this verdict.

Engineering evidence: U01–U03 failed before the UI changes (old brand/surface); the new path passed in isolated Linux amd64 sandboxed Chromium. The 95 deterministic checks remained green. Browser coverage includes nine scripts; the independent scoped UI review is separate from human acceptance. No provider or owner-profile changes were made.
