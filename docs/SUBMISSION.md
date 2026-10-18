# Rolemorrow — submission draft

Status: preparation, not a submitted entry. Recommended track: Best Apps and Agents. Working name is provisional.

## Project description

Job boards optimize for browsing. Rolemorrow starts with the applicant: confirmed experience, a career direction and practical preferences. It searches chosen employers' own career sites and linked applicant-tracking systems, then puts the evidence behind each recommendation in view.

NVIDIA Nemotron models on Nebius Token Factory extract requirements and assess them against explicit profile facts. Independent review filters non-requirements and checks proposed supported claims. The application validates quotations and references, applies country and preference rules, and separates supported experience from questions that still need an answer. A partial search stays visibly partial. A match category is a review aid, not a prediction of an offer.

Candidates can save opportunities, preserve decisions between searches, prepare and export an application packet, and organize test/manual correspondence. Inbox items can suggest a next action; stage changes need the candidate's confirmation. Reply drafts stay unsent.

The prototype is a single-user Node application with a browser workspace, private local state, bounded discovery and source snapshots. It uses Tavily for discovery, retrieves employer evidence directly, and calls NVIDIA Nano for extraction and Super for assessment through Nebius Token Factory. It does not use Nebius compute hosting.

## What the demonstration must make explicit

The interactive fictional example requires no credentials and makes no provider calls. The separate bounded live-quality check uses a fictional applicant with actual provider calls. Label any recorded real-source output with its check date. Do not call fixture results live.

Application packets and test mail demonstrate workflow, not actual ATS submission or email delivery. Unknown salary, payroll eligibility and unsupported skills remain questions. No personal candidate data or credentials belong in a public recording.

## Video storyboard — target 2 minutes 40 seconds

| Time | Show | Narration |
|---|---|---|
| 0:00–0:20 | Fictional profile and career goal | “Rolemorrow starts with what you have actually done and what you want to do next.” |
| 0:20–0:45 | Employer list and explicitly labeled check mode | “Search follows employer career pages and their linked ATS. This reproducible example uses fictional vacancies; the live mode uses Tavily and NVIDIA models on Nebius.” |
| 0:45–1:15 | Result, source and evidence rows | “Each recommendation is inspectable. Here is the source requirement, the profile fact that supports it, and a specialist skill we still need to clarify.” |
| 1:15–1:35 | Dated synthetic-applicant live check output | “This separate recorded check calls Nano for extraction and Super for assessment on Token Factory. Quotes are validated locally; semantic quality still needs review.” |
| 1:35–2:05 | Save job, next action, packet export | “Your decisions survive new searches. Prepare your materials here and review them before applying.” |
| 2:05–2:30 | Clearly labeled test invitation and unsent reply | “Correspondence becomes an attention queue. This is a test invitation; reply drafts are not sent.” |
| 2:30–2:40 | Repository and honest limitations | “The public MIT repository includes a Docker test build. Next are authenticated access, real mail and employer-specific application integrations.” |

Record the functioning app, not only slides. Upload the finished video publicly to YouTube; keep it under three minutes.

## Provider feedback draft

Structured responses made the extraction/assessment boundary practical. We separated the smaller extraction model from the assessment model and added local quote/reference validation. Structured JSON alone did not ensure semantic correctness: optional requirements, compound skills and transferable experience needed explicit instructions and regression tests. Useful improvements would include clearer model-specific structured-output examples and a documented way to constrain source-grounded citations. This is qualitative implementation feedback; no throughput, cost or model-ranking benchmark is claimed.

## Submission checklist

- Public MIT repository: https://github.com/InnokentyB/rolemorrow
- Runnable test build: repository plus compose.demo.yaml and README instructions; verify a final clean clone.
- Optional hosted judge URL: not yet deployed; do not expose the personal workspace.
- Actual provider evidence: run the opt-in synthetic-applicant check, inspect the output and retain a dated public-safe record.
- Public YouTube URL: still required.
- Owner acceptance of the shortlist and demonstration: pending.
- Confirm track, authorship and development-period disclosure with the owner; earlier career-search experience is not evidence that this application predates the competition.
- Complete Devpost fields, review the exact final materials and retain submission receipt.

Rules checked October 18, 2026: https://nebiusglobalaihackathon.devpost.com/rules . Deadline October 30 at 10:00 PDT / 17:00 UTC (Lisbon). Judges must be able to test through December 15, 2026. Recheck requirements before submitting.
