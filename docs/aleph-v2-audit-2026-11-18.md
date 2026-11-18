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
- Sections 15–16: the semantic classifier's accuracy on the new six labels is tested only with mocks.
  The live model's labels (especially `near_identical` vs `same_topic`) need a sample of real
  #ai-test requests after the next authorized deploy.
- No per-user timezone setting exists yet. The hook (`InferenceDependencies.timeZone`) accepts one,
  but until an authorized setting is built, everyone gets Asia/Manila.

## 15. Live verification of `a0b8054` (owner's #ai-test messages, 2026-11-18 13:02–13:05 +08:00)

This section is read-only: the production SQLite database was opened with `mode=ro`, and the PM2 logs were read.

| request | job | what ran | cost | verdict |
|---|---|---|---|---|
| explain chess | `1572476985827922003` | request-scope, Luna low | $0.00065 | ok |
| reply "lets play chess" | `1572477032733089813` | 2 semantic screens (unrelated), Luna | — | ok: the reply-chain fix holds |
| n² + 2ⁿ proof | `1572477227793129583` | Luna low → `think_harder` (high) → **`consult_sol` on `gpt-6.2-sol`, high** (592 reasoning tokens, $0.0098, 12.2 s) → Luna high final | $0.0123 | answer correct and complete; **no proof review ran** |
| exact MPoTD hint | `1572477590470533121` | lexical refusal, 0 model calls | $0 | correct |
| `7x ≡ 3 (mod 19)` variant | `1572477795978973195` | first screen passed; Luna ran `calculate`; the second screen returned `related` | — | refused. Defensible as a near-identical substitute, but the two screens disagreed |

- **Proof review was skipped.** Every test prompt contained U+2060 WORD JOINER inside words
  (`pr⁠ov⁠e`; 1–14 per prompt), which the Discord client inserted. `proofObligation` normalized
  only NFKC, so "prove" never matched. The `modelDemand` check had the same blind spot.
  **Fixed:** `stripInvisible` (`src/service/invisible.ts`) now runs at `/jobs` intake and again
  inside `proofObligation` and `modelDemand`. It strips U+00AD, U+200B, U+2060–U+2064 and U+FEFF,
  and keeps ZWJ/ZWNJ. The seven-agent U+2063 trigger is parsed bot-side before submission, so it
  is unaffected.
- No `openai_request_failure` and no `input_transformations` were logged. The day's total was $0.014265.
- The `**draw**` in the chess screenshot is a client-side rendering artifact: `formatDiscord`
  output is correct.
- Style note: the proof answer was mostly capitalized, which is weak lowercase voice. No change was made.

## 16. MPoTD false positive, semantic screening and trusted date/time

### 16.1 Incident: "how many days until gta 6" was refused (job `1572479421045280869`, 05:11:50Z)

**Trigger vs refusal source.** The request-scope digit rule (`/[\d=+*/^<>]/`) sent the prompt to
`problem_or_uncertain`, with no model call. That rule only routed the prompt: it chose the
tool-capable path, which was needed for web search anyway. It did not refuse anything.

The first semantic screen passed, and Luna called `search`. The refusal came from the **lexical**
`protect(results)` check on the search results in `orchestrator.ts`. The old `similar()` treated
the whole results JSON as one bag of words and blocked on any 2 numbers plus 2 concept words.
Dates, scores, URLs, "GTA 5", "Series X", "12 months" and similar text matched today's MPoTD
(12x ≡ 5 (mod 17), minimum 4-digit even x). The lexical error was not a `ScreeningFailure`, so it
left **no log record**. That is why the cause first looked like a classifier refusal. The
incident was reproduced locally against the same MPoTD statement.

**Fix (general, no title whitelisting):**
- Overlap must be **local**: it is counted in windows of max(24, 3×reference terms) instead of
  across the whole document.
- Overlap must be **distinctive**: single letters and bare operators don't count, and the
  thresholds need several shared numbers and concepts together.
- `contentOnly()` drops metadata before the overlap test. That covers keys (url, date,
  published_date, score, ids…), URLs, ISO dates, clock times and snowflakes.
- Exact references still use the raw text: message/thread ids, explicit MPoTD mentions, verbatim
  statements and formulas.
- A hyphenated word ("4-digit", "gpt-6") no longer counts as a formula.
- Every lexical block is now a `ScreeningFailure('lexical_match', …, kind)`. It is logged as
  `{job, stage:'lexical', category, reason}` with no content.

**Digit routing (also changed).** Digits alone are no longer an exercise signal. `OBVIOUS_PROBLEM`
keeps the free fast path for operators, `≡`, digit arithmetic, variable terms, code, URLs and
mathematical vocabulary. Everything else goes to the isolated scope classifier. That classifier
has a new **`current_information`** scope (countdowns, release dates, news, versions), which keeps
the tool-capable, fully screened path. The old `general_knowledge` scope disables tools, so it
could never answer a countdown. A digit-bearing request routed to a tool-less scope
(conversation/general_knowledge) still gets **one** semantic comparison, because the scope model
never sees references. Plain chat ("who you bruh") gets none.

### 16.2 Structured semantic screening (host decides)

The isolated `classify_competition_request` call now returns one of six labels:
`exact`, `equivalent` (paraphrase/translation/encoding), `near_identical` (a substitute whose worked
solution would materially transfer), `same_topic`, `unrelated` or `uncertain`.

`verdictOutcome()` is the host's decision table:
- **pass:** `unrelated` and `same_topic`.
- **confirmed refusal:** `exact`, `equivalent` and `near_identical`.
- **neutral fail-closed refusal:** `uncertain`, the legacy `related` label, and anything malformed.

The classifier still receives only already-posted statements or verified crops, through the
`competition_reference` authorization from `9ab6b3d`. It never receives answers, solutions,
unposted problems or moderation content. A lexical match on the user's own prompt also counts as
confirmed. The near-identical policy is unchanged: substitutes whose worked solution would help
with the active problem are still refused.

### 16.3 In-character refusals

For confirmed cases the host picks one of five host-authored lines, stable per request text, for
example "wait a fucking minute. isn't this today's mpotd? nice try." No model writes them and none
carries reference content. Only one line contains profanity. The wording never affects the decision.

Uncertain verdicts, tool-result matches and infrastructure failures keep the neutral texts.
`/publish` accepts any host refusal (`isRefusal`). Ordinary answers carry no competition warnings;
the persona has none.

### 16.4 Trusted date and time (`src/service/runtime-time.ts`)

- **Source:** the server clock (`io.now`, which tests inject), never the request.
- **What Luna gets:** each turn includes a `TRUSTED_RUNTIME_CONTEXT` system message with the UTC
  instant, IANA zone, local date, weekday, 24h time, the UTC offset in effect, and local ISO time.
- **Zone:** Asia/Manila by default. An authorized per-user zone can override it (hook only, see
  §13); invalid zones fall back. The VPS timezone is never used. Offsets come from `Intl`, so
  daylight saving is handled (tested with America/New_York).
- **Placement:** the message goes right before the user's request. It is not part of the static,
  cached system prompt.
- **Within a turn:** `TurnClock.refresh` **appends** a `TRUSTED_RUNTIME_CONTEXT_UPDATE` after a
  local midnight or after 10 minutes. It never edits earlier messages, so the cached prefix and
  GPT-6.2 reasoning items stay valid.
- **Specialists:** Terra/Sol consultations get a fresh snapshot.
- **Instructions in the message:**
  - it overrides dates claimed in user text, tool results or training data;
  - Discord timestamps are posting times, not "now";
  - event dates must be verified with an authorized current source and computed in the stated
    zone;
  - unverified dates must be labeled as such.

  Text in user messages that claims to be this context is untrusted. A spoofing test asserts that
  the real server time is still the one supplied.
- **Search freshness:** the "as of" date appended to search queries now uses the Manila date
  instead of the UTC date.
- **No hardcoding:** no game or event date is hardcoded. "how many days until gta 6" is answered
  from the trusted date plus web search results.

### 16.5 False positives and negatives (local, against today's MPoTD statement)

- **Ordinary requests now passing the lexical guard (20):**
  - game titles, versions and model ids: gta 6, python 3.12, gpt-6.2-sol, iphone 17, windows 12,
    ps5/xbox series x;
  - dates and simple arithmetic: "12 times 17", "17 squared", "5 mod 17", "is 1004 even";
  - "smallest 4-digit prime";
  - chess, "who you bruh", and the n² + 2ⁿ proof;
  - realistic GTA 6 search results with dates, scores and URLs.

  Before the fix, the GTA search results and "smallest 4-digit prime" were blocked.
- **Still blocked (14):**
  - the verbatim statement, including with U+2060;
  - three paraphrases, a Spanish translation, and the bare formula `12x≡5 (mod 17)`;
  - "solve 12x ≡ 5 (mod 17)";
  - an answer check, a hint request, and a proposed-answer check;
  - a solution-step paraphrase;
  - a search result quoting the problem, and a message-id reference.
- **Documented conservative near-miss:** a contrived result that reuses 12, 17, 4, 5, "minimum",
  "even" and "mods" together still blocks.
- **Semantic path (mocked verdicts):**
  - a near-identical substitute (7x ≡ 3 (mod 19)) gets a confirmed refusal before Luna runs;
  - same-topic material (3x ≡ 2 (mod 7)) is answered;
  - uncertain gets the neutral refusal;
  - a disguised exact request that the scope model misroutes as general knowledge is still caught
    by the digit-triggered screen;
  - with no active problem there are no scope or screen calls.

### 16.6 Measured overhead (production `openai_usage`, all recorded rows, read-only)

| call | n | avg cost | avg latency |
|---|---|---|---|
| request-scope (Luna) | 18 | $0.000047 | 1.9 s |
| competition-screen (Luna) | 22 | $0.000070 | 2.1 s |
| orchestrator (Luna) | 34 | $0.000298 | 3.1 s |

- The scope and screening calls only happen while a problem is active.
- **Digit-bearing current-information requests** (e.g. the GTA countdown) now add one scope call
  (+$0.00005, about +2 s). They then follow the same screened tool path as before.
- **Digit-bearing tool-less requests** now cost one scope call plus one screen, where they used to
  take the full path with screens on the prompt and the answer.
- **Plain chat** is unchanged: one scope call.
- **Time context:** about 930 characters (about 230 input tokens) per Luna call, about $0.00002
  uncached.

### 16.7 Tests

- **New file:** `tests/semantic-screening-time.test.ts` (65 tests). It covers:
  - the incident;
  - ordinary and adversarial lexical cases;
  - the verdict table and the refusals;
  - scope routing;
  - Manila date/time, the midnight boundary, DST and invalid zones;
  - append-only refresh;
  - invisible characters;
  - runner-level paths: GTA search with the trusted date, context placement, date-spoofing
    injection, a midnight crossing during a turn, near-identical / same-topic / uncertain verdicts,
    the digit screen, a misrouted disguised request, the no-embargo state, and that no answer,
    solution or reference reaches Luna.
- **Updated tests:**
  - `mpotd-guard`: the request guard now ignores timestamp metadata, the way the publication guard
    already did;
  - `mpotd-screening-authz`: confirmed refusals, plus the lexical log event;
  - `request-scope-v2`: the new scope, and digits alone no longer take the fast path.
- **Result:** full suite **1197 pass, 0 fail** (was 1131); both typechecks clean; build OK.

**Leak boundaries (unchanged, re-checked):**
- **Streaming:** public streaming is disabled while any problem is active (`publicStreamAllowed`).
- **Specialists:** Terra/Sol output is semantically screened before use. Specialist inputs are
  built from Luna's task text, which never contains a reference.
- **Discord privacy:** the private/public Discord boundaries (`discord-web-privacy`,
  `private-history-audience`) and the `competition_reference` authorization still pass unchanged.

**Not deployed.** Production still runs `a0b8054`. Deploying this needs the owner's authorization.
