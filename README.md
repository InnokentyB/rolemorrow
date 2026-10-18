# Rolemorrow

An evidence-led career search workspace built for the **Nebius × NVIDIA Global AI Hackathon**. Rolemorrow is a provisional working name, not a cleared trademark or registered domain.

Start with confirmed experience and a career goal. Choose employers. Inspect vacancy requirements against quoted profile evidence, keep your own decisions between searches, prepare an application packet, and organize correspondence.

**Status:** working single-user prototype. Live vacancy search and NVIDIA inference have been exercised during development. Mail is **test/manual only**. There is no public hosted demo, real email transport, automatic job application, production authentication or multi-tenant isolation in this release. Use fictional data when demonstrating.

## Quick start — Docker

Requires Docker Engine and Docker Compose on a supported Linux amd64 host. The application port is published on localhost only.

```sh
cp .env.example .env
docker compose build career
docker compose up -d career
docker compose ps
curl http://127.0.0.1:3027/health
docker compose logs --tail=100 career
```

Open **http://127.0.0.1:3027/**. Choose **Use fictional example**, then **Check selected companies**. No credentials or provider requests are needed. The example overwrites the current profile/company inputs: use a fresh demo volume rather than your personal workspace.

To stop:

```sh
docker compose stop career
# Removes containers/network, retaining the named data volume:
docker compose down
```

Do not use `down -v` as routine cleanup. State lives in the named volume at `/app/data/state.json`; it is private but not application-encrypted. Before upgrades, preserve a backup and the previous image. Never expose this prototype directly to the Internet.

For a remote Docker host, forward its localhost port over SSH. Follow your own host execution policy; the commands above do not require running the app natively.

## Isolated judge test build

Use a separate fictional workspace alongside an existing personal installation:

```sh
docker compose -f compose.demo.yaml build demo
docker compose -f compose.demo.yaml up -d --wait demo
```

Open **http://127.0.0.1:3028/**, select **Use fictional example**, then run a check. This Compose file does not pass provider credentials, fixes live mode off, and uses its own volume. It publishes only on loopback. For a remote host, forward port 3028 over SSH. Its small network subnet can be changed with `ROLEMORROW_DEMO_SUBNET` if it overlaps your network. Stop with `docker compose -f compose.demo.yaml stop demo`; inspect health/logs with `ps` and `logs --tail=100 demo` using the same Compose file. Keep the volume to retain the fictional story; reset through the app's explicit deletion action if needed.

The test build is downloadable source, not a publicly hosted service. See [submission draft](docs/SUBMISSION.md) and [matching acceptance](docs/QUALITY.md).

## Demo journey

1. Confirm profile and goal; select up to five official employer career pages.
2. Run the fictional example, or explicitly configure/consent to a live check.
3. Review fit category, conditions, coverage and exact employer/profile quotations. Unknown evidence remains unknown; fit is not hiring probability.
4. Save a job. In **Saved jobs**, report a stage, note and next action/date. A new scan preserves these decisions.
5. In **Applications**, save a CV version/text or PDF/text files, letter and screening-answer notes; export the saved packet. Nothing is submitted to an employer.
6. Simulate a clearly labeled invitation or add an email manually. **Inbox** shows attention items. Reply drafts remain unsent; stage proposals require confirmation.

## Nebius, NVIDIA and Tavily

Live mode needs server opt-in (`ALLOW_LIVE=1`), `NEBIUS_API_KEY`, `TAVILY_API_KEY`, and an exact available `NEBIUS_MODEL` in the `nvidia/` namespace. `NEBIUS_ASSESSMENT_MODEL` optionally selects a separate assessment model. Configure only `.env`/deployment secrets; never commit keys.

The exercised development configuration used:

- extraction: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`;
- requirement review, assessment and independent claim verification: `nvidia/nemotron-3-super-120b-a12b`;
- inference: Nebius Token Factory chat completions with structured JSON responses;
- discovery: Tavily Search followed by direct DNS-validated retrieval of employer/linked ATS sources.

Model availability is project-dependent; check the current provider catalogue before enabling live mode. The UI requires consent before transmitting the saved profile/goal to Nebius; public-source search queries go to Tavily. Local deletion cannot delete provider-held records.

Search snippets never count as requirements. Only official employer sources or literally linked ATS tenants are accepted. Deterministic guards reject invalid quotes/references. An independent model pass filters non-requirements and another can only downgrade proposed supported claims; invalid review responses fail closed. A posting uses up to four model calls, so keep live limits small. Exact quotations and a second model opinion still do not prove semantic correctness. Discovery is bounded and may be partial; no claim of complete market coverage or guaranteed eligibility is made.

Official provider references: [Nebius quickstart](https://docs.tokenfactory.nebius.com/quickstart), [structured inference](https://docs.tokenfactory.nebius.com/ai-models-inference/json), [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search).

## Verification

```sh
docker compose -f compose.checks.yaml build
docker compose -f compose.checks.yaml run --rm --no-deps checks
```

Checks run without network access, runtime secrets or the personal data volume. This release has 95 deterministic logic/API checks, including a frozen matrix of 15 profile/vacancy combinations. Shared server/browser ranking puts role and core evidence before soft preferences. Evidence can be full, partial (with matched and missing clauses), or unconfirmed; it is not a hiring probability. Load the fictional example and check its employers to see all three states without API keys.

The eight browser scripts run with disposable stores and synthetic providers:

```sh
docker compose -f compose.browser.yaml build browser
docker compose -f compose.browser.yaml run --rm --no-deps browser
```

The Linux amd64 browser image uses non-root Chromium with its sandbox enabled, all capabilities dropped and networking disabled during tests. The checked seccomp profile permits the user-namespace sandbox syscalls and chroot; it does not grant container capabilities. Chromium 155 was observed in the verified build; the Debian browser package may receive updates. No ports or persistent browser services are started; temporary containers are removed on exit. Both deterministic and browser jobs run in GitHub Actions. Automated browser checks do not replace human accessibility/usefulness acceptance.

A separate opt-in check makes at most 12 real Nebius inference requests against six frozen synthetic cases (no Tavily discovery):

```sh
docker compose -f compose.checks.yaml build checks
docker run --rm --init --cpus=1 --memory=512m --pids-limit=128 --cap-drop=ALL --security-opt=no-new-privileges --read-only --env-file /absolute/private/runtime.env -e CONFIRM_PLATFORM_QUALITY=1 rolemorrow-checks-checks node tests/quality-live.mjs
```

Keep that environment file outside the checkout; supply only Nebius configuration needed for this workload. Never commit keys or personal state. The latest bounded report is [QUALITY-LIVE.json](docs/QUALITY-LIVE.json): six of six passed, with zero false full-support claims and zero false negatives within this subset. This is not a market accuracy estimate. See [platform acceptance](docs/PLATFORM-ACCEPTANCE.md) for scenarios and verification limits.

## Limits and next work

- Single-process atomic JSON, single owner; no production authorization or account isolation.
- Job matching still needs semantic evaluation on a held-out set; model interpretations can be wrong.
- Mail adapter accepts local test/manual messages; no real mailbox, public webhook or sender exists.
- English phrase-based mail suggestions, not an LLM mail classifier; corrections require exact source excerpts.
- Files: PDF/UTF-8 text, two files up to 256 KiB each. Downloads are forced attachments; no malware scanning service is integrated.
- Storage: 200 messages, 500 saved jobs and 32 MiB total. Compatibility backups are private; explicit workspace deletion includes app-managed backups.
- Public demo, video and final hackathon submission remain separate tasks.

See [architecture](docs/ARCHITECTURE.md) and [readiness](docs/READINESS.md). No personal profiles, real correspondence, CVs, credentials, operator backups or internal review screenshots are included.

## Origin and license

This career-search implementation began during the competition period in October 2026 after a product pivot. The earlier banking prototype is separate and is not included. Test-Driven Product Development (TDPD), an original method by Innokenty Bodrov, guided scenario-first implementation; automated engineering checks do not replace human UAT.

MIT — see [LICENSE](LICENSE). Third-party packages retain their own licenses. No endorsement by Nebius, NVIDIA or Tavily is implied.
