# Running the expanded bot

## Local WSL

`bun run setup:local` generates a local service secret, copies it into the bot and AI environment files, and preserves Discord credentials. It never selects a model. This has already been run in this checkout.

In one Ubuntu terminal run `bun run service:dev`. In another run `bun run dev`. After changing command definitions run `bun run commands:deploy:dev` separately.

Use the Bun version in `.bun-version` (also pinned in `package.json`). `bun install --frozen-lockfile` is the release/clean-checkout install; `bun install` updates the committed `bun.lock` when intentionally changing dependencies. Run `bun run check`, `bun test`, `bun run build`, and `.venv/bin/python -m unittest discover -s python -p test_math.py`. `bunfig.toml` limits discovery to `tests`; the Python-backed integration test has an explicit 30-second timeout for WSL startup. Bun 1.4.2 supports the existing `node:sqlite` adapter, so database schema and persisted state are preserved without a storage migration.

Python tools use `.venv/bin/python`. On a new machine run `bash scripts/setup-python.sh`; install the distribution's python3-venv package first if ensurepip is unavailable. This checkout used a project-local pip bootstrap from https://bootstrap.pypa.io/get-pip.py because the installed WSL Python lacked ensurepip. System Python was not modified.

## Commands

The study commands `/ask`, `/calculate`, `/plot`, `/python`, `/cancel`, `/queue`, and every `/ai` subcommand require the tester allowlist during private testing. This includes deterministic tools in the shared study suite. `/ping`, `/filter`, and `/qotd` retain their existing permissions and do not require tester access.

| Command | Purpose |
| --- | --- |
| `/ask question [image]` | Queued model answer; optional native vision |
| `/calculate expression [operation]` | Arithmetic, simplify, differentiate, integrate, solve expression=0 for x |
| `/plot expression [min] [max]` | Sampled PNG plot |
| `/python code` | Optional Docker sandbox; disabled by default |
| `/cancel request` | Cancel your own queued or running request |
| `/queue` | Show your accepted requests, including recoverable request IDs |
| `/ai enable`, `/ai disable`, `/ai status` | Manage Server permission; persistent assistance admission state |
| `/filter add`, `/filter remove`, `/filter list` | Manage Messages permission; empty rule list by default |

Disabling assistance rejects new study jobs (including calculator, plot, and Python). It does not stop accepted queued/running jobs or moderation. Jobs and admission state survive service restarts. Interrupted running jobs are requeued; inference is at least once after a crash. Delivery edits a persistent bot message instead of relying on an interaction token that expires. Long answers are attached as text. Reply conversations are restricted to the original user and channel and include up to eight prior turns. Reply to a completed answer.

## Discord permissions and message features

For the new commands grant Send Messages, View Channel, Read Message History, and Attach Files in the relevant channels. Do not grant Administrator.

Reply-chain conversations and server-wide filtering require **Message Content Intent** in the Developer Portal, followed by `MESSAGE_FEATURES_ENABLED=true` in `.env.development` and a bot restart. Filtering covers new and edited messages, exempts bots and members with Manage Messages, matches whole words/phrases with Unicode normalization, and writes audit entries in SQLite. Set `MOD_LOG_CHANNEL_ID` for Discord notifications. It fails open if its service is down; it is not a replacement for Discord AutoMod. No screenshot word list was imported.

## Private AI testing

Configure the **bot** environment file, `.env.development` locally or `.env.production` on the VPS:

```ini
AI_TESTER_USER_IDS=821682594830614578
MESSAGE_FEATURES_ENABLED=true
```

The allowlist is a comma-separated list of Discord user IDs. Whitespace and duplicate entries are handled; malformed IDs stop startup rather than broadening access. Empty/missing values deny everyone. To add another tester later, append their ID to the same variable; no source edit or command-definition update is needed. This variable belongs in the bot configuration, not `.env.ai.*`.

The command registry enforces tester membership before every private command handler. The shared study submission helper also checks it, and the message handler checks membership and `MESSAGE_FEATURES_ENABLED` before any conversation lookup or inference request. Moderator/admin/owner status and coach roles never bypass membership; `/ai` still additionally requires its existing Manage Server permission. Non-testers receive an ephemeral slash-command rejection and their AI mentions/replies are silently ignored. Moderation continues independently for everyone's messages.

Allowlisted users may start a conversation with `@bot <prompt>` (a leading direct mention, not a role mention) or `/ask`, and reply to their own completed answers. A mention inside a reply uses one submission, not two. Mention-only messages with no prompt, bot messages, and DMs are ignored. Existing service-token authentication, admission state, per-user limits, coach scheduling, cancellation ownership, and accepted queued jobs are unchanged. Removing a tester blocks future entry; it does not cancel work already accepted. Replies and results still use ordinary channel messages, so use a private test channel if the answer content should also be private.

Private command definitions set `default_member_permissions` to `"0"`, disabling them for ordinary members by default. After **manually** registering definitions, open **Server Settings → Integrations → this bot**, select each private command, and add an allow override for the tester (needed when the tester is not an Administrator). Keep ordinary commands enabled according to their normal permissions. Discord admins may still see/invoke the commands in the UI, but the bot rejects non-allowlisted admins. Per-user overrides are guild-specific and are not embedded in slash-command JSON; API updates require separate OAuth authorization, so this project does not automate them with its bot token. See [Discord command permissions](https://docs.discord.com/developers/interactions/application-commands#permissions).

After configuration/code changes:

1. Rebuild with `bun run build` for compiled deployments and restart the **Discord bot process** using your normal manual deployment/restart procedure. The AI service does not need a restart solely for this allowlist change. Development uses `bun run dev`; restart it after environment/intent changes.
2. Enable **Message Content Intent** in the Developer Portal before enabling message features. This setting alone never grants AI access.
3. To apply the reduced command visibility, manually run `bun run commands:deploy:dev` for the test server, or `bun run commands:deploy:production` only when deliberately updating production. No command registration occurs on startup. The allowlist enforces access even if old public command definitions are still registered.
4. Apply tester-specific command overrides in each server as described above. Future allowlist-only changes need a bot restart and corresponding Discord overrides for new non-admin testers, but no command re-registration.

## Model and queue configuration

Edit `.env.ai.development`: `INFERENCE_BASE_URL` is a trusted OpenAI-compatible chat-completions endpoint (often ending in /v1), `INFERENCE_MODEL` identifies the candidate, and `INFERENCE_API_KEY` is optional for authenticated backends. The reported production candidate is Phi-4-mini-instruct-GGUF Q4_K_M through llama.cpp; keep benchmarking its quality. See [reliability](reliability.md) for orchestration settings. No connection to the music AI is made. Local HTTP inference is allowed only on loopback; remote/home backends require HTTPS and should require authentication. Do not expose the study service port publicly; it binds only to loopback and uses its own shared secret.

`AI_CONCURRENCY` defaults to 1. `COACH_RESERVED_SLOTS` must be below total concurrency; default 0. Enable reserved-slot borrowing explicitly if wanted. Coach jobs take the next eligible slot without preempting ordinary work. Set `COACH_ROLE_IDS` or `COACH_USER_IDS` in the bot file. At most two accepted jobs per user/server and one active job per user/server are allowed. The global queue has a configurable limit and job timeout.

`INFERENCE_VISION=true` requires a backend/model that actually accepts native image inputs. PNG/JPEG attachments are bounded, decoded under resource limits, resized and stripped of metadata before model submission. Expired Discord image URLs may need reattachment. Web search requires `BRAVE_SEARCH_API_KEY`; URL fetching can work without search. Web fetch uses public HTTPS only, validates and pins DNS results, rechecks redirects and limits bytes/time. Tool output is untrusted evidence; the model cannot invoke arbitrary shell commands or change queue/moderation settings. These controls reduce prompt-injection risks; source truth and model citations still need human judgment.

## Optional Python sandbox

Docker is not installed by this change. Build the local image with `docker build -t math-bot-python:local python`, then set `PYTHON_SANDBOX_ENABLED=true` only after validating the isolation on your host. The runtime denies network, host mounts and capabilities and uses a non-root UID, read-only filesystem, CPU/memory/process/output/time limits and a temporary filesystem. No unsandboxed fallback exists. The model tool list does not expose arbitrary Python; `/python` is explicit. The default image has only the Python standard library. Containers share the host kernel: use a separate hardened worker/VM for hostile public workloads. The production service template does not grant access to a Docker socket; provision a separately reviewed sandbox worker before enabling there.

## Manual VPS rollout (not performed)

1. Provision Oracle ARM VPS and a `mathbot` service user, Bun matching .bun-version, Python/venv and Git. Benchmark models on its actual 3 cores / ~23 GB RAM before choosing one.
2. Prepare `/srv/math-bot/repo` as a clone of the GitHub source of truth; `/srv/math-bot/shared` holds production environment files and persistent data. Use a distinct production Discord application and service secret. Set production bot URL to port 8788, AI port 8788, and database to `/srv/math-bot/shared/data/production.sqlite`.
3. Install/review the two systemd unit templates in `deploy/`, install the pinned Bun binary at /usr/local/bin/bun (accessible to mathbot with ProtectHome=true) or adjust both unit paths, and allow the deployment account the specific restart/status commands it needs. Do not broadly grant passwordless sudo.
4. Review, commit and push locally. On the VPS manually run `bash scripts/deploy-vps.sh FULL_COMMIT_SHA`. It creates a release from origin, verifies the pinned Bun version, installs with `bun install --frozen-lockfile`, checks/builds with Bun, switches the current symlink, restarts services and rolls back on startup/health failure. The Bun on the deployment account's PATH must match the version installed for both systemd units. No GitHub push triggers a deploy. Review migration compatibility before relying on binary rollback with persistent data. Do not run simultaneous service instances against the same SQLite file. Rollback across the initial runtime migration also requires restoring the previous service-unit runtime configuration if that old release does not support Bun.
5. Confirm Discord login in journal logs. Register production commands separately with `bun run commands:deploy:production`. This explicitly confirmed command replaces the production app's global command set and compares its own successful JSON snapshot. The deploy script does not register commands or select a model.

`bun run benchmark` tests the configured candidate with basic math/science/English prompts and saves timing and answers under `data/benchmarks`. This is a starting harness, not a quality ranking; manually review answers, add your worksheets/vision tests, measure peak RAM and test concurrent requests on the VPS. The optional home GTX 1080 uses the same configurable endpoint contract; no tunnel is created.

SQLite contains prompts, answers, job state and moderation audit data. Back it up with SQLite's backup mechanism (not a blind copy of a live WAL database). No automatic retention purge is enabled yet; decide your server's retention policy before collecting production conversations.
