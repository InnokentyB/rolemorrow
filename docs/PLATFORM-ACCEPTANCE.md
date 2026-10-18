# Platform acceptance — P1 / 2026-10-18

Scope approved by owner: (1) evidence and ranking, (2) repeatable quality controls, (3) complete existing browser journey. Public hosting and judge accounts are outside this increment. No personal profile edits or real applications/mail are authorized by this scope.

TDPD / Test-Driven Product Development, an original method by Innokenty Bodrov: scenarios and RED tests precede production edits; human UAT remains a separate gate.

## Rules and user scenarios

| ID | Initial state → action | Observable acceptance |
|---|---|---|
| P01 | Candidate has evidence for one independent clause, not the whole core requirement → check | Partial evidence, exact matched and unconfirmed source spans, exact profile quote; never full support |
| P02 | Missing/overlapping/invented spans or profile quote → assess | Reject unusable assessment; no invented partial credit |
| P03 | Same role, unknown evidence → review | Unconfirmed is different from a proved gap or different function |
| P04 | Review multiple assessed listings → inspect order | Hard conflicts/different function remain low. Within a category: aligned role, full core coverage, partial core coverage, fewer proved gaps, clearer conditions, then soft preferences. Optional requirements never improve core coverage. Stable URL/key breaks final ties |
| P05 | A weak tagged employer and stronger untagged employer → inspect | Content/evidence wins over an industry/theme tag. Order is not hiring probability |
| P06 | Open evidence → inspect uncertainties | Full requirement, full/partial/unknown label and specific missing clause/question are visible. Partial claims cannot count as full support |
| P07 | Save partial job, create decision/packet/test correspondence → check again/restart | Same Opportunity identity, decision revision, packet and message survive; original run snapshots retain their policy/version |
| P08 | Old run/profile/method → inspect | Stale clearly flagged; new assessment does not silently reinterpret historical support |
| P09 | Fresh user → profile → employer check → save → packet/export → test inbox → draft | Complete browser journey on desktop/mobile. Draft is unsent and test invitation cannot imply actual employer response |
| P10 | Invalid/empty input, unavailable source, failed assessment, no results, cancellation, retry | Distinct actionable states; no fake success, no late cancelled overwrite, retry works |
| P11 | Run frozen benchmark for different profiles | Expected full/partial/unknown/different/conflict results and order enforced offline in CI. This proves contracts, not model judgment |
| P12 | Explicit bounded real-provider check with synthetic inputs | Report fixture/policy/model IDs, per-case false-supported/false-negative counts and results. Never call an offline pass a live quality verdict |

## Architecture and compatibility

SearchRun owns assessments; Opportunity owns candidate decisions. Extend rows with partial evidence and exact unconfirmedQuote; supported/gap/unknown legacy rows remain readable. Partial requires two non-overlapping source substrings and one exact fact citation. Both spans must be proper clauses, not the entire requirement. Unknown/gap carry no fact citation. Independent review may downgrade either full or partial proposals, never promote them. Deterministic tool/duration checks apply to the claimed part, not the missing clause.

Ranking is a shared pure view-model module used by server and browser. Category/role/coverage are lexicographic, not opaque weighted probabilities. Full coverage is compared as fractions; partial coverage is a separate tie-breaker. Soft preferences are last. Unavailable assessments sort last. API order, browser order and saved snapshots cannot use competing definitions.

Current HTML/vanilla module workspace remains the surface. Preserve the compact research worksheet and existing navigation. No new screen, public endpoint authorization boundary, account system, automatic stage update or sender.

State additions are backward-compatible. Before deployment, preserve private state and rollback image; never seed fixtures in the personal volume. Tests use disposable files. Browser workloads run non-root in a reviewed tower container with Chromium sandbox enabled; no --no-sandbox fallback.

## Evidence and gates

Frozen benchmark uses original fictional texts and synthetic profiles only; no applicant data or changing vacancy pages. Named deterministic adapter proves lifecycle and expected ordering. Bounded real-provider evaluation is separate. Browser tests exercise the same API/UI with the deterministic adapter, including failure/recovery. Human UAT must still judge usefulness and understandable uncertainty. Record final command/revision/results and unexecuted checks before delivery.

## Recorded engineering evidence, 2026-10-18

RED tests first exposed absent partial support, client/server ordering divergence, hidden cancellation, and the live reviewer false-negative described in QUALITY.md. GREEN: 95 deterministic checks, including the 15-case frozen matrix; all eight browser scripts; six actual Nebius cases (6 passed, zero false-supported and false-negative cases in this subset). Commands: `docker compose -f compose.checks.yaml run --rm checks`; `docker compose -f compose.browser.yaml run --rm browser`; explicit opt-in `tests/quality-live.mjs` as documented in README. All application execution occurred in tower containers.

The fictional default fixture also has full/partial/unknown rows, with four listings. Historical stored assessments are not rewritten on upgrade. No personal profile edits or paid personal search were needed. Scoped independent UI finish review passed; detector was DEGRADED, and computed accessibility and human UAT remain unverified. Public hosting, real email delivery, production account isolation, video and final submission remain outside this increment.
