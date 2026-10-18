# Profession and role-level acceptance

TDPD / Test-Driven Product Development, an original method by Innokenty Bodrov.

Problem: a shared technical vocabulary can soften a clear profession mismatch; a fully supported skill can be mistaken for proof of seniority. The six-persona v1 run exposed two direction failures. Preserve its original observations.

Scope: existing assessment, classification and evidence UI. No new applicant facts, sending, storage migration or account boundary. Unknown remains different from a proved gap. Requirement evidence and level review are separate. No universal junior/senior hierarchy or inferred years from dates.

- RF01: explicitly recognized, disjoint profession families produce Different function. Alternative targets that include the job family, or hybrid/unknown job titles, preserve model judgment; do not force a mismatch. A single recognized job family disjoint from all recognized target families is different. English recognition is intentionally bounded.
- RF02: a level title alone remains unconfirmed. Explicit mandatory experience/management scope rows can evidence that stated scope only when each is fully supported. This does not certify overall seniority. Optional scope rows cannot establish level. Existing requirement matching determines recommendation category; a title-only unknown does not automatically reject a candidate.
- RF03: API skill + one year product experience cannot fully satisfy five years product management. Seven years in finance operations cannot substitute for product-management tenure. Seven explicit product-management years can satisfy a five-year requirement. Junior-to-Senior keeps direction aligned, with missing level evidence exposed.
- RF04: Results and saved snapshots display Role level alongside experience, career direction and conditions. Historical snapshots without the new field remain readable and are marked stale under the new policy. Candidate decisions remain unchanged.

RED: focused role-fit tests precede implementation. GREEN: deterministic checks, browser journey including visible level text, and bounded actual Nebius evaluation. Preserve frozen v1 findings; new reports must identify v2 inputs and policy. Human usefulness acceptance remains pending.

## Recorded evidence

100 deterministic checks and all nine sandboxed browser scripts passed. A provider-transport RED regression demonstrated finance tenure incorrectly passing the generic years guard; the discipline-specific guard makes it unknown while preserving explicit product-management tenure. Results include a separately visible Role level dimension; saved snapshots carry its original text.

Actual Nebius v2 report: 14/15 cases passed across nine fictional profiles, zero false full-support and zero lost expected full claims in this set. Both prior direction failures and all three new tenure cases passed. The junior growth case was unavailable in the first v2 run, as in v1; a separate diagnostic retry returned valid independently reviewed partial support. Its initial failure cause was not captured, so no cause or stability fix is claimed. Original failures remain preserved. This is a bounded acceptance set, not general matching accuracy.

See PERSONA-V2-LIVE.json, PERSONA-V2-REPLAY.json and PERSONA-V2-DIAGNOSTIC.json. V2 replay uses disposable API stores; historical v1 reports remain unchanged. Independent scoped UI finish review passed; computed accessibility and human usefulness acceptance remain unverified.
