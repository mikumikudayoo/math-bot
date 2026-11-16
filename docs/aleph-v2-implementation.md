# aleph-zero v2 recovery checkpoint

november 16, 2026 (manila). the tested implementation is `cf01f4a4f3ebaa9ad0cc9fcd8b2eb76ff179464f`, tree `715961e353d76301b268b4b7520ff61e790cba7e`. the checkpoint commit adds this report. production rollout is pending.

## recovered state

| location on the development computer | verified state before integration |
| --- | --- |
| main checkout, `D:\devstuff\math-bot` | branch `codex/moderation-security-phase1` at `56aed6b`; pre-existing untracked worktrees and cancellation documents |
| original feature worktree, `.worktrees/luna-production-port` | branch `feature/aleph-zero-v2` at `b64b84c`; the interrupted session had saved source and tests as working files |
| `%TEMP%/aleph-v2-release-e88b27b667` | clean separate clone at `fb4390b`; ten post-handoff milestone commits; its origin is a local seed bundle |
| `%TEMP%/aleph-v2-release-e88b27b667.bundle` | full seed history ending at `b64b84c` |
| original feature worktree `.cache/aleph-zero-v2.bundle` | incremental bundle ending at `644d325`, prerequisite `ce2e61e`; misses evaluation, orchestration and later fixes |
| `%TEMP%/aleph-v2-import-9e583da957` | initialized repository with no refs; no completed import |
| github | `feature/announcement-automation` resolved to `ce2e61e330762797fbe02df3924476ebc736bb00`; the exact v2 feature name had no search result. the live vps revision was not queried in this session |

the production lineage is `ce2e61e` → `1176a25` (provider foundation) → `35caede` (tool pool, regex, identity drafts) → `325062e` (handoff) → `b64b84c` (upstream clarification). the original draft is still available in `docs/aleph-v2-handoff.md`.

comparing both sets of files exposed seven differing tracked files and two missing from the clone. recovery commit `1b8242c` preserves all nine:

- `src/service/openai-budget.ts`, `src/service/openai-config.ts`, `src/service/openai.ts`, `tests/openai-ledger-v2.test.ts`
- `src/commands/study.ts`, `tests/ai-usage-command.test.ts`
- `docs/openai.md`, `docs/operations.md`, `docs/aleph-v2-implementation.md`

a temporary index built from the original working files plus all its nonignored additions produced tree `94406e8f1460445fb0e79478818ca1b512dec6ed`. all **307 entries** matched recovery commit `1b8242c`. the recovered source still contained a missing `estimateInputTokens` export. the earlier mock-only loader supplied that export at runtime. the regression runs used the plain transpilation loader, with no source or estimator substitutions.

## preserved implementation and repairs

| area | preserved commits and implementation | repair or verification after recovery |
| --- | --- | --- |
| orchestrator | `1ae23d4`, `1b8242c`. `inference.ts` dispatches openai ask jobs to `orchestrator.ts`. luna-low, 32/64 soft/hard rounds, bounded ordered tool concurrency, durable attempts and deduplication, cancellation, regex, terra/sol consultations, effort authorization, seven-agent selection, and vetted progress all run through the provider chokepoint. | `5bbbd22` restores the estimator and preserves multiple distinct conclusions from the same specialist. numeric reconciliation distinguishes signed and whole values, including 12, −12 and 112. mocked integration covers retry authorization, isolated job context and restart without a second paid search. |
| announcements | `a9e8da6`, `fb4390b`. the worker selects its provider, shares the study service's sqlite ledger, scrubs mail locally, validates strict extraction and locked drafting schemas, records provider-specific incidents, and retains both staff approval steps. | `47fc701` restores the legacy extractor's held proposal for an otherwise public, supported erratum with an unreadable replacement. mixed/private inputs and the openai worker's local holds stay covered. synthetic mail made it to pending editorial approval. |
| evaluation and moderator usage | `604dd33`, `1b8242c`. four profiles, 39 problems in eight categories, bounded opt-in spend, real runner and isolated evaluation ledger, correctness/latency/token/cost fields, moderator-only usage view and attachment for long reports. | `55a1c02` counts usable specialist results independently of whether the provider response had metering. four-profile positive fixture and full-corpus negative control passed. results are grader and routing checks. |
| discord context | `c844ca5`, `fffaf8c`. anchored reply/chain/recent snapshots, host identity and roles, authorized attachments, bounded filtered search and pagination, permission witnesses for whole audiences and private threads, persisted source digests, and fresh evidence checks for delivery and recovery. | `ea4a078` applies the same time boundary to search results, direct ids, cursor refetches and slash interaction ids. later edits and the bot's earlier derived answers are excluded from search. |
| competition and image guards | `e82164d`, `5cd85c1`. read-only competition state, release version checks, local checks and bounded text/image comparison, checked tool and specialist boundaries, guarded stream/publication, decoded png checks, deterministic plot receipt, visual review and bounded corrections. | validated plot pixels pass the competition guard before visual review; mocked refusals and publication-time changes are covered. real classifier quality and the unix python renderer remain staging checks. |
| delivery | `644d325`, `fffaf8c`. sqlite events and pending progress, placeholder/continuation recovery, ordered edits, rate-limit handling, output splitting and formatting, terminal priority, per-part source reauthorization and last-page artifacts. | `5b03ba1` makes progress follow the current phase after a previously streamed draft. the new test uses persisted events, the actual delivery manager and mocked discord edits. |
| shared budgets and staging | `bf2160a`, `fb4390b`, `1b8242c`. shared reservations, separate spending classes and search credits, staging smoke commands and operator docs. | `cf01f4a` settles sdk cache-write receipts by retention, holds ambiguous charges, and includes schemas and ordinary text that resembles inline image data in input limits. only real image parts get the separate image allowance. reservations use estimated input tokens; the ledger cannot certify the provider's final invoice. |

`git log --reverse --oneline b64b84c..HEAD` gives all ten recovered milestones, the nine-file recovery commit, six integration repair commits and this report. the evidence archive contains the complete changed-path list from the handoff.

## regression results

all comparable node runs used windows node **24.18.1**, the same feature-worktree dependency directory, the original typescript transpilation loader and node's test runner with concurrency four. they selected `tests/*.test.ts` files importing `node:test`. the native bun-only files were exercised separately with windows bun **1.3.14**. the archived handoff source matched all 280 files in the baseline git tree. the accepted checkout was cloned from the bundle before testing.

| stage | node tests | pass | fail | interpretation |
| --- | ---: | ---: | ---: | --- |
| handoff `b64b84c`, historical and independently repeated | 749 | 726 | 23 | both runs have the same failing identities |
| recovered `1b8242c`, before repairs | 308 | 256 | 52 | load failures prevented entire suites from registering; the lower total cannot establish improvements |
| clean candidate `cf01f4a` | 851 | 828 | 23 | 102 added and passing, zero removed, zero new failures, zero skips or cancellations |
| native bun-only subset | 87 | 87 | 0 | same result at the baseline and tested tip |

the final 23 match the baseline by test identity and observed error category. fourteen require the bun global; three are sql worker result assertions; three are windows temporary-directory cleanup errors; one spawned node process fails to resolve a typescript module's `.js` import; one legacy calculator assertion receives no worker result; one vision suite fails to bootstrap. the three sql assertions and calculator result are recorded as observed, with no claim that they pass in production. exact names, additions and removals are in `final-cf01f4a-comparison.json`.

additional checks from the imported source:

- 108/108 in the 14-file v2-focused suite. both application and v2 test typescript checks passed. windows bun's package-script wrapper could not locate `tsc` in the linux-style dependency shims. invoking the same installed compiler directly under bun emitted 143 javascript files; the built math evaluation cli ran successfully.
- six concurrent node processes contested one sqlite budget. one reservation of 1,001 microdollars succeeded, five received the total-budget refusal. mocked provider smokes checked all three model routes and the shared ceiling. synthetic announcement extraction and drafting used one combined cap.
- the offline evaluation submitted the same wrong answer to all 39 × 4 combinations. all 156 were rejected, with zero evaluation errors, 158 mock calls, zero network requests and no provider charges. the positive fixture exercised all four profiles. live model accuracy, latency and cost still need measurement.
- the machine has no registered wsl distribution. windows bun 1.3.14 lacks `node:sqlite`. windows python failed before running the math worker tests at `import resource`. its default installation also lacks sympy, pillow, matplotlib and numpy. the handoff's pinned linux result (831 pass, 2 fail, 1 aggregate error) was not independently rerun here.
- no paid smoke, real discord send, production server access, process restart or deployment occurred. live announcement schema acceptance and real thread/audience, rate-limit and recovery behavior remain unverified. the four exact verity question/answer pairs are missing from both supplied texts; implementation and tests await the director's wording.

## resume from the verified bundle

the durable handoff on the original feature worktree is under `.cache/aleph-v2-recovery/`. it contains a complete-history bundle, its sha-256 sidecar, verification evidence and the test harness. the legacy bundles listed above are historical. the release clone in the temp directory is optional for recovery.

```powershell
$feature = 'D:\devstuff\math-bot\.worktrees\luna-production-port'
$bundle = Join-Path $feature '.cache/aleph-v2-recovery/aleph-zero-v2-tested.bundle'
git -C $feature bundle verify $bundle
git bundle list-heads $bundle
Get-FileHash -Algorithm SHA256 $bundle
# choose a new, empty destination for the independent working clone
git clone --branch feature/aleph-zero-v2 $bundle D:\devstuff\math-bot-v2-resumed
git -C D:\devstuff\math-bot-v2-resumed fsck --full
git -C D:\devstuff\math-bot-v2-resumed diff --name-only cf01f4a HEAD
```

the last command should list only `docs/aleph-v2-implementation.md`. the separate clone's `origin` points to the bundle. the original shared git index and refs are read-only in this session. the feature working files were the transfer target; the separate clone and bundle carry the commit history. the original feature branch pointer is still `b64b84c`. starting in a new clone avoids disturbing that original worktree or its index.

on a linux staging checkout, install the frozen bun dependencies and the project's unix python worker requirements in its virtual environment. run `bun run check`, `bun run check:v2-tests`, `bun test`, `python3 -m unittest discover -s python`, and `bun run build` with bun 1.4.2. run the strictly capped provider and announcement compatibility smokes with staging credentials and the correct shared ledger. exercise an actual controlled discord server including private history changes, simultaneous requests, a rate-limited edit, and a split answer. deployment and rollback steps, including database backups, separate provider switches and pm2 ownership, are in `docs/openai.md`. production currently requires no rollback from this work.
