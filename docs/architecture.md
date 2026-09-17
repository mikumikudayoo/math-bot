# Architecture and next milestones

## Implemented
The package manager and JavaScript/TypeScript runtime are Bun, pinned in `.bun-version` and `package.json`. Releases install `bun.lock` with `--frozen-lockfile`. The compatible `node:sqlite` adapter and existing database schema remain unchanged; Python workers use their separate virtual environment.

Private testing adds a Discord-side gate for the entire study suite, mentions and reply conversations. Effective admission merges `AI_TESTER_USER_IDS` with persistent owner-managed testers in the separate admin database; both empty denies everyone. Admin, owner and coach permissions cannot bypass admission. Command metadata drives both runtime gating and default-disabled Discord visibility. Service authentication and accepted-job semantics remain separate and unchanged. Ordinary moderation/QOTD commands are not gated. See [admin tools](admin-tools.md) for runtime management and audit boundaries.

Discord.js + TypeScript with a shared slash-command registry and separate bot/study processes. Commands include /ping, /ask, /calculate, /plot, /python, /cancel, /ai, /filter and /qotd. The loopback HTTP service authenticates the bot with a separate secret. SQLite persists admission state, accepted jobs, bounded reply chains, output bindings, filter rules, audit entries.

The scheduler supports configurable concurrency, coach priority/reserved capacity with optional borrowing and no preemption. Accepted work survives disable and restart. Calculator/SymPy and plotting use a restricted AST parser and resource-limited Python subprocesses. The configurable model adapter supports native image inputs, bounded tool loops, public HTTPS fetch and optional Tavily search. Arbitrary Python requires the explicitly enabled Docker sandbox; no host execution fallback exists. The reported production backend is llama.cpp serving Phi-4-mini-instruct-GGUF Q4_K_M. See [reliability](reliability.md) for host-enforced retrieval and the non-native tool protocol.


Manual command registration compares JSON snapshots per app and scope, for both development guild and explicitly confirmed production global registration. No registration runs on startup. A manual VPS release script and systemd templates are provided but have not been deployed.

## Design requirements and continuing validation
- Discord gateway process calls a separate math/study AI service. This service is also separate from the existing YT Music-to-Spotify AI, including its config and credentials.
- Math, science, and English study support; reply-chain conversations with bounded context and retained image references.
- Configurable inference queues and per-user limits. Coach priority identified by user/role IDs, reserved capacity, optional borrowing, and no preemption. Benchmark concurrency; three CPU cores do not imply three concurrent generations.
- High-level, rate-limited progress updates: queued, thinking, calculating, searching, reading a source, plotting, examining image, preparing answer. Do not expose hidden reasoning.
- SymPy/calculator, plotting, web search/fetch with citations. Treat fetched content as untrusted data; enforce tool permissions outside prompts. Block private/local/metadata destinations, recheck DNS and redirects, restrict protocols, enforce size/time limits and isolate network access.
- Native vision for worksheets, handwriting, geometry and graphs; not an OCR substitute. Validate attachment formats and resource limits.
- Eventual sandboxed Python with execution/resource/network isolation. Optional home GTX 1080 backend via an authenticated service boundary, independent of Discord transport.
- Moderator /ai enable and /ai disable. Persist the per-server admission state (e.g. SQLite). Disabling rejects future prompts only; active and already-accepted queued jobs finish. Admission and state changes must be atomic. Test this contract before release.
- Separate server-wide moderation/filter module, independent of AI invocation. No screenshot word-list import. Use deliberate whole-word/phrase rules and contextual review; protect legitimate educational language.

## Infrastructure decisions

Current legacy production is `/opt/math-bot` with Bun, `python3`, and PM2 processes owned by `mathbot`. The `/srv/math-bot` exact-SHA release layout and systemd templates below are future targets, not the current installation. See [operations](operations.md) for the separate procedures.
Planned Oracle ARM/Ampere VPS: 3 CPU cores, approximately 23 GB RAM and 200 GB storage. Quality over speed. Continue to benchmark candidate reasoning and vision models on the actual VPS for answer quality, RAM, context limits and concurrency before choosing. The future layout has not yet replaced the current PM2 installation.

GitHub is the intended source of truth. Local changes require review, commit and push. No automatic production deployment. The manual VPS script selects an explicit revision, installs/builds, validates, restarts and supports rollback; validate it on the actual provisioned server before production use. Production uses a distinct Discord application and secrets. Model quality, native vision performance, queue tuning and home GPU connectivity still require real backend/VPS testing. Docker sandbox runtime validation awaits Docker installation. No live inference or production deployment is claimed.
