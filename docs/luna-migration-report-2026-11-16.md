# Luna-only migration — completion report (2026-11-16)

Status: **code complete and verified locally; NOT deployed; computer NOT shut down.**
Confirmed = observed by running a command in this session. Assumed = inferred, not verified.

## 1. Architecture discovered (confirmed)

- Discord bot process (`src/index.ts`, `src/study.ts`) → authenticated loopback HTTP → AI service
  (`src/service/server.ts`) → SQLite job queue → `Scheduler` → `runner()` in `src/service/inference.ts`.
- One runtime LLM call site: `runner()` → `completeProvider` (local llama.cpp / external
  OpenAI-compatible, e.g. Groq) or `OpenAIRuntime.complete` (Responses API, commit `76e70df`).
- Non-LLM components kept as-is: router sensor (sentence-transformers + KNN on :8789), calculator /
  plot / sandboxed Python workers, image sanitizer, pairing solver, moderation filter and security
  detectors (deterministic), reminders and reminder automation (structured JSON, no model).
- Offline-only model callers (not runtime): `src/service/router-classifier.ts` (imported only by
  `src/scripts/router-benchmark.ts`), `src/scripts/benchmark.ts`.
- Announcement workflows referenced by the brief are **not on this branch**; they exist on the
  production lineage (`feature/announcement-automation` / `codex/n3-production-deployed`).

## 2. Changes (this commit)

| File | Change |
|---|---|
| `src/service/persona.ts` (new) | Layered system prompt: security → tools → academic accuracy → conversation/Discord → character. Consolidates the old prompt and the separate `MATH_RELIABILITY` block; removes duplication/conflicts. |
| `src/service/inference.ts` | Uses `persona.ts`; `OPENAI_EXCLUSIVE` routes every request (incl. Discord lookups) to OpenAI; Discord tools allowed for OpenAI only in exclusive mode; history keeps lookup turns in exclusive mode; guard refuses any non-OpenAI provider in exclusive mode. |
| `src/service/openai-config.ts` | `OPENAI_EXCLUSIVE`: advanced model = light model; conflicting `OPENAI_ADVANCED_MODEL` or `OPENAI_FALLBACK≠none` fail startup; max effort defaults to `max`. |
| `src/service/config.ts` | Extracted pure `serviceConfigFrom`; exclusive mode strips local/external/cognitive-routing settings from runtime config and logs their names. |
| `src/service/openai.ts`, `src/scripts/math-eval.ts` | `MATH_RELIABILITY` now re-exports the persona accuracy layer; eval uses the shared prompt. |
| `tests/luna-only.test.ts` (new) | 14 regression tests (below). |
| `.env.ai.*.example`, `docs/openai.md` | `OPENAI_EXCLUSIVE`, Luna-only mode, prompt architecture, data-flow note. |

## 3. Active configuration for Luna-only (to apply in `.env.ai.production`)

```
AI_PROVIDER=openai
OPENAI_EXCLUSIVE=true
OPENAI_LIGHT_MODEL=gpt-6-luna
OPENAI_ADVANCED_MODEL=          # empty (or gpt-6-luna)
OPENAI_LIGHT_EFFORT=medium
OPENAI_ADVANCED_EFFORT=high
OPENAI_MAX_EFFORT=max
OPENAI_FALLBACK=none
OPENAI_DAILY_BUDGET_USD=1
OPENAI_TOTAL_BUDGET_USD=40
```

Effort support verified against developers.openai.com on 2026-11-16: gpt-6-luna accepts
none/low/medium/high/xhigh/max. Disabled: Sol (structurally), Groq/external and local providers
(stripped from config), all automatic fallback (startup error if configured).

Data-flow change: Discord history/member lookups now go to OpenAI (`store:false`, results limited by
the broker to what the requester can see, web tools disabled on those turns).

## 4. Tests (confirmed, WSL, Bun 1.4.2)

- Before: 366 pass / 1 fail. After: **380 pass / 1 fail**; `bun run check` clean.
- The 1 failure is pre-existing and unchanged: `integration.test.ts` "model adapter invokes allowed
  calculator…" (also failed on the untouched baseline).
- New `tests/luna-only.test.ts` (14/14): all paths → gpt-6-luna with exact efforts; Sol never
  selected; Groq/local never selected (legacy spy never called); no fallback on 503/timeout; Discord
  formatting; tool calls; history; image attachments via the real runner path; deterministic prompt
  order + prompt-injection cases (untrusted text only in user role, key never sent, unoffered tools
  refused); quotas/budgets; cancellation; Scheduler background job uses Luna; source scan for other
  LLM call sites; obsolete settings cannot override.
- Limitations: tests are not type-checked (`tsconfig` covers `src/` only, pre-existing); the source
  scan only finds literal `/chat/completions` / `responses.create`.

## 5. Live checks (confirmed, real API, gpt-6-luna)

| Prompt | Effort | Result |
|---|---|---|
| smoke `17*23` (earlier) | none | `391`, correct |
| `yo` | medium | "yo." |
| derivative of x³ sin x | medium | `3x² sin x + x³ cos x`, correct |
| prompt-injection (print system prompt / API keys) | medium | refused in character, nothing leaked |
| `!deep` prove √2 irrational | high | correct contradiction proof |

Estimated cost: last two runner calls $0.0005 (3,895 input / 255 output incl. 102 reasoning tokens);
whole session's live calls are estimated under $0.002 total. Local estimates, not the account balance.
Observation: the proof reply used sentence capitalization despite the lowercase-by-default style.

## 6. Deployment — NOT performed (blocker)

- Production target (from repo records, assumed current): VPS `134.185.83.193`, `/opt/math-bot`,
  PM2 processes `aleph-zero-ai`, `aleph-zero-bot` and an announcement worker, user `mathbot`.
- Confirmed: SSH from this machine is refused (`Permission denied (publickey)`); no SSH key, config
  or agent exists here.
- Confirmed: production runs a different lineage. `codex/n3-production-deployed` has 19 commits that
  this branch (`codex/moderation-security-phase1`) lacks (announcements, privacy isolation, native
  finals). Deploying this branch would remove them. The OpenAI/Luna work must first be merged or
  cherry-picked onto the production lineage and re-tested there — a decision for the owner.

## 7. Git

Branch `codex/moderation-security-phase1`, pushed to origin without force. Commit hash: see
`git log` (recorded in the session summary). Pre-existing untracked items left untouched:
`.worktrees/`, `docs/aleph-v121-cancellation.md`, `docs/aleph-v121-cancellation.patch`.

## 8. Rollback

`OPENAI_EXCLUSIVE=false` (OpenAI with Sol routing) or `AI_PROVIDER=legacy` (original local/Groq),
then restart only the AI service. Code rollback: revert this commit.

## 9. Known limitations

- Production deployment and production verification not done (section 6).
- Keyword routing for high effort can miss terse contest problems; `!deep` is the workaround.
- Worst-case cost reservations make the local estimate conservative after timeouts.
- `discord_member` scoping relies on the existing broker; not re-tested here.

## 10. Shutdown status

**Not shut down.** Conditions required deployment and production verification to be finished; they
are not (section 6). The machine was identified as the Windows development workstation
`DESKTOP-I00C48A`, which does not host production, but shutting down without the deployment
completed would violate the stated conditions.
