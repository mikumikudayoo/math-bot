# Aleph-Zero v2 — handoff to Codex (2026-11-16)

Status: **checkpoint only.** Phase 1 (reconcile onto the production lineage) is done and
verified locally. Phases 2–8 have a tested foundation and written contracts but are **not
implemented end to end**. Nothing was deployed. Production was only read, never written.
The development computer was not shut down (the owner asked for it to stay on).

"Confirmed" below means observed by running a command in this session.

## 1. Where the work is

| | |
|---|---|
| Worktree | `D:\devstuff\math-bot\.worktrees\luna-production-port` (WSL: `/mnt/d/devstuff/math-bot/.worktrees/luna-production-port`) |
| Branch | `feature/aleph-zero-v2` (local only, **not pushed**) |
| Base | `ce2e61e` = `origin/feature/announcement-automation` = what production runs (confirmed) |
| Commits | `1176a25` feat(ai): OpenAI v2 foundation on the production lineage |
| | `35caede` wip(ai): draft tool pool, regex tool and trusted identity fields |
| | + the commit that adds this file (see `git log -1`) |
| Uncommitted | none at handoff (`git status` clean) |
| Upstream | none. The branch was created from `origin/feature/announcement-automation`; its upstream was **unset on purpose** so a plain `git push` cannot land on the production branch. Push with `git push -u origin feature/aleph-zero-v2`. |

The main checkout `D:\devstuff\math-bot` is on `codex/moderation-security-phase1` at `56aed6b`
(the earlier, now superseded OpenAI integration; pushed). It has three pre-existing untracked
items that are not mine and were left alone: `.worktrees/`, `docs/aleph-v121-cancellation.md`,
`docs/aleph-v121-cancellation.patch`. **Do not merge that branch into this one** — it forked
from `main` (`7832d86`) and lacks 37 production commits (announcements, privacy phases).
Everything worth keeping from it has been re-implemented here.

### Toolchain (confirmed)
- Use the pinned Linux Bun 1.4.2 through WSL; Windows `bun` is the wrong version:
  `wsl.exe -e bash -lc 'cd /mnt/d/devstuff/math-bot/.worktrees/luna-production-port && export PATH="/mnt/d/devstuff/math-bot/.cache/bun/bin:$PATH" && bun run check && bun test'`
- `tsconfig.json` type-checks `src/` only; tests are transpiled but never type-checked.
- `OPENAI_API_KEY` was present in the Claude Code Bash environment (not in WSL; pass it with
  `WSLENV="OPENAI_API_KEY:$WSLENV"`). It is in no file in the repo. Never print it.

### Production (confirmed, read-only)
- SSH alias `oracle-vps` exists in **WSL** `~/.ssh/config` (user `ubuntu`, host 134.185.83.193).
  Windows `~/.ssh` has no key, so run ssh through `wsl.exe -e bash -lc 'ssh oracle-vps ...'`.
- `/opt/math-bot`, branch `feature/announcement-automation`, HEAD `ce2e61e`, clean; files owned
  by `mathbot` (`sudo -n -u mathbot ...` works for ubuntu).
- PM2 (user `mathbot`): `aleph-zero-bot`, `aleph-zero-ai`, `aleph-zero-automation`, all online,
  run with `/usr/local/bin/bun`. 4 cores, 24 GB RAM, 55 GB free.
- Whether `.env.ai.production` on the VPS already contains an OpenAI key was **not** checked.

## 2. Test status (confirmed)

| Run | Result |
|---|---|
| Baseline at `ce2e61e` (before any change) | 825 pass, 2 environment failures (below) |
| Now (`35caede`) | **831 pass, 2 fail, 1 error** — same two failures; `bun run check` clean |

Pre-existing, environment-only failures (not regressions; they need Python packages that this
WSL lacks):
1. `tests/integration.test.ts` › "model adapter invokes allowed calculator and returns final
   answer from mock backend" (SymPy calculator worker).
2. `tests/vision-attachments.test.ts` › "Unhandled error between tests" (fixture generation
   needs Pillow).

New: `tests/openai-chokepoint.test.ts` (6 tests) — provider stripping, v2 config rules, every
runner call lands on `gpt-6-luna` at `low` effort with the legacy fetch never called, budgets
failing closed before any call, escalation quotas, and Responses streaming.

Live API calls made this session (all correct, total estimated cost under $0.002): tiny
`gpt-6-luna` and `gpt-6.1-sol` smoke calls, and four runner prompts on the *old* branch.
**`gpt-6.1-terra` has not been called live**; only its documentation was read. No live call
has been made against this branch.

## 3. What is implemented (commit `1176a25`)

| File | State | What it does |
|---|---|---|
| `src/service/providers.ts` | wired, tested | `ProviderConfig.kind?: 'openai'`; `completeProvider` dispatches such providers to `completeOpenAI` → the budgeted runtime. Transient failures become `ProviderBackoff` (existing durable-queue behaviour); nothing ever switches provider. |
| `src/service/config.ts` | wired, tested | `serviceConfigFrom(env, mode, inherited, warn)` (pure). With `AI_PROVIDER=openai`: `backend/model` become Luna, `kind:'openai'`, `external`/`cognitiveRouting`/legacy vision are removed, `visionProvider === config`. `LEGACY_PROVIDER_SETTINGS` names are logged, values never. |
| `src/service/openai-config.ts` | tested | v2 settings (section 5). `clampEffort`, `describeOpenAIConfig`. |
| `src/service/openai-budget.ts` | tested | `UsageLedger` (tables `ai_requests`, `openai_usage`), `costMicros`, `Semaphore`, `formatUsageSummary`. |
| `src/service/openai.ts` | tested | `OpenAIRuntime.complete` (Responses API, optional real streaming via `onTextDelta`), error classification, chat↔Responses conversion, `openaiContext` (AsyncLocalStorage), `installOpenAIRuntime`. |
| `src/service/inference.ts` | wired, tested | Builds/installs the runtime when `config.openai`; charges the hourly limit once per `ask` job; runs `infer()` inside `openaiContext`. The two inline prompts now come from `persona.ts`. The legacy loop itself is otherwise untouched. |
| `src/service/persona.ts` | used | `ALEPH_SYSTEM_PROMPT` (5 layers: security, tools, academic accuracy, conversation, character) and `ALEPH_CONVERSATION_PROMPT`. All phrases asserted by `persona-v1`, `reliability`, `speaker-scope-hotfix` tests are preserved. The creator's raw ID is deliberately **not** in prompt text (existing tests forbid it). |
| `src/service/server.ts` | wired | `GET /usage`, `provider` in `/health`, startup log of the OpenAI config. |
| `src/service/events.ts` | **contract only** | `JobEvents` (tables `job_events`, `job_progress`), `JobProgress`. Not instantiated anywhere yet. |
| `src/service/context-snapshot.ts` | **contract only** | `ContextSnapshot` type, `contextSnapshot()` validator, `renderContext()`. Not used yet. |
| `src/scripts/openai-smoke.ts`, `openai-usage.ts` | usable | `--confirm [--terra] [--sol]`; usage CLI. |
| `evals/math/problems.json`, `src/scripts/math-eval-grade.ts` | data + grader only | The eval **runner and its test were removed** (they depended on the retired routing module). `evals/math/README.md` still describes the removed runner. |
| `docs/openai.md` | superseded | Banner added; keep only for pricing notes. |

Commit `35caede` (drafts, typecheck only, **no tests, not wired**):
- `src/service/tool-pool.ts` — `runToolCalls` (bounded, order-preserving, error-isolating,
  exclusive groups, per-tool timeouts) and `LoopGuard` (soft/hard rounds, repeat/stall tracking).
- `src/service/regex-tool.ts` — RE2 (`re2js@2.10.0`, pure JS) regex tool with limits and a
  `regexToolDefinition`.
- `src/discord-context.ts` — `DiscordContext` gains host facts `isModerator`, `roles`,
  `sevenAgentTrigger`; `parseTrigger(content, botId)` detects a leading U+2063; `SpeakerFacts`
  gains `speakerIsModerator`. **Nothing sends these fields yet** (`study.ts` is unchanged), and
  `server.ts` currently passes `body.discordContext` through `currentUser`, which now preserves
  them.

### What actually happens today with `AI_PROVIDER=openai`
The **legacy** runner loop runs, with every model call going to `gpt-6-luna` at `low` effort
under budget control. That is "Luna-only", not the v2 orchestrator: still 6 rounds, sequential
tools, host-forced Discord/web routing, no consult tools, no streaming to Discord. Known rough
edges of this interim mode (untested live on this branch):
- The legacy loop keeps Phi-era guards (strict JSON envelopes for chat prompts, forced
  grounding selection JSON). `ALEPH_CONVERSATION_PROMPT` still ends with "Return JSON
  {"answer": ...}", which the legacy parser expects.
- `completeOpenAI` ignores the legacy `temperature`/`reasoning_effort` body fields (correct) and
  raises small `max_tokens` values to Luna's cap because reasoning tokens count against it.
- The announcement worker (`src/announcements/*`) still builds a Groq provider from
  `.env.automation.<mode>`; it does **not** use OpenAI yet (section 6, item 9).

## 4. Architecture decisions and invariants (keep these)

1. **One chokepoint.** All model traffic goes through `completeProvider`; OpenAI is selected by
   `provider.kind === 'openai'`. Do not add a second HTTP path to a model.
2. **Provider vs models are separate switches.** `AI_PROVIDER=openai` = OpenAI is the only
   provider (cannot be relaxed while set). `OPENAI_ALLOWED_MODELS` = which of luna/terra/sol may
   be called. Groq/local code stays for rollback (`AI_PROVIDER=legacy`) but is unreachable in
   openai mode because the config no longer contains those providers.
3. **`visionProvider === config === Luna` in openai mode.** The legacy runner treats
   `provider !== config` as "untrusted external provider" (blocks private Discord context,
   filters history). Keeping Luna as `config` preserves those checks. Consequence, already
   accepted by the owner earlier: private Discord lookups are sent to OpenAI (`store:false`).
4. **Budget fails closed and is atomic.** Every API attempt reserves worst-case cost in one
   `BEGIN IMMEDIATE` transaction against the request-class ceiling, the UTC-day ceiling and the
   total ceiling. HTTP error responses release the reservation; timeouts, aborts, broken streams
   and responses without usage keep it. Reasoning tokens are inside `output_tokens` (never added
   twice). The ledger stores no prompt/answer text. It is an estimate, not the account balance.
5. **Escalation is host-authorized.** `UsageLedger.authorizeEscalation(job, user, 'sol'|'terra'|'seven')`
   consumes a per-user daily quota once per job and raises the request class (and therefore its
   ceiling). Moderator/creator status grants nothing here. An ordinary ($0.02) request cannot
   afford a Sol call unless escalated — this is tested.
6. **Identity is a host fact.** `isCreator` = authenticated user id === `821682594830614578`,
   nothing else. `isModerator`/`sevenAgentTrigger` must be strict booleans computed by the bot
   from Discord permissions / raw message content. Speaker facts must never expose raw IDs or the
   account username (existing tests).
7. **Users cannot pick models or effort.** The old `!quick/!deep/!sol/!max` directives were not
   ported, and the retired env settings (`OPENAI_FORCE_TIER`, `OPENAI_ADVANCED_MODEL`,
   `OPENAI_LIGHT_MODEL`, `OPENAI_ROUTING`, `OPENAI_FALLBACK≠none`) stop startup.
8. **Luna never runs with `none` reasoning.** Config rejects `OPENAI_LUNA_EFFORT` below `low`.
9. **Privacy primitives to reuse, not re-derive:** `TurnWebBoundary` (web tools off once
   private Discord context is seen; outbound URL allow-list), `provenance.ts`,
   `authorizePrivateHistory` + the host-only `discord_audience` tool, `study-audience.ts`
   (publication-time audience check), `network.ts` (SSRF), `output-url-policy.ts`.
10. **Do not stream text that still depends on a check.** Planned rule: no public streaming while
    `webBoundary.private`, while an MPoTD is protected and the request scored above the low
    watermark, or before output guards pass on the buffered text.

## 5. v2 settings (`.env.ai.<mode>`), all validated at startup

`AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_ALLOWED_MODELS=luna,terra,sol`,
`OPENAI_LUNA_MODEL=gpt-6-luna`, `OPENAI_TERRA_MODEL=gpt-6.1-terra`, `OPENAI_SOL_MODEL=gpt-6.1-sol`,
`OPENAI_LUNA_EFFORT=low`, `OPENAI_LUNA_MAX_EFFORT=high`, `OPENAI_TERRA_EFFORT=medium`,
`OPENAI_SOL_EFFORT=medium`, `OPENAI_TERRA_MAX_EFFORT=xhigh`, `OPENAI_SOL_MAX_EFFORT=xhigh`
(`max` only if set here), `OPENAI_{LUNA,TERRA,SOL}_MAX_OUTPUT_TOKENS=4000/6000/8000`,
`OPENAI_REQUEST_BUDGET_USD=0.02`, `OPENAI_TERRA_REQUEST_BUDGET_USD=0.08`,
`OPENAI_SOL_REQUEST_BUDGET_USD=0.10`, `OPENAI_BOTH_REQUEST_BUDGET_USD=0.15`,
`OPENAI_SEVEN_REQUEST_BUDGET_USD=0.15`, `OPENAI_SYSTEM_REQUEST_BUDGET_USD=0.05`,
`OPENAI_DAILY_BUDGET_USD=1`, `OPENAI_TOTAL_BUDGET_USD=40`, `OPENAI_TIMEOUT_SECONDS=180`,
`OPENAI_MAX_RETRIES=2`, `OPENAI_MAX_INPUT_CHARS=160000`, `OPENAI_CONCURRENCY=6`,
`OPENAI_USER_REQUESTS_PER_HOUR=30`, `OPENAI_USER_SOL_PER_DAY=4`, `OPENAI_USER_TERRA_PER_DAY=4`,
`OPENAI_SEVEN_PER_DAY=3`, `OPENAI_USER_SEVEN_PER_DAY=1`, `AI_SEVEN_AGENT_CHANCE=0.0001`,
`AI_SOFT_ROUNDS=32`, `AI_HARD_ROUNDS=64`, `AI_TOOL_CONCURRENCY=4`, `AI_IMAGE_CORRECTIONS=5`,
`AI_STREAMING=true`, optional `OPENAI_PRICING_JSON`.

**The `.env.ai.*.example` files have not been updated on this branch** (they still show the
production-lineage Groq settings). Many settings above are parsed but not yet consumed (rounds,
tool concurrency, image corrections, seven-agent chance).

Verified model facts (developers.openai.com, read 2026-11-16): prices per 1M tokens
input/cached/output — luna $0.10/$0.01/$0.50, terra $1/$0.05/$5, sol $2/$0.10/$10; efforts —
luna and terra `none, low, medium (default), high, xhigh, max`, sol `low … max` (`none` rejected);
all take image input; function calling requires the Responses API; >272K input tokens costs
2× input and 1.5× output. Streaming event names confirmed in the installed SDK types
(`openai@7.57.0`): `response.output_text.delta`, `response.completed`, `response.incomplete`,
`response.failed`, `error`, `response.reasoning_summary_text.delta`.

## 6. Remaining work, in dependency order

Legend: ☐ not started, ◐ foundation/draft exists.

1. ◐ **Orchestrator (Phase 2/3 core) — blocks almost everything else.**
   Recommended: new `src/service/orchestrator.ts`, called from `runner()` for `kind==='ask'`
   when `config.openai` is set, leaving the legacy loop intact for `AI_PROVIDER=legacy` (all 825
   legacy tests stay valid). Reuse the legacy preamble (history, images, `speakerFacts`,
   pairing/arithmetic shortcuts, `authorizePrivateHistory`, `TurnWebBoundary`) and the existing
   tool implementations (`mathTool`, `sandboxPython`, `search`, `fetchText`, `io.discord`).
   Loop: `LoopGuard` (soft 32 → inject a "assess progress and remaining budget" message once;
   hard 64 → return verified partial results), `runToolCalls` with `config.openai.toolConcurrency`,
   exclusive group for `discord_*`, result cache keyed by call id and `(name,args)` so nothing
   runs twice. Final-answer guards to keep: URL allow-list (only URLs returned by tools this turn
   or present in the user's message), vendor-creator and knowledge-cutoff claims, raw-ID leak,
   `sanitizePrivateOutputURLs` when private.
   The persona needs two more layers for this (orchestration, identity) — the requested order is
   security, tool authorization, mathematical accuracy, orchestration, Discord
   formatting/conversation, identity context, character. Drop the "Return JSON {"answer"}"
   sentence for the orchestrator path.
2. ☐ **`consult_terra` / `consult_sol` / `think_harder` tools** (needs 1). Arguments: task,
   context, proposed effort, reason, optional references to verified tool results. Host
   validates: `config.allowed[role]`, `clampEffort(config, role, requested, config.consultMaxEffort[role], config.consultEffort[role])`,
   `ledger.authorizeEscalation`, then `runtime.complete({role, purpose:'consult', …})` with **no
   tools**, no persona, and an instruction to end with a `FINAL:` line. Emit
   `consultation_requested/approved/denied/completed`. Fidelity: if Luna's final answer does not
   contain the specialist's `FINAL` value, send one reconcile message (bounded to one retry).
   `think_harder` raises Luna's effort for later rounds up to `config.lunaMaxEffort`.
3. ☐ **Events + streaming service side** (needs 1). Instantiate `JobEvents(store.db)` in
   `createService`, emit from the orchestrator, attach `progress` to `/pending` rows, add
   `GET /events?job=&after=`, call `events.stream()` from `onTextDelta` only when invariant 10
   allows, `events.retract()` on reset. Call `prune()` periodically.
4. ☐ **Bot delivery + Discord formatting** (needs 3). New `src/discord-format.ts`
   (sanitize tables/HTML/LaTeX, close fences, neutralize mass mentions, `splitDiscordMessage`,
   personality progress lines chosen deterministically from event phase/label — no model calls)
   and `src/delivery.ts` (rate-limited editor: ≥1.5 s between non-terminal edits, terminal
   priority, version guard so an old edit never overwrites the final, 429 `retry_after`
   handling, continuation messages, artifact on the last message only). Move `startDelivery`
   out of `src/study.ts` **without changing** its `studyDeliveryPayload` audience check.
5. ☐ **Discord context, bot side (Phase 4)**. `src/discord-snapshot.ts` producing a
   `ContextSnapshot` anchored at the triggering message (`before: message.id`), sent as `context`
   in `/jobs`; send `isModerator`/`roles`/`sevenAgentTrigger` via `discordIdentity(..., host)`
   and `parseTrigger` in `handleStudyMessage`. Service side: accept/validate with
   `contextSnapshot()`, store in a new `jobs.context` column, raise the `/jobs` body limit above
   20 000 bytes, render with `renderContext()` as a **user-role** message. Upgrade the existing
   `discord_search` in `src/discord-tools.ts` (channel/author/date/id filters, ranking, cursor
   pagination, latency bound) keeping the rule "requester can see it **and** the destination
   channel's whole audience can see it". The audience rule in `discord-tools.ts` was not audited
   in this session — read it before changing anything.
6. ☐ **MPoTD protection (Phase 5)**. Nothing exists. Planned API in
   `src/service/mpotd-guard.ts`: `loadProtectedProblems(guild)` reading the competition database
   read-only from the AI service, `guardRequest`, `guardOutput`, `redactProtected`,
   `refusalText`, `protectionNotice`. Hook points: before any model call (prompt, reply context,
   image transcript), tool arguments (python code, search queries, consult tasks), Discord search
   results, specialist output, streamed and final text. The authoritative "posted and not yet
   revealed" state lives in `src/qotd/` (`store.ts`, `competition.ts`, `posting.ts`); it was
   **not** investigated yet. Images need one extra Luna transcription call, made only when a
   problem is protected and the request has an image.
7. ☐ **Generated-image verification (Phase 7.2)** (needs 1). Validate the PNG (signature,
   dimensions, size, non-blank — `@napi-rs/canvas` is already a dependency), show the actual
   image to Luna as an `image_url` content part, require an explicit approve/reject tool call,
   allow `config.openai.imageCorrections` attempts, publish the artifact only if approved.
   Whether sandboxed Python can return an image today was not audited (`src/service/tools.ts`,
   `python/`).
8. ☐ **Seven-agent mode (Phase 7.7)** (needs 1, 2, 5). Roles miku, emu, ena, nene, kanade,
   kohane, mizuki (no kaidrix). Trigger: `sevenAgentTrigger && isModerator`, or
   `rng() < config.openai.sevenAgentChance`; then `authorizeEscalation(job, user, 'seven')`.
   Seven bounded Luna calls in parallel, no tools, no recursion; Luna synthesizes one answer.
9. ☐ **Announcement worker on OpenAI** (independent). `src/announcements/config.ts` hard-codes
   a Groq provider and `worker.ts` treats an empty `backendKey` as "misconfigured". Add an
   openai option that installs a runtime in that process sharing the AI database file as ledger.
   `extraction.ts` uses `response_format: json_schema, strict: true` — `toTextFormat` maps it,
   but the schema has **not** been tried against OpenAI's strict-schema rules.
10. ☐ **Verity easter egg.** The owner supplied the four exact question→response pairs in chat
    as the authoritative spec, then told me **not** to write that section (it tripped a content
    safeguard on my side). It is therefore absent from the repo. Requirements: the pairs go in the
    system prompt verbatim, Luna recognizes the questions herself (no regex interceptor), minor
    wording variations only, no preface or commentary, unrelated questions answered normally, all
    four pairs in regression tests. Get the text from the owner.
11. ☐ **Tests for the drafts and everything above**, the 8.2 integration scenarios, the eval
    runner rewrite (compare Luna alone / +Terra / +Sol / tools; budget-capped, opt-in),
    `.env.ai.*.example`, `docs/operations.md`, a `/ai usage` subcommand (existed on the old
    branch in `src/commands/study.ts`; not ported), `AI_CONCURRENCY=3` for production.
12. ☐ **Deployment.** Not started. Before touching production: back up `/opt/math-bot/data`,
    `.env*` and `dist`; `bun install --frozen-lockfile` (adds `openai`, `re2js`); `bun run check`,
    `bun test`, `bun run build`; the OpenAI key must reach `.env.ai.production` (I did not copy
    it — the owner should place it); start with `AI_PROVIDER=legacy`, run
    `BOT_ENV=production bun run openai:smoke -- --confirm --terra --sol`, then switch; restart only
    `aleph-zero-ai` and `aleph-zero-bot`; leave `aleph-zero-automation` alone until item 9 is
    verified. Rollback: `AI_PROVIDER=legacy` + restart `aleph-zero-ai`.

## 7. Known bugs, risks and gaps

- The two environment-only test failures in section 2.
- Drafts in `35caede` have no tests; treat them as unreviewed.
- `completeOpenAI` attributes calls without a job context to a synthetic `system:<uuid>` job in
  the `system` class ($0.05 ceiling each, user `system`): fine for the announcement worker, but it
  means such calls bypass per-user limits by design.
- `GET /usage` builds a new `UsageLedger` per request (cheap, but re-runs `CREATE TABLE IF NOT EXISTS`).
- `installOpenAIRuntime` is a process-wide singleton; tests that build several runners must
  reset it (`installOpenAIRuntime(undefined)`), as the new test file does.
- Interim Luna-only mode through the legacy loop has never run against the real API on this
  branch; do a bounded live check before relying on it.
- `evals/math/README.md` documents a runner that no longer exists.
- `docs/openai.md` is superseded; no v2 operator document exists yet besides this file.

## 8. Exact next steps for Codex

1. `cd` to the worktree, confirm `git status` is clean and `git log --oneline -4` shows the
   commits above; run `bun run check && bun test` (expect 831 pass, 2 fail, 1 error).
2. Read `src/service/inference.ts` fully (it is the security-critical file), then
   `src/discord-tools.ts`, `src/study.ts`, `src/study-audience.ts`, `src/service/turn-web-boundary.ts`.
3. Write tests for `tool-pool.ts` and `regex-tool.ts`; fix what they find.
4. Build `orchestrator.ts` (item 1) with mocked-client tests, then items 2 → 3 → 4.
5. Items 5 and 6 can proceed in parallel with 4; item 6 first needs the qotd state investigation.
6. Items 7, 8, 10, then 9, then 11.
7. Only then item 12, with a bounded live smoke test first.
