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
