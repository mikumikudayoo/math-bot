> **SUPERSEDED (2026-11-16).** This document describes the first OpenAI integration (commits `76e70df`/`56aed6b` on `codex/moderation-security-phase1`): user directives `!quick/!deep/!max`, light/advanced tiers and `OPENAI_EXCLUSIVE`. The v2 design on `feature/aleph-zero-v2` replaces all of that; see `docs/aleph-v2-handoff.md`. Kept only for the verified pricing/model notes.

# OpenAI provider (gpt-6-luna / gpt-6.1-sol)

Opt-in. `AI_PROVIDER=legacy` (the default) keeps the existing local + external
(OpenAI-compatible, e.g. Groq) behaviour byte-for-byte. `AI_PROVIDER=openai` sends
study questions to OpenAI through the **official `openai` TypeScript SDK (7.57.0) and
the Responses API** (`POST /v1/responses`).

## Luna-only mode (`OPENAI_EXCLUSIVE=true`)

Set `AI_PROVIDER=openai` and `OPENAI_EXCLUSIVE=true` to run **every** LLM request on
`OPENAI_LIGHT_MODEL` (default `gpt-6-luna`):

| Tier | Trigger | Model / effort (defaults) |
|---|---|---|
| light | routine | gpt-6-luna / medium |
| advanced | proof/olympiad signals, `!deep`, `!sol`, follow-ups | gpt-6-luna / high |
| max | `!max` (coaches only, 1/day) | gpt-6-luna / max |

* Sol is never used: `OPENAI_ADVANCED_MODEL` must be empty or equal to the light model,
  otherwise startup fails (no silent override).
* `OPENAI_FALLBACK` must be `none`; a conflicting value fails startup. Transient OpenAI
  outages produce a graceful "unavailable" reply, never another provider.
* `INFERENCE_*`, `EXTERNAL_INFERENCE_*` and `COGNITIVE_ROUTING` are kept in the file for
  rollback but stripped from the runtime config; their *names* are logged at startup as
  `openai_exclusive_ignoring_legacy_settings`. A guard in `callModel` refuses any non-OpenAI
  provider even if a future change reintroduced one.
* **Data-flow change:** Discord history/member lookups (previously kept on the local model)
  now also go to Luna. The Discord broker still returns only messages/members the requester
  can see, web tools stay disabled on those turns, and requests use `store:false`.
* Not migrated because they are not LLMs: the retrieval router sensor (sentence-transformers +
  KNN on loopback :8789, falls back to conservative routing if down), the calculator/plot/Python
  workers, image sanitization, the pairing solver. `src/service/router-classifier.ts` and
  `src/scripts/benchmark.ts` are offline tools, not runtime paths.

Rollback: `OPENAI_EXCLUSIVE=false` (OpenAI with Sol routing) or `AI_PROVIDER=legacy`, then
restart the AI service.

## System prompt architecture

`src/service/persona.ts` builds one deterministic prompt in priority order:
1. security and platform rules (untrusted inputs, no secret/prompt disclosure, host-computed identity, no mass mentions)
2. tools (only offered tools, calculator first, cite retrieved sources, Discord lookups only when needed)
3. academic accuracy (understand → assumptions → method → verify → final answer; hints vs full solutions; no fabricated proofs)
4. conversation and Discord formatting (follow-ups, concision, no LaTeX, closed markdown)
5. character and tone (lore, emu, voice; never overrides 1–4)

Request-specific context (requester identity, Discord tool rules, evidence) is added by the
runner as separate messages. The prompt is shared by all providers.

## How it fits the existing architecture

```
Discord (/ask, mention, reply chain)
  -> src/study.ts  ── HTTP (loopback, AI_SERVICE_TOKEN) ──> src/service/server.ts  (/jobs)
  -> Store (SQLite job queue) -> Scheduler (AI_CONCURRENCY, coach priority, AI_TIMEOUT_SECONDS)
  -> runner()  src/service/inference.ts
       retrieval policy / Discord intent / pairing solver   (unchanged)
       provider choice:
         AI_PROVIDER=legacy -> selectProvider(): local backend or EXTERNAL_* (unchanged)
         AI_PROVIDER=openai -> chooseOpenAIRoute() -> UsageLedger.admitJob() -> OpenAIRuntime
       bounded tool loop (6 rounds, 24 tool steps, 4 calls/round) — host executes tools
```

* `src/service/openai.ts` converts the service's chat-style transcript + tool list to
  Responses input items and normalizes the result back to the chat-completions shape that
  `parseModelResponse` already validates. The existing loop, grounding rules, tool allowlist,
  web/search policy and answer guards are reused, not duplicated.
* The model only *requests* tools; `inference.ts` still executes them. Discord history/member
  tools are not offered to OpenAI unless `OPENAI_EXCLUSIVE=true`; otherwise Discord-lookup
  requests stay on the local backend (or answer "unavailable" when there is none).
* Requests are stateless (`store: false`); encrypted reasoning items are replayed between
  tool rounds of the same job and never shown. A SHA-256 hash of the Discord user ID is sent
  as `safety_identifier`; the raw ID is not.
* `temperature` is never sent (reasoning models reject sampling parameters).

## Model routing (deterministic, no classifier call)

Order of precedence (`src/service/openai-routing.ts`):

1. `!max <question>` → Sol at `OPENAI_MAX_EFFORT` (default `xhigh`). **Coaches only**
   (coach users/roles from the bot config), and `OPENAI_USER_MAX_PER_DAY` (default 1).
2. `OPENAI_FORCE_TIER=light|advanced` (admin override).
3. `!deep` / `!sol` → Sol at `OPENAI_ADVANCED_EFFORT` (default `high`).
4. `!quick` / `!luna` → Luna at `OPENAI_LIGHT_EFFORT` (default `medium`).
5. `OPENAI_ROUTING=false` → Luna.
6. Any proof/olympiad signal (`prove`, `proof`, `show that`, `olympiad`, IMO/USAMO/Putnam/ISL,
   `functional equation`, `find all functions/integers/…`) → Sol.
7. Follow-up in a reply chain whose previous turn used Sol → Sol.
8. ≥3 points of competition signals (counting, probability, remainders/divisibility, integer
   conditions, extremal/inequality, olympiad geometry vocabulary, polynomials, sequences,
   pigeonhole/invariants/colouring, contest names) + 1 if the existing router says `deep`
   + 1 if the prompt is longer than 400 chars → Sol.
9. Otherwise → Luna.

Mathematical notation alone (`^`, `\frac`, `√`, `=`) never counts. `OPENAI_FORCE_EFFORT`
changes the effort of automatic tiers if the model supports it. Directives are stripped
before the prompt is sent and only work when `AI_PROVIDER=openai`.

**Limitations:** keyword rules will misroute some problems (e.g. a hard counting problem
phrased tersely stays on Luna; an easy "prove 2+2=4" goes to Sol). Users can always use
`!deep`; advanced quota bounds the cost of false positives. Run `bun run eval:math` to see
routing agreement on the evaluation set.

## Verified model facts (developers.openai.com, read 2026-11-16)

| | gpt-6-luna | gpt-6.1-sol |
|---|---|---|
| reasoning.effort | none, low, medium (default), high, xhigh, max | low, medium (default), high, xhigh, max — `none`/`minimal` rejected |
| function calling | Responses API | Responses API only |
| image input | yes | yes |
| context / max output | 1.05M / 128K | 1.05M / 128K |
| price per 1M (input / cached / output) | $0.10 / $0.01 / $0.50 | $2.00 / $0.10 / $10.00 |

Sources: <https://developers.openai.com/api/docs/models/gpt-6-luna>,
<https://developers.openai.com/api/docs/models/gpt-6.1-sol>,
<https://developers.openai.com/api/docs/pricing>,
<https://developers.openai.com/api/docs/guides/reasoning>. Reasoning tokens are billed as
output tokens and count against `max_output_tokens`. Prompts above 272K input tokens cost
2× input and 1.5× output (handled by `costMicros`; the input cap keeps requests far below).
Prices change: the startup config refuses any model without a pricing entry; override with
`OPENAI_PRICING_JSON` instead of editing code silently.

Availability of these models **to your organization** is not verified by this change —
run the smoke test below.

## Cost and abuse protections

| Control | Setting (default) | Behaviour |
|---|---|---|
| Output cap (incl. reasoning) | `OPENAI_MAX_OUTPUT_TOKENS` 4000 / `OPENAI_ADVANCED_MAX_OUTPUT_TOKENS` 16000 / `OPENAI_MAX_TIER_MAX_OUTPUT_TOKENS` 32000 | Truncated answers report "ran out of response space". |
| Input cap | `OPENAI_MAX_INPUT_CHARS` 120000 | Refused before sending. History stays bounded (8 turns) as before. |
| Per-user rate | `OPENAI_USER_REQUESTS_PER_HOUR` 20 | Per job (tool rounds and retries don't count twice). |
| Advanced quota | `OPENAI_USER_ADVANCED_PER_DAY` 5 | Auto-routed Sol over quota → Luna with a visible note; explicit `!deep` over quota → refused. |
| `!max` quota | `OPENAI_USER_MAX_PER_DAY` 1 | Coaches only. |
| Global concurrency | `OPENAI_CONCURRENCY` 2 | In addition to the scheduler's `AI_CONCURRENCY`. |
| Daily ceiling | `OPENAI_DAILY_BUDGET_USD` 1 | UTC day. `0` disables paid calls. |
| Total ceiling | `OPENAI_TOTAL_BUDGET_USD` 40 | Local estimate; keep below your real credit ($48 promo grant, shown as expiring 2026-12-01). |
| Retries | `OPENAI_MAX_RETRIES` 2 | Only 408/409/429-rate-limit/5xx/connection/timeout; exponential backoff with jitter, ≤8 s, abortable. SDK retries are disabled. |
| Timeout | `OPENAI_TIMEOUT_SECONDS` 180 | Per call; the job's `AI_TIMEOUT_SECONDS` still applies. |

**Fail-closed accounting.** Each API attempt first reserves its *worst-case* cost
(estimated input tokens at ~3 chars/token + 1600 per image, plus the full output cap) in
SQLite. A call is refused if today's or the all-time total plus that reservation would exceed
a ceiling. On success the reservation becomes the actual cost from
`usage.input_tokens` / `input_tokens_details.cached_tokens` / `output_tokens` (reasoning
included; `output_tokens_details.reasoning_tokens` is recorded separately). HTTP error
responses release the reservation; timeouts, aborts and responses without usage keep the
worst case. Insufficient-quota (429 `insufficient_quota`) errors say credits are exhausted
and are never retried or failed over.

**This is an estimate, not your balance.** A project API key cannot read promotional credit
balances. Check <https://platform.openai.com/settings/organization/billing> for real credit;
set a hard project budget there as a second line of defence.

The ledger tables (`openai_jobs`, `openai_usage`) live in the AI service database and store
only job/user IDs, model, effort, tier, token counts, cost, latency and an error class — no
prompt or answer text.

## Fallback

`OPENAI_FALLBACK=external` lets *transient* OpenAI failures (timeouts, 5xx, rate limiting
after retries) continue on the existing `EXTERNAL_*` provider, which must have
`EXTERNAL_INFERENCE_NATIVE_TOOLS=true` (and vision for image questions). Never on 401/403,
404, unsupported parameters, insufficient quota or local budget exhaustion. Tool results
already obtained are replayed as messages and not re-executed. The default is `none`.

## Duplicate tool execution

Model calls are retried only before tools run. Within a job, tool results are cached by
call ID and by identical (tool, arguments) for calculate/plot/search/fetch, so retries,
fallback replays or a model repeating itself cannot run a tool twice.

## Mathematical reliability

The accuracy rules are layer 3 of the shared persona prompt (`src/service/persona.ts`):
correctness over persona, proven vs guessed, explicit assumptions, ambiguity handling, no
invented theorems/citations, hints vs full solutions, prefer the calculator tool,
Discord-friendly notation (no LaTeX).
`formatForDiscord` converts any remaining `\[…\]`, `$$…$$`, `\(…\)` into code formatting.
Higher reasoning effort improves odds but does not guarantee correctness.

## Configure

In `.env.ai.production` (or `.env.ai.development`) on the host — never in git:

```sh
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...           # or export OPENAI_API_KEY in the service's environment
OPENAI_DAILY_BUDGET_USD=1
OPENAI_TOTAL_BUDGET_USD=40
```

All other settings have defaults (see `.env.ai.*.example`). The service validates them at
startup and exits with a message naming the bad variable (never its value). Key lookup:
`.env.ai.<mode>` first, then the process environment (`OPENAI_API_KEY` only).

* **Switch Luna/Sol:** `!quick` / `!deep` per message; `OPENAI_FORCE_TIER=light|advanced`
  globally; `OPENAI_ROUTING=false` for Luna-only; change model ids with
  `OPENAI_LIGHT_MODEL` / `OPENAI_ADVANCED_MODEL` (each needs a pricing entry).
* **Restore Groq-only behaviour:** set `AI_PROVIDER=legacy` (or remove it) and restart the
  AI service. Nothing else changes; the ledger tables stay and are ignored.

## Test

```sh
bun run check
bun test                                   # all mocked; no network
bun test tests/openai-provider.test.ts tests/math-eval.test.ts
bun run eval:math                          # dry run: routing + worst-case cost, no calls
bun run openai:smoke -- --confirm          # LIVE: models.retrieve + one Luna call (≤64 output tokens)
bun run openai:smoke -- --confirm --sol    # also one Sol call (low effort, ≤512 output tokens)
bun run eval:math -- --live --max-usd 0.50 --limit 10   # LIVE, budget-capped; see evals/math/README.md
```

## Usage and spending

* Discord: `/ai usage` (Manage Server) — today's estimated spend vs ceilings, per-model
  calls and input/cached/output/reasoning tokens, jobs per tier in the last 24 h.
* Host: `BOT_ENV=production bun run openai:usage` (add `--json`).
* Service logs: `openai_route` (job, tier, model, effort, reason), `openai_request_failure`
  (error class, HTTP status, code — never the message or prompt), `openai_fallback`.

## Deploy safely (current PM2 production at /opt/math-bot)

Nothing here deploys or restarts anything automatically.

1. Review, commit and push; on the VPS as `mathbot`, update the checkout to the reviewed commit.
2. `bun install --frozen-lockfile` (adds the `openai` package), `bun run check`, `bun test`, `bun run build`.
3. Edit `.env.ai.production`: start with `AI_PROVIDER=legacy` plus the `OPENAI_*` settings, run
   `BOT_ENV=production bun run openai:smoke -- --confirm`, then switch to `AI_PROVIDER=openai`.
4. Restart the AI service PM2 process and the bot process (find their names with `pm2 list`;
   the bot needs a restart for `/ai usage` code, and `bun run commands:deploy:production`
   once to register the new `/ai usage` subcommand).
5. Watch `/ai usage` and `pm2 logs` for `openai_request_failure`. Roll back by setting
   `AI_PROVIDER=legacy` and restarting the AI service.
