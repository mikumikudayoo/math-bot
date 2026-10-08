# Mathematics announcement rollout

Implementation branch: `feature/announcement-automation`, based on main `7832d86`.
Existing production was inspected at `/opt/math-bot`; `/srv` is an inactive future scaffold. Production has locally changed training artifacts. Do not replace them or merge the moderation branch wholesale.

## Approval boundaries

Competition, competition round, VTAMPS program/version and Senior Secondary training sessions have separate identities. Dates are revision data. Gmail and Groq propose; staff approves facts; configurable policy plans immutable messages. Major messages additionally require exact text/media approval. Canva is manual PNG/JPG upload. The manual `/reminder` remains independent.

Both feature and public-delivery gates initially remain false. The supplied private staff channel is `1434707138743373964` in guild `1414201024637308950`; a read-only Discord inspection confirmed that everyone cannot view it. Setup policy uses this channel as a private staging destination, has no role and no reminder rules. Public channels, competition roles and lead times must be explicitly configured before live delivery. Nothing schedules without a policy.

Pending corrections hold affected unsent jobs. Until extraction resolves a newly ingested organizer source's identity, existing announcements are conservatively held. Parsing/extraction failure retains that hold; `/announce source` shows redacted evidence, and `/announce dismiss-source` records explicit staff disposition. Successful extraction narrows holds to affected candidate events. Image/scanned schedules require manual structured import and factual approval; v1 has no OCR or vision. Staff should use the original source/message identity when importing a correction so that its source hold is released. Do not dismiss a source before its replacement facts have been reviewed.

Delivery reserves SQLite state before Discord. Ambiguous acceptance is uncertain and cannot retry automatically; staff reconciles a real message ID or cancels. Restarted delivering jobs also need reconciliation. Expired reminders skip; no catch-up burst. Staff alert attempts also reserve before sending and do not retry ambiguous acceptance. Provider outages cannot prevent delivery of already persisted, approved messages.

## Private credential setup: current stopping point

Local private setup file exists at `.env.automation.development` in this worktree, ignored by Git. Account label is `machicastephendave@gmail.com`; this label does not itself authenticate or verify ownership.

1. In Google Cloud, enable Gmail API and create an OAuth Desktop client. Configure only `https://www.googleapis.com/auth/gmail.readonly`. If the consent app is in Testing, add this Gmail account as a test user; its refresh token may expire after seven days, so unattended use needs suitable consent publishing or renewal planning. Paste `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` into the private setup file, plus `GROQ_API_KEY`. Never paste these into chat.
2. Once those values exist, run the included `gmail:authorize` helper locally with pinned WSL Bun. It saves a private authorization URL in `.cache/gmail-authorization-url.txt` and listens on localhost port 8765. Open that URL, select the specified Gmail account, grant read-only consent. The helper writes `GMAIL_REFRESH_TOKEN` privately; it never prints it. Close the OAuth tab afterward. Keep a valid localhost callback route between the browser and WSL.
3. Set a narrow `GMAIL_QUERY` and explicit comma-separated `GMAIL_ORGANIZER_SENDERS`. Do not guess organizer addresses. An empty query/sender list prevents activation. The next deployment step can transfer the private file over SSH without printing it and rewrite paths for `/opt/math-bot`.

Groq is isolated behind the generic provider interface. GPT-OSS 120B is the default candidate; Qwen preview is evaluation-only. No OpenAI API, ChatGPT Work backend or paid fallback is configured. Never enable cognitive routing before the live benchmark and human answer grading. The 120-row existing holdout measures routing labels; benchmark output leaves answer/reasoning/knowledge correctness ungraded for humans, not invented scores.

## Conservative production procedure

This document is a procedure, not evidence that deployment happened.

Before a release, rerun local frozen install/check/full tests/build and Python tests with the repository virtual environment. Record exact commit SHA. On the VPS, inspect current checkout and processes again; compare the protected training hashes recorded in the audit before and after every checkout/build. Preserve unknown files and tables.

Create a private timestamped backup under `/opt/math-bot/backups/` using SQLite's backup API for qotd, admin, manual reminders, AI service and announcements if present. Validate every backup with `quick_check`. Back up private env, compiled dist, PM2 definitions and dirty training artifacts with restrictive permissions. Record pre-release Git SHA and process arguments. Do not copy an active SQLite file without its WAL through an ordinary file copy.

Release only this feature branch on `/opt/math-bot`, preserving the dirty training files. Run the pinned frozen install/check/build on the VPS before process changes. Existing mathbot PM2 processes are `aleph-zero-bot` and `aleph-zero-ai`; the ubuntu-owned llama-server is separate and must remain untouched. Add `aleph-zero-automation` under mathbot using Bun and `dist/announcements/worker.js`, production mode, existing cwd. Use a separate announcements DB and persistent assets. Keep cognitive routing and public delivery off. Register the complete existing production command set plus `/announce`; first compare live commands to avoid dropping commands from a divergent deployment.

After backups and credential setup, enable only the automation feature gate. Retain public auto-send false. Verify process health, existing authenticated AI service, database integrity, private staff-channel permissions, worker heartbeat and actual read-only Gmail scope. Process the historical five-session fixture first, proving no past-event catch-up, then real organizer email in shadow mode. Compare every extracted field and source evidence manually. Benchmark providers with the same routing/tool harness and grade full answers before selecting production routing.

Rollback: turn both automation gates off, stop only the automation worker, restore the previous compiled release and restart only the changed bot/AI processes using their recorded PM2 definitions. Keep the new announcement DB for audit; do not overwrite existing production databases. Any DB restore requires stopping its owner process and deliberately reconciling post-backup writes.

Known verification limits: offline tests cannot establish real Gmail OAuth, Groq model quality/quotas or authenticated Discord sends. Exact organizer filtering, public channel/role policy and lead times remain configuration work. No public sending is authorized by this rollout.

Google OAuth token lifetime reference: https://developers.google.com/identity/protocols/oauth2#expiration

Current verification (2026-10-08): 302 Bun tests and four Python tests pass; TypeScript check/build pass. Disabled local health: both gates false, no credentials, zero policies/jobs, SQLite quick_check=ok. Production backup completed at /opt/math-bot/backups/announcement-predeploy-20261008T144440Z with all four existing DB backups validated. No code deployment, command registration or service restart has occurred. Live OAuth, Groq comparison and organizer shadow validation remain pending.
