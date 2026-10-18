# Synthetic candidate evaluation

Original fictional profiles, authored on 2026-10-18. No HireWire records, owner CVs or real applicant data were copied. Listings are frozen fictional requirements rather than current vacancies. All candidates use Portugal and any work mode so this run isolates evidence and career direction; it does not retest salary, relocation or source discovery.

Six candidates each face two contrasting roles:

| Candidate | Target / established experience | Cases |
|---|---|---|
| Maya | Product Manager; API integration ownership, dashboards not established | Partial platform fit; ML engineering unconfirmed/different function |
| Leon | ML Engineer; training and serving models | Full ML fit; product ownership unconfirmed/different function |
| Amina | Product Designer; user interviews and interactive prototypes | Full design fit; platform ownership unconfirmed/different function |
| Tom | Finance operations moving into Product Manager; reconciliation and settlement | Supported payments requirement; platform experience unconfirmed |
| Sofia | Junior Product Manager; feature-level A/B tests | Partial growth fit, culture-building unconfirmed; telecom migration unconfirmed |
| Alex | Product Manager; telecom monolith migration, APIs and health dashboards | Supported migration and platform requirements |

Expected labels were frozen before inference in `tests/persona-bank.mjs`. They are authored acceptance expectations, not an independent recruiter panel. Supported requirements do not establish seniority, overall suitability or hiring probability. Tom's payments evidence comes from operations and does not prove prior Product Manager employment.

## Reproduce

Use the reviewed checks image and an external environment file containing Nebius configuration. No personal volume is mounted. This explicit opt-in runs twelve cases, up to 24 inference requests, with a 90-second deadline per case:

```sh
docker compose -f compose.checks.yaml build checks
docker run --rm --init --cpus=1 --memory=512m --pids-limit=128 --cap-drop=ALL --security-opt=no-new-privileges --read-only --env-file /absolute/private/runtime.env -e CONFIRM_PERSONA_QUALITY=1 rolemorrow-checks-checks node tests/persona-live.mjs
```

The named actual inference path uses production assessment, independent review, deterministic evidence validation and classification. No deterministic mock is substituted for the model. Offline tests validate the input contracts and bounded case coverage; they do not certify semantic quality. Neither provider evaluation nor exact quotations replace human assessment.

## Observed results, 2026-10-18

[First actual-provider run](PERSONA-LIVE.json): **9/12 exact acceptance cases passed**, zero false full-support claims, zero lost expected full-support claims. This small set does not justify a general accuracy percentage.

- Maya: platform requirement partly established; ML engineering correctly a different function.
- Leon: ML role fully established. Platform PM evidence remained unknown, but direction was `uncertain` instead of expected `different`.
- Amina: designer requirement fully established. Platform PM evidence remained unknown, but direction was `uncertain` instead of expected `different`.
- Tom: payments requirement supported by operations experience, platform evidence unknown. This demonstrates transferable evidence for this specific requirement, not proof of product ownership or seniority.
- Sofia: telecom migration unknown; first Growth PM assessment unavailable. One separate retry returned the expected partial claim: `Run A/B tests` supported by feature-level testing, `establish an organization-wide experimentation culture` unconfirmed. The first failure cause was not established; the retry does not overwrite the initial result or count as a clean 12/12 run.
- Alex: both migration and platform requirements supported; both are suitable for review within this narrow requirement set.

[API replay](PERSONA-REPLAY.json) materialized the recorded observations through six separate disposable production API stores. Full evidence became Worth reviewing; partial/unknown became Conditional; explicit different-function became Low priority; unavailable assessment stayed unavailable and made the check partial. This is an integration replay, not additional live inference. Personal and running demo stores were not changed.

Follow-up scenarios:

1. Clearly distinct target professions must not be softened to `uncertain` merely because they share API/product vocabulary. The two recorded failures remain failing semantic expectations, not relabeled successes.
2. Preserve bounded retries and expose unavailable assessments; do not silently replace an unavailable first observation with a later success in quality reporting.
3. Add realistic multi-requirement and seniority cases before interpreting a one-requirement full match as a strong overall application. Current role titles and sparse fictional requirements do not establish level fit.

96 deterministic checks passed after adding the input-contract check. No production model prompt, evidence policy, ranking or UI was changed by this evaluation. Human acceptance and broader sampling remain pending.

## Profession/level follow-up (v2)

[New acceptance rules](ROLE-LEVEL-ACCEPTANCE.md) and [v2 actual inference](PERSONA-V2-LIVE.json) retain the original cases and add three tenure profiles: one product year, seven product years and seven finance-operations years. Set `PERSONA_BANK=v2` alongside `CONFIRM_PERSONA_QUALITY=1` for at most 30 inference calls. Result: 14/15 expected cases; both disjoint-profession judgments and all new tenure cases passed. One initial junior/growth assessment remained unavailable. A [separate diagnostic retry](PERSONA-V2-DIAGNOSTIC.json) returned partial support, without rewriting the initial outcome. The first failure cause remains unknown. [V2 API replay](PERSONA-V2-REPLAY.json) verifies recorded outputs through nine isolated stores.
