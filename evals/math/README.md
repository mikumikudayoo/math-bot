# Math evaluation harness

A reproducible check of the OpenAI provider's routing and its raw mathematical accuracy. The harness is
separate from the bot: it never touches the bot's database, Discord, the job queue or production traffic,
and by default it makes **no network calls and spends nothing**.

Files:

| path | role |
| --- | --- |
| `evals/math/problems.json` | 39 problems across 8 categories (schema below) |
| `src/scripts/math-eval.ts` | CLI: dry run (default) and opt-in live run |
| `src/scripts/math-eval-grade.ts` | pure grader `grade(check, answer)` |
| `tests/math-eval.test.ts` | grader, schema, routing-agreement and CLI-safety tests |

## Dry run (default)

```sh
bun src/scripts/math-eval.ts
```

Prints `DRY RUN — no model calls made`, then, for each problem: expected tier, routed tier, model, reasoning
effort and the worst-case cost of one call (estimated input tokens from `estimateInputTokens` plus the tier's
`maxOutputTokens`, priced with `costMicros`). It ends with routing agreement per category, the mismatches with
the router's stated reason, the overall agreement percentage, and the worst-case cost of one full live pass.

Routing uses the production `chooseOpenAIRoute` with a config from `parseOpenAIConfig`. The API key is a
placeholder (`sk-dryrun…`). `OPENAI_*` tuning variables in the environment (`OPENAI_LIGHT_MODEL`,
`OPENAI_ADVANCED_EFFORT`, `OPENAI_ROUTING`, `OPENAI_FORCE_TIER`, `OPENAI_PRICING_JSON`, …) are honoured, so
you can preview a different configuration:

```sh
OPENAI_LIGHT_EFFORT=low bun src/scripts/math-eval.ts
```

## Live run (costs money)

```sh
OPENAI_API_KEY=sk-... bun src/scripts/math-eval.ts --live --max-usd 2 [--limit 5] [--ids a,b] [--tier light|advanced|auto]
```

The harness refuses to run live unless **all** of these hold:

- `--live` is given;
- `--max-usd <n>` is given explicitly, `0 < n <= 5`;
- `OPENAI_API_KEY` is set in the process environment. The key is passed only to the SDK client and is never printed or written to results.
  Bun auto-loads `.env` and `.env.<NODE_ENV>` files into `process.env`, so check what those files contain before a live run.

Options: `--limit k` runs the first k selected problems; `--ids a,b` selects by id (unknown ids are an
error); `--tier light|advanced` forces one tier for every problem, and `auto` (default) uses the production router.

### Cost cap behaviour

Calls go through the production `OpenAIRuntime` and `UsageLedger`, backed by a private
`new DatabaseSync(':memory:')`, with both `dailyBudgetUsd` and `totalBudgetUsd` set to `--max-usd`. Every
attempt (including retries) reserves its **worst-case** cost before it is sent. A call that could exceed the cap
is refused with a `BudgetError`: the run stops cleanly, the problems that already ran are reported and saved,
and the reason is printed as `stopped early: budget: ...`. Because reservations are worst-case, a run may stop
before the actual spend reaches the cap. The dry run prints the worst-case total for a full pass. With default
settings that is about $1.71: advanced calls dominate at ~$0.16 each (16k output tokens × $10/M).

Calls run one at a time (`concurrency: 1`). Retries, timeouts and reasoning effort come from the usual
`OPENAI_*` variables (defaults: 2 retries, 180 s timeout). Auth, permission, missing-model, quota and
unsupported-parameter errors stop the run, because every later call would fail the same way. Transient errors
are recorded and the run moves on. Ctrl-C aborts the call in flight and still writes results.

All costs are **local estimates** (token usage × configured prices), not the account balance.

## Output format

A live run writes `evals/math/results/<ISO timestamp with : and . replaced by ->.json` (for example
`2026-11-16T12-30-00-000Z.json`). The first live run creates the directory and a `.gitignore` containing `*`,
so **no results are ever checked in**. The file contains:

- `meta`: start/finish time, `--max-usd`, tier mode, filters, safe config summary (models, efforts, budgets;
  no key), pricing source, SHA-256 of `problems.json`, number of problems selected and completed, `stoppedReason`.
- `summary`: overall accuracy, estimated spend, and per-category and per-routed-tier `{n, passed, accuracy, errors, meanLatencyMs, costUsd}`.
  With `--tier auto` it also includes routing agreement.
- `results[]`, one object per problem that ran: `pass`, `gradeDetail` (what the grader extracted and why),
  the full `answer` text, `finishReason`, `latencyMs`, `attempts`, routed `tier/model/effort` and router reason,
  token usage (`inputTokens`, `cachedTokens`, `outputTokens`, `reasoningTokens`) from the ledger's
  `openai_usage` rows, `costUsd`, `costIncludesWorstCase` (true when usage was unknown, for example after a
  timeout, so the worst-case reservation was kept), and `error: {kind, status?, code?}`. The error kinds are those
  of `ProviderError`, plus `empty`, `budget` and `rejected_locally`.

The console shows a line per problem, then accuracy tables by category and by routed tier.

## What it measures and what it doesn't

Measured:

- the production router's tier choice on bare prompts, compared with a hand-assigned `expectedTier`;
- the **raw model answer** to one turn: `[system persona + MATH_RELIABILITY, user prompt]`, sent through the
  same Responses API adapter, budget ledger and retry logic as production;
- correctness under a deterministic grader, latency, token usage and estimated cost.

Not measured:

- **No tools.** The calculator, Python sandbox and web search are not offered, so this is not the full tool
  loop the bot runs. Accuracy here is a lower bound on tool-assisted accuracy for arithmetic-heavy problems.
- No Discord context, reply chains or images. Routing does not get the local router's `routeReasoning` hint or
  a parent tier, and it routes as a fresh question from a non-coach.
- No `!quick`/`!deep`/`!max` directives, per-user quotas or the legacy/external provider fallback.
- Answer formatting for Discord (`formatForDiscord`) and the bot's final-answer extraction are not applied. The raw text is graded.
- Proof quality is checked only for **key-step keywords** (`contains-all`), which is a smoke test, not
  verification. Read the saved answers for proof problems.
- A single run is one sample. Model output is non-deterministic, so compare runs, not single verdicts.

## Problem schema

```json
{"id": "kebab-case", "category": "arithmetic-algebra|precalculus|geometry|combinatorics|number-theory|olympiad|proof|ambiguous-unsolvable",
 "difficulty": "routine|advanced|olympiad", "prompt": "...", "expectedTier": "light|advanced", "check": {...}}
```

`expectedTier` reflects the genuine difficulty, not what the router currently does. It is `advanced` for
proofs, olympiad problems and competition problems whose solution depends on a non-standard idea, and `light`
for anything a strong student solves with a standard method, however heavy the notation. Do not edit it to make
routing agreement look better. Mismatches are findings.

Checks:

- `{"type":"numeric","answer":n,"tolerance"?:t}`: picks the last `\boxed{}`, else the last line mentioning
  "answer", else the last line with a number. It ignores space-preceded parenthetical asides, takes the text after
  the last `=`/`≈`/`≡`, then the last number there. It handles `1,000`, `3/4`, `\frac{3}{4}`/`\dfrac`, negatives
  (including U+2212), decimals and `x = 5`, and skips exponents. A value passes if
  `|x − answer| ≤ t·max(1, |answer|)` (default `t = 1e-9`).
- `{"type":"exact","answers":[...]}`: compares the final-answer line, after normalizing case, whitespace, unicode
  minus and trailing punctuation, and also the parts after `:`, `=`, `∈` or "answer".
- `{"type":"contains-all","terms":[...]}`: every term must appear (case-insensitive, spacing around operators
  ignored, superscripts read as `^n`). `a|b` inside a term means either is accepted.
- `{"type":"flags-ambiguity","terms":[...]}`: at least one term must appear. The answer has to say the problem is
  ambiguous, underspecified or impossible.

Every answer in `problems.json` is a classic result, checked by hand. When you add a problem, verify its answer
independently and run `bun test tests/math-eval.test.ts`.
