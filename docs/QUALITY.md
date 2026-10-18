# Matching acceptance, baseline Q-2026-10-18

Rolemorrow supports a candidate's review; it does not predict hiring probability. This increment follows TDPD / Test-Driven Product Development, an original method by Innokenty Bodrov. Human acceptance remains separate from engineering checks.

## Contract and scenarios

Existing single-user browser workspace and HTTP API remain the surface. No account, public hosting or personal-data migration is introduced. Source baseline: the checked-in synthetic fixtures and current classifier/provider contracts. No applicant's private profile is part of this baseline. Incorrect recommendations are reversible by inspection; automated applications remain disabled.

| ID | Candidate action / initial evidence | Observable acceptance | Check |
|---|---|---|---|
| Q01 | Run a check for an aligned role, with all core skills unknown | Conditional, zero supported claims, same category persisted | API scan in app.test.mjs |
| Q02 | Review a listing containing only optional requirements | Conditional; no unqualified recommendation | API scan in app.test.mjs |
| Q03 | Check an aligned role with unknown skills but a confirmed hard country mismatch | Low priority; unknown skills cannot override the restriction | API scan in app.test.mjs |
| Q05 | Fetch an employer resolving to both public IPv4 and its dotted IPv4-mapped DNS alias | Normalize and pin public addresses; mapped private/reserved answers and mapped URL literals remain blocked | Network boundary in providers.test.mjs |
| Q06 | Review a requirement with a minimum number of years, citing a fact without enough explicit duration | Unknown, with no supported citation; enough explicit years can still pass this guard | Provider boundary in providers.test.mjs |
| Q07 | An initial assessment cites SQL as proof of UX research | Independent review can downgrade to unknown without retaining a supported citation | Default provider boundary |
| Q08 | Extraction includes perks and repeated clauses | Independent requirement review filters perks; duplicates are collapsed before review | Default provider boundary |
| Q09 | Verification names an invented ID or omits its contract | Assessment fails; no supported claim is published. Valid confirmed IDs survive | Default provider boundary |
| Q10 | Check a Product Marketing director role against a Product Manager goal | Different function; a shared product title cannot force alignment | Provider boundary |
| Q04 | Fetch an employer-linked listing whose optional skill has no leading optional marker | Recognize an explicit single-sentence “is a plus” qualifier; do not inflate the core denominator | Provider boundary in providers.test.mjs |

Existing cases retain fully supported fit, mixed core gaps, all confirmed core gaps, different function, authorization restrictions, salary and optional prefix guards. No core evidence means Conditional unless all evaluated core rows explicitly indicate gaps or a hard restriction/different direction applies. Missing evidence alone is not a confirmed gap.

## Quality review beyond deterministic checks

For each real-provider run, inspect the source URL and date, mandatory versus preferred extraction, exact quotations, semantic entailment of each supported row, country/authorization and salary basis. Benefits, office gatherings and interview-process descriptions must not become skill requirements. Exact quote validation alone cannot prove these semantics.

Manual acceptance set: at least five roles spanning a strong fit, adjacent fit, different function, unknown geography and missing specialist evidence. Record each supported-row error and each missed material requirement separately. Acceptance threshold: no fabricated profile evidence, no confirmed hard constraint presented as eligible, no unsupported direct specialist ownership, and no known optional skill promoted to mandatory. A small clean sample is not a statistical accuracy claim.

Human UAT: open a source, explain why the first three results are useful, identify remaining questions and confirm that a saved decision survives a new check. Pending owner acceptance. Previously evaluated personal vacancies require a new explicit scan to get the new categories; historical snapshots are not rewritten.

## Execution evidence

RED: Q01 and Q02 reproduced Low priority instead of Conditional. Q03 already passed. Q04 reproduced an explicit “is a plus” requirement becoming mandatory. The existing T38 guard forbids trusting model core:false without source wording; the fix extends source recognition while retaining that guard. Record final GREEN and bounded real-provider evidence in READINESS.md; do not equate them with UAT.


### Real-provider observations, October 18

A bounded check used a fictional two-fact applicant, Constructor's employer-linked Customer Onboarding Experience posting and actual Nano/Super calls on Nebius Token Factory. Discovery remained partial. Initial inference produced one false-supported compound requirement: “3+ years” was not established by the cited API integration fact. Q06 reproduced the defect before adding a conservative duration guard. Q05 likewise reproduced a live-source DNS alias rejection before normalization. Neither fix proves general semantic entailment; unrelated durations, compound clauses and extraction omissions still require review.

Final bounded repeat: 2026-10-18 10:36:29 UTC, extraction `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, assessment `nvidia/nemotron-3-super-120b-a12b`, [official linked posting](https://jobs.ashbyhq.com/constructor/e8fa6194-ef2e-47d3-ab45-a9112d87da24). Six extracted core requirements remained unknown for the deliberately sparse applicant, including the unproven minimum duration. Category: Conditional; work-country eligibility unknown. The two synthetic facts did not establish the full compound requirements, so no supported claim was warranted. One reviewed posting does not satisfy the five-role human acceptance set.

GREEN: 75 deterministic checks passed in isolated Linux amd64 containers on October 18, including Q01–Q06 and the existing security/lifecycle suite. Isolated fictional demo HTTP journey passed at 10:35:34 UTC: three categories, one saved job, one packet, one test message, reply still unsent, live disabled. No automatic rewrite of personal historical assessments.


### Follow-up after personal-workspace review

A fresh real-profile run revealed additional unsupported entailments (for example SQL as UX evidence) and non-requirement company statements. Those observations invalidate a claim of accepted matching quality. Q07–Q09 were added before the independent review pipeline. Requirement review filters benefits and company statements; claim verification sees the complete requirement and cited fact and can only retain or downgrade already proposed support. Malformed review IDs fail closed. The other provider contract tests explicitly use a named deterministic semantic adapter; they do not evaluate model judgment.

At 10:42:07 UTC the updated default pipeline also completed the bounded synthetic-applicant real-provider smoke. Six requirements remained unknown, as warranted by the sparse facts. The full new suite has 78 checks. A separate multi-role real-profile repeat and human UAT remain necessary; model-against-model review is an additional control, not proof of semantic correctness. Runs now retain evidencePolicy `2026-10-18-reviewed-evidence-v2` to distinguish the pipeline from older snapshots. Up to four model calls per posting increase latency and cost; limits and cancellation still apply.


### Calibration and remaining acceptance

The first independent-review implementation proved over-conservative on multi-clause real requirements. A positive exact-match control was also variable. The final verifier therefore returns one reasoned verdict for every proposed claim rather than only a list of accepted IDs. Missing/duplicate/unknown IDs or incomplete verdicts fail closed. Instructions distinguish OR/example lists and preferred clauses from mandatory clauses, and understanding from ownership. Q09 covers both retaining a valid positive and refusing invalid review contracts. Q10 fixes the deterministic Product Marketing / Product Manager title collision.

Final policy is `2026-10-18-reviewed-evidence-v3`, with 80 deterministic checks. A more complete private profile was derived from already confirmed master-profile facts, without publishing candidate data; no unsupported skill was added to force a match. Fresh real-profile acceptance is required after this input/policy change. Zero supported claims does not mean a person has no relevant experience: a compound requirement may still contain an unconfirmed clause. Atomic requirements/partial evidence remain a potential product improvement, not a released claim.


Q11 verifies the request configuration for the final claim auditor: Nemotron reasoning enabled, requested reasoning budget 2048 and output cap 8192. Initial extraction/assessment remain in fast mode. This is not a claim that the provider reported enforcing a separate reasoning-token limit. See [NVIDIA reasoning controls](https://docs.nvidia.com/nim/large-language-models/1.15.0/thinking-budget-control.html). The configuration completed an actual Nebius call during development. A reviewed onboarding case retained the evidenced duration/API requirement while rejecting SQL as browser expertise, time-to-market as time-to-value, and unrelated teams as proof of named functions. These observations improve this case; they do not establish general model accuracy.


Final manual review also found a scoring/explainability overclaim and a Product Engineer title collision. Q12 rejects quality gates as proof of explainability while retaining explicit explainability evidence. Q13 distinguishes Product Engineer from the stated PM goal. Release policy is now `2026-10-18-reviewed-evidence-v4` with 82 deterministic checks; earlier v2/v3 runs remain dated evidence, not acceptance of this revision. The five-role review covered onboarding, platform, merchant analytics, telematics and payments/finance. It exposed defects to correct; it is not recorded as owner acceptance or a statistical accuracy benchmark.
