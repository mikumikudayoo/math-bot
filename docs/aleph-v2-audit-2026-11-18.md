# aleph-zero v2 audit and release candidate — 2026-11-18

Status: **release candidate prepared, not deployed.** Production still runs `9ab6b3d` from
`/opt/math-bot/.cache/aleph-v2-qualification/9ab6b3d…` (read-only check, 2026-11-18). "Confirmed"
means observed in code, tests, the production database (read-only) or a live API call.

## 1. Repository state

- Branch `rc/aleph-v2-audit` in worktree `.worktrees/mpotd-screening-authz`, based on
  `origin/feature/aleph-zero-v2` = `9ab6b3d` (the production SHA). It fast-forwards onto
  `feature/aleph-zero-v2`.
- The old worktree `.worktrees/luna-production-port` (stale `b64b84c`, ~74 uncommitted files from an
  earlier copy of work now on origin) and the other worktrees were not touched.
- Local test environment: the project `.venv` (sympy, Pillow) is linked into the worktree and
  excluded from git. With it on `PATH`, the baseline is **1085 pass, 0 fail**, which matches the historical
  release report. Without it, two environment tests fail (calculator, vision fixture).

## 2. Architecture assessment (what exists and works)

Confirmed in code and tests:
- Luna orchestrator with multi-round, parallel, order-preserving tool calls (`tool-pool.ts`): 32/64
  rounds, 4 tools per round, per-tool caps, durable claims for side-effecting tools, stall detection.
- Terra and Sol consultation: host-authorized, quota-gated and effort-clamped. User demands for
  models are refused. `FINAL:` conclusions must survive synthesis.
- Budgets: atomic worst-case reservations (request, UTC day, total), cache-write and reasoning
  accounting, and per-user quotas for Sol, Terra and seven-agent mode.
- Streaming of approved text only, in whole paragraphs. Durable job events. Delivery edits are
  version-guarded and honor `retry_after`, with the terminal edit taking priority.
- Discord context snapshots, a permission-checked `discord_search`, publication audience
  rechecks, and MPoTD screening separate from disclosure (`9ab6b3d`, preserved and untouched).
- Seven-agent mode: seven bounded, tool-free Luna calls, moderator-verified U+2063 or 1/10,000,
  quota-gated and screened.
- Verity: the four exact pairs are in the orchestrator prompt and were not modified.

## 3. Confirmed defects and fixes

| # | severity | defect (evidence) | fix |
|---|---|---|---|
| D1 | high (user-visible) | "tag{1}" and "boxed{n=6}" appeared in a production answer. In `discord-format.ts:22`, every math command missing from the symbol table lost only its backslash. | Rewrote the math converter (§6). |
| D2 | high (math quality) | The production proof job `1572288627591880878` had exactly **one** model call (luna, low, 1,001 reasoning tokens): no tool, consult or review. The answer was right but a bound was invalid. The host never required independent review of a proof. Not caused by the token cap (1,615 of 4,000), synthesis (no specialist) or an outage. | Host-triggered proof review (§5). |
| D3 | medium | The orchestrator prompt said "follow the host's Discord output policy", but the v2 path never sent that policy. | Concrete inline math-formatting rules in the prompt. |
| D4 | low | `docs/openai.md` said the Verity text was still awaited, although it is in the prompt. | Corrected. |
| D5 | low (new code) | A proof review in `prepare_final` would have hit the 35 s tool timeout. | Uses the model timeout. |

## 4. Model migration: gpt-6.1-sol → gpt-6.2-sol

Sources (read 2026-11-18): the model page, the GPT-6.2 guide, the reasoning guide and the changelog
on developers.openai.com.
- Responses and Chat Completions are supported, but tool calling needs Responses. Streaming,
  function calling, structured outputs and image input are supported. Context is 1.05M with 128K
  output. Pricing is $2 input, $0.10 cached and $10 output per 1M tokens, with cache writes at
  $2.50 (30 min) or $5 (12 h). Above 272K input tokens the rates are 2× input and 1.5× output.
- **Live check on the configured org:** the metadata call returned 200; efforts low, medium, high,
  xhigh and max were accepted; `none` returned HTTP 400 `unsupported_value`; the runtime request
  shape (store:false, encrypted reasoning, safety_identifier, prompt_cache_key) was accepted.
- GPT-6.2 drops replayed reasoning items on prefix_mismatch, end_user_mismatch or model_mismatch.
  The orchestrator only appends, specialists are single-shot and each job uses one
  `safety_identifier`, so no change was needed. The service now logs `openai_input_transformations`
  reasons if any appear.
- Changes: the default `OPENAI_SOL_MODEL` is `gpt-6.2-sol`; the pricing table, env examples, tests
  and docs are updated. `gpt-6.1-sol` stays priced only for an explicit
  `OPENAI_SOL_MODEL=gpt-6.1-sol` rollback. **Correction (deployment, 2026-11-18):** the earlier
  read-only check misread production's quoted env values as empty. Production in fact pinned
  `OPENAI_SOL_MODEL="gpt-6.1-sol"`, so the new default alone did not migrate it. The new release's
  own copy of `.env.ai.production` was changed to `"gpt-6.2-sol"` (see §14). The `9ab6b3d` copy keeps
  6.1 for rollback.

## 5. Mathematical reliability

- Independent check of the incident: (m−n)(m+n) = 2ⁿ ⇒ m−n = 2ᵃ, m+n = 2ᵇ, 1 ≤ a < b.
  With d = b−a this gives 2^(a−1)(2^d − 1) = 2a + d. Then a = 2, d = 2 ⇒ n = 6, and a = 1, 3, 4
  give nothing. For a ≥ 5, (2^d−1)(2^(a−1)) ≥ (2^d−1) + (2^(a−1)−1) ≥ d + 2^(a−1) − 1 > d + 2a.
  So n = 6 is the only solution. The production bound 2^(a−1) > 2a + d fails for large d.
- `proof-review.ts` and the orchestrator:
  - Trigger: a deterministic proof obligation.
  - Reviewer: gpt-6.2-sol (medium, ≤6,000 output tokens) when the Sol quota allows, otherwise luna
    at high effort. It sees only the task and the draft.
  - Verdict: a strict structured verdict with 12 issue categories; findings return to luna as
    untrusted feedback.
  - Bounds and fallbacks: at most 2 cycles, then an honest caveat; reviewer outages also produce a
    caveat. Drafts are screened under an embargo.
  - Deterministic focus hints include the incident shape (a bound conditioned on one variable while
    another is free).
- The prompt adds a proof-rigor checklist: finite checks never prove unrestricted claims, and
  "find all" answers need both directions.
- Eval: a new `proof-rubric` check scores final answer, complete argument, known-invalid steps and
  notation separately, on the Discord-formatted text. Problem `proof-n2-plus-2n-square` fails on
  n = 6 alone, on the invalid bound and on "tag{1}".
- **Live (bounded, $0.0125 total):** gpt-6.2-sol flagged the production flaw as
  `unsupported_inequality` with a counterexample (a = 5, d = 6). A repaired draft drew "gaps"
  asking for proof of its exponential-versus-linear tail bounds, which is a strict but legitimate
  standard for "prove completeness".
- **Not run:** a live end-to-end run of the full eval set (paid; run it with
  `bun run eval:math -- --live --max-usd <cap>`). No accuracy numbers are claimed.

## 6. Discord formatting

`latexToText` in `discord-format.ts` handles:
- `\boxed` → bold, `\tag` → (n);
- `\frac`, `\dfrac` and `\tfrac` with unambiguous grouping (`(a+b)/(2a)`), including nested fractions;
- `\sqrt[n]`, `\binom`, `\pmod`, `\mathbb`, accents, and Unicode super- and subscripts with fallbacks;
- aligned, cases and matrix environments; multi-line display math goes in a code block;
- known commands outside delimiters; unknown commands become `name(arg)`; Markdown-active
  characters in math are escaped.

Code spans and fences, dollar amounts and paths are untouched. An unterminated display block is
still converted. There are 37 table-driven tests plus split, fence and bold invariants.

## 7. Personality

Additions only. Every phrase pinned by the persona tests and the Verity block is unchanged. The
character layer now covers staying in voice during proofs, research, tools and second opinions
through word choice, without stock jokes or repeated escape lines. Catching a mistake can draw a
natural reaction; rigorous sections stay clean. Specialists keep their concise non-persona prompts.
No live conversational quality evaluation was run.

## 8. Orchestration, concurrency and cost findings

- Correct: Luna ownership, consult isolation (no tools, no persona, selected context), tool-call ID
  association in original order, isolated failures, cancellation through child signals, per-job
  caches and claims, and one active job per user per server with 3 concurrent jobs (the default
  under openai).
- Cost: routine requests make one Luna call. A proof request adds one or two reviews (live ≈ $0.005
  each at medium). Repair turns add Luna calls ($0.001–0.002). Reviews use the Sol request class
  ($0.10 ceiling) and the per-user Sol quota; without quota they fall back to Luna, so the class
  stays ordinary.

## 9. Security

- Unchanged and still tested: screening versus disclosure (`9ab6b3d`); host-only
  `discord_audience` and `competition_reference`; moderators get no disclosure privilege; the
  embargo applies to drafts sent to the reviewer.
- Logging carries only IDs and fixed codes. The regex tool is RE2-bounded. Python is sandboxed
  (production has `PYTHON_SANDBOX_ENABLED=true`).
- No new vulnerabilities were found in the spot-checked areas. This was not an exhaustive
  line-by-line security audit.

## 10. Files changed (`268c911`, `732d1cc`, final commit)

- `src/service/openai-config.ts`: Sol default and pricing, proof-review settings.
- `src/service/openai.ts`: `input_transformations` logging.
- `src/service/proof-review.ts` (new) and `src/service/orchestrator.ts`: proof review.
- `src/service/persona.ts`: math formatting rules, rigor checklist, character guidance.
- `src/discord-format.ts`: LaTeX conversion.
- `src/scripts/math-eval-grade.ts` and `evals/math/problems.json`: proof rubric and regression problem.
- `.env.ai.*.example`, `docs/openai.md`, `tsconfig.v2-tests.json`.
- Tests: `discord-math-format`, `proof-review` (new); `discord-delivery-v2`, `math-eval`,
  `openai-smoke` (expectations updated).

## 11. Tests (WSL, Bun 1.4.2, project .venv on PATH)

`bun run check` clean · `bun run check:v2-tests` clean · `bun test` **1131 pass, 0 fail** (baseline
1085/0; 46 new) · `.venv/bin/python -m unittest discover -s python` 4 OK · `bun run build` OK.

## 12. Release and rollback

Deploy only after authorization. Build the RC SHA in a fresh
`/opt/math-bot/.cache/aleph-v2-qualification/<sha>` exactly like `9ab6b3d`, with the same env
files and the shared `data`. Then run `BOT_ENV=production bun run openai:smoke -- --confirm --sol`
and point `aleph-zero-ai` and `aleph-zero-bot` at the new directory. Leave `aleph-zero-automation`
alone. Verify in `#ai-test`:
- a chess reply-chain conversation;
- the n² + 2ⁿ proof (review events appear and the answer has no TeX residue);
- an active-embargo refusal;
- `/ai usage` shows `gpt-6.2-sol`.

Rollback: point both processes back at the `9ab6b3d` directory, which is unchanged. The new
code adds no schema migration. For a model-only rollback, set `OPENAI_SOL_MODEL=gpt-6.1-sol`;
to disable reviews, set `OPENAI_PROOF_REVIEW=off`.

## 14. Deployment record (2026-11-18, authorized by the owner)

- Release directory: `/opt/math-bot/.cache/aleph-v2-qualification/a0b80549c608f1cbc2616077c839044b4869169c`.
  It is a clone of the `9ab6b3d` release, fetched from GitHub and checked out detached at `a0b8054`,
  with 0 dirty files.
- On the server: `bun install --frozen-lockfile`; both typechecks clean; `bun test` **1131 pass,
  0 fail**; Python 4 OK; build OK. Tests ran before the env files and the `data` link existed.
- Backup: `/opt/math-bot/backups/aleph-rc-a0b8054-20261118T045853Z/` holds an online SQLite backup
  of `data/production.sqlite` (integrity ok), the prior `dump.pm2` and `RELEASE.txt`.
- Configuration: env files copied from `9ab6b3d`, with `data -> /opt/math-bot/data`.
  `OPENAI_SOL_MODEL` was changed to `"gpt-6.2-sol"` in this release's `.env.ai.production` only; the
  previous copy is kept beside it as `.env.ai.production.pre-sol62`. `PYTHON_EXECUTABLE` still points
  at the `9ab6b3d` release's `.venv`, so **do not delete that directory** (it is also the rollback target).
- Smoke (`openai:smoke --confirm --terra --sol`, then `--sol` after the switch) passed: luna, terra,
  sol = `gpt-6.2-sol`, about $0.0002 in total.
- Cutover: `aleph-zero-ai`, then `aleph-zero-bot`, re-created under PM2 from the new directory with
  `BOT_ENV=production`, then `pm2 save`. `/health` reports ok, provider openai; the bot logged in to
  production; the AI startup log shows `sol: gpt-6.2-sol/medium..xhigh`. `aleph-zero-automation` was not
  touched. No jobs were queued or running at the switch.
- **Not verified live:** real Discord conversations (chess reply chain, the n² + 2ⁿ proof with review,
  an embargo refusal). These need a human message in `#ai-test`.

Rollback (as `mathbot`):
```sh
D=/opt/math-bot/.cache/aleph-v2-qualification/9ab6b3d73956d32531774b6651c444acf7afcce5
pm2 delete aleph-zero-ai aleph-zero-bot
cd $D && BOT_ENV=production pm2 start /usr/local/bin/bun --name aleph-zero-ai --cwd $D --interpreter none -- $D/dist/service/server.js
cd $D && BOT_ENV=production pm2 start $D/dist/index.js --name aleph-zero-bot --cwd $D --interpreter /usr/local/bin/bun
pm2 save
```

## 13. Remaining limitations

- The reviewer can be stricter or weaker than a human grader. Reviews cost latency (7–8 s each at
  medium in the live check), and unresolved proofs carry a caveat rather than being blocked.
- Proof-obligation and rubric patterns are heuristics; the rubric is a regression net, not a
  proof checker.
- Not done in this pass: live end-to-end evaluation, a live conversational personality check, a
  deep audit of image-input edge cases and announcement code (out of scope), and production
  deployment.
