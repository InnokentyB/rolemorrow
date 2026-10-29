# Rolemorrow

Evidence-led job search, application preparation and correspondence tracking.

**Nebius × NVIDIA Global AI Hackathon — 29 October 2026 source release.**

[Public demonstration video](https://youtu.be/o58_LBnHaws) · [Judge guide](docs/JUDGE-GUIDE.md) · [Evidence and limitations](docs/EVIDENCE.md)

## What this release demonstrates

A fictional candidate loads confirmed experience, checks selected fictional employers, inspects the evidence for a role, saves a job and next action, then saves CV content, a cover letter and screening answers in a versioned packet. This is the local application used for the video, with private operator details replaced by explicit demo placeholders. It is not an employer-submission bot or a guarantee of a hiring outcome.

The public source includes account, import, audit, mail and provider adapters, but the default judge build does **not** load private accounts, provider credentials, real mail or live collection. Do not put personal data into a shared demonstration. Public-service operators must configure their own legal details and operational controls; the example legal identity is deliberately not a real person or registration.

## Judge test build — no account or API keys

Requires Docker Engine and Docker Compose, Linux amd64. Download/clone this public repository, then:

```sh
docker compose -f compose.demo.yaml build demo
docker compose -f compose.demo.yaml up -d --wait demo
```

Open **http://127.0.0.1:3028/** in your browser. Click **Use fictional example**, then **Check selected companies**. Follow the [five-minute judge walkthrough](docs/JUDGE-GUIDE.md).

This is a downloadable, locally running test build, not a claim that this commit is deployed at app.rolemorrow.com. It is independent of the owner's accounts and data. Each installation has its own fictional workspace. No sign-in, private invitation or paid service is required. The default build does not exercise actual inference: the dated provider records are described separately in the evidence guide.

The host port binds only to loopback. On a remote Docker host, forward port3028 over SSH using your normal access controls. Change `ROLEMORROW_DEMO_SUBNET` if the default network overlaps your own network. Keep browser security enabled.

Health and logs:

```sh
docker compose -f compose.demo.yaml ps
docker compose -f compose.demo.yaml logs --tail=50 demo
```

The image health check uses `/health`. Stop with `docker compose -f compose.demo.yaml stop demo`. Temporary checks use `run --rm`. Data remains in the project-specific Docker volume; do not use `down -v` or delete volumes as routine cleanup. For any upgrade of an existing installation, preserve its data and prior image first.

## Verification commands

All installs/builds/tests run in Docker, not a native host Node process:

```sh
docker compose -f compose.checks.yaml build checks
docker compose -f compose.checks.yaml up -d --wait database
docker compose -f compose.checks.yaml run --rm --no-deps checks
docker compose -f compose.checks.yaml stop database
docker compose -f compose.browser.yaml build browser
docker compose -f compose.browser.yaml run --rm --no-deps browser
```

Browser checks run sandboxed Chromium. No provider keys are needed. The checks Compose starts a separate synthetic PostgreSQL in temporary memory-backed storage, with no network egress or host ports, and measures its actual capacity. Its visibly synthetic passwords are fixture values, never production credentials. Start the database before the check command and stop it afterward. Missing prerequisites are failures, never successful coverage. Do not point tests at a personal or production database. Two offline retention CLI tools are included because their negative tests exercise them; no cleanup is activated automatically.

## NVIDIA, Nebius and Tavily

The actual-provider configuration exercised during development used:

- NVIDIA `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` for requirement extraction;
- NVIDIA `nvidia/nemotron-3-super-120b-a12b` for assessment/review;
- Nebius Token Factory for runtime inference;
- Tavily for discovery.

The app UI is not hosted on Nebius AI Cloud. Provider presence in source or environment is not evidence of a successful call. See the dated and scoped [evidence guide](docs/EVIDENCE.md), including a real-model adaptation refusal.

Optional live search requires explicit server opt-in `ALLOW_LIVE=1`, `NEBIUS_API_KEY`, `TAVILY_API_KEY` and the available `NEBIUS_MODEL` / `NEBIUS_ASSESSMENT_MODEL` configured only as private runtime environment variables. It can incur charges. The default judge Compose does not pass those variables or read a private `.env`. Never embed keys in source, browser code, images or shared links. Optional Resend mail also needs separate configuration and explicit per-message confirmation; the demo sends no email.

## Limits and development provenance

Discovery is partial and source-dependent. Fit is an inference with visible unknowns, not a hiring probability. AI document adaptation remains a quality-limited beta: invalid claims/references can cause refusal after generation or repair. A saved/manual packet is not proof of a successful AI-generated document. Provider acceptance, inbox delivery, reply materialization and employer/ATS acceptance remain distinct.

This snapshot advances the public18October prototype with the current local application used in the video. Later implementation includes private-storage/audit/import/MCP and adaptation controls; their inclusion in source does not certify production deployment or broad model quality. No personal career files, emails, runtime databases or operational credentials are included. Confirm final entrant/team and development-period disclosure in Devpost.

MIT license: [LICENSE](LICENSE). See [release verification](docs/RELEASE-VERIFICATION.md) for fresh checks of this exact package.
