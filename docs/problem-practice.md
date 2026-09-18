# MPoTD and private problem practice

This upgrade changes the existing mathematical QOTD to **Math Problem of the Day (MPoTD)**. A future casual QOTD is not implemented. Nothing in this change deploys the bot, registers commands, starts services, changes production environment files, or opens a production database during development.

## Modes

| Mode | Access | Answer handling | Effect |
|---|---|---|---|
| Daily MPoTD | Public question and discussion, private modal | Replace until 21:59:59 Manila; reveal at 22:00 | Correct +10, incorrect 0; no speed bonus or rating |
| `/problem practice` | Ephemeral | Untimed, unlimited tries; solution button | No daily points or rating |
| `/problem rated` | Ephemeral, disabled by default | One final answer, ten minutes after confirmed delivery | Experimental Elo-style player update |

Daily posting remains 08:00 Manila using the existing configured schedule. New finalizations use flat ten even if an older open session has a legacy scoring override. Already finalized scores, standings, placements, used-question history and frozen deliveries are preserved. Timestamps still determine daily placement but do not award extra points. Existing moderator score corrections remain available.

`/mpotd leaderboard` and `/mpotd stats` continue to display daily points only. `/problem profile` and `/problem history` are private and display rated performance only. There is **no public rated leaderboard**. A rating describes performance in this bank and timed format, not intelligence.

## Bank separation and review

The existing PDF importer, content-derived identity, original filename retention, exact official answers, source assets and review UI are reused. No copyrighted PDFs are added to the repository. In WSL, `D:\devstuff\math-bot\solmans` is `/mnt/d/devstuff/math-bot/solmans`; the existing command remains:

```sh
cd /mnt/d/devstuff/math-bot
bun run import:solmans ./solmans
```

Imports remain pending; nothing is automatically promoted into either practice bank. Source and crop approval plus an explicit validated deterministic grading rule are required. Configure grading with the existing `bun run qotd:configure` tool and review the accepted answers against the official key. Promotion is a moderator attestation, not automated proof that a key is reliable. No choices, missing answers, difficulty estimates or source fields are invented.

Unlisted approved questions remain in the daily bank. A `problem_catalog` entry reserves a question outside daily selection **globally**, even when disabled. Practice/rated bank transfers are intentionally unavailable: a practice-exposed problem cannot quietly become a private rated problem. Rated promotion rejects every question with any daily reservation/history, including uncertain sends. Rated selection additionally rejects daily-history problems, practice exposure, invalid/disabled content and revoked approval.

Unrated selection uses explicitly approved practice problems and already revealed daily problems. A daily problem with any unrevealed reservation is excluded. Revealed archive problems also need an explicit grading rule for repeated answer checking. The original import IDs are used internally; rated prompts do not advertise them. Source citations appear with the official solution. Crops can naturally contain source numbering.

Shared use across different members is intentional. Private delivery does not prevent screenshots, answer sharing, external source lookup, or remembering an earlier problem. Run this experimental bank in its intended single server: player ratings, history and cooldown sequences are guild-scoped; the one-active-rated-attempt restriction is per Discord user across servers.

## Rating and repeat model

For player rating `R`, assigned problem difficulty `D`, and outcome `S` (correct=1, incorrect=0):

```text
P = 1 / (1 + 10^((D-R)/400))
change = K × encounterWeight × (S-P)
newRating = R + change
```

Defaults are version `experimental-1`, starting rating 1200, K=32, provisional until 20 scored attempts, encounter weights `[1, 0.5, 0.25]` (the last weight continues), and a 30-other-assignment cooldown. Speed has no role. No rounding enters the calculation; displays use two decimals.

The sequence advances on confirmed delivery, and conservatively when an interrupted delivery might already have exposed a question. Failed confirmed sends retain the **same** pending question and do not advance it. Timeouts consume the assignment but are abandoned, with no scored result, rating change or calibration evidence. Repeat encounter counts include abandoned/exposed attempts, so a later memorized answer is never treated as fresh calibration evidence.

If a problem was sequence 10, it becomes eligible when the user's latest sequence is 40 (thirty others have intervened), for assignment 41. Days passing do not shorten this. Fewer than 31 eligible problems cannot sustain indefinite rotation; exhaustion returns an explanation instead of relaxing the rule or fabricating problems. The selector favors difficulties near the current player rating with an exponential weight plus a small exploration floor. Members cannot pick a rated problem or difficulty.

Defaults permit at most 20 reservations and three abandoned/cancelled attempts per rolling 24 hours. These limit reroll abuse without taking rating away for a lost connection. They do not eliminate selective-answer inflation. Settings can be changed through the authenticated moderator configuration command; use a new configuration version for a model change. Existing attempts snapshot their settings. The initial player baseline is locked once a guild has players so corrections remain reproducible.

## Persisted lifecycle and recovery

1. Reserve one approved question transactionally. A unique partial index permits only one pending/delivering/active rated attempt per member.
2. Acquire a delivery lease and send the reviewed question crop privately. No deadline exists before successful delivery acknowledgement.
3. Commit the acknowledgement time, absolute ten-minute deadline, question encounter and assignment sequence together. Transient acknowledgement-write errors retry the same timestamp, not a fresh timer.
4. Accept one final answer in an immediate SQLite transaction. Check the deadline after obtaining the write lock. Insert one immutable event (unique attempt ID), update the player and complete the attempt atomically. Retries return the saved outcome.
5. Render the private result only after scoring has committed. Crop/render/Discord response failures cannot roll it back.

`/problem resume` uses persisted state, not a previous interaction token. It re-sends an active question without changing its deadline. `/problem result [attempt]` retrieves only the authenticated member's attempt. Closing Discord and restarting the bot do not pause an acknowledged attempt. Expiration is evaluated from the absolute deadline when commands/submissions touch the state; it requires no new scheduler or ten-minute background timer.

Discord and SQLite do not share a transaction. If a process dies after a possible send but before acknowledgement is saved, the delivery remains uncertain. For sixty seconds, duplicate delivery is blocked. On resume/start after that lease, recovery **explicitly cancels** it without rating or calibration, consumes it conservatively for cooldown, audits recovery, and tells the member to start another attempt. This avoids an unusable permanent reservation or resetting a possibly exposed timed challenge. A definite Discord 4xx rejection simply leaves the same pending assignment for retry. The owner/moderator can also reconcile an unconfirmed delivery explicitly. Network failures and 5xx responses retain the uncertain lease because delivery may have occurred. Unknown network outcomes are a limitation of Discord delivery, not proof the member saw the question.

An invalidated problem cancels active attempts without scoring; historical scored attempts require explicit correction. A disabled problem is excluded from new selection, while already delivered valid attempts retain their deadline. No workflow reopens final daily submissions or changes MPoTD scheduling.

## Source solution images

Both modes use the existing `QuestionRenderer`/PDF.js infrastructure. `renderSolutionSnapshot` is extracted from the completed daily reveal path; it verifies the retained PDF hash, matching original question fingerprint, official answer/solution and solution-page metadata. Solution-specific anchors and multi-page crops are preserved; question dimensions are not copied. Moderator solution overrides still take precedence. Daily snapshots still cache source crops before their delivery plan freezes.

Private results attach the official solution image and retain `Answer: ...`, source citation and question/solution page numbers as ordinary text. No OCR, AI correction or mathematical text reconstruction is introduced. If the retained crop/PDF cannot be used, the preserved official worked text is attached intact and the failure is logged without source text or private paths. The score remains committed. Very large answer/source summaries can use a text attachment to respect Discord's message limit.

## Difficulty evidence and corrections

Each rated problem has an explicit moderator/source-estimated initial difficulty and current difficulty on the same scale. Current difficulty stays at that estimate in this release. Valid first-encounter events are counted; repeated, abandoned and corrected events are conservatively excluded from calibration evidence. Problems remain provisional with conservative uncertainty 400. The separate simulation-only calibration candidate uses small opponent-adjusted updates bounded within ±100 of the initial estimate. **Automatic calibration is disabled**, and its uncertainty formula is a heuristic, not a confidence interval. Approximately 97 members may leave evidence sparse for a long time.

Rating events retain attempt, user, question, before/after, assigned difficulty, expected probability, outcome, encounter, weight, delta, timestamp and complete versioned configuration. SQLite triggers reject event and correction updates/deletes. Corrections append a reason, authenticated actor and operation ID. The player's history is replayed in order from its original baseline with each event's original difficulty/settings and latest effective outcome. A void contributes no score. Original events remain intact; a new revision records the replay and effective current/peak rating. A retried correction operation is idempotent. Ordinary difficulty changes never retroactively edit events.

`/problem history` labels immutable originals and lists replay revisions; `/problem result` shows the effective delta after a replay. The database retains complete records even when a response displays a bounded recent subset.

## Moderator commands

All responses are ephemeral. Execution reuses existing database-wide admin authorization: owner `821682594830614578`, moderator role `1419154303326621739`, and the existing scoped server-permission policy. Sensitive changes append the existing admin attempt/success/failure audit and an atomic practice/MPoTD audit with the mutation. There is no new arbitrary SQL interface.

- `/problem-admin inspect [question]`: reserved banks, attempt counts, provisional difficulty and calibration status.
- `/problem-admin promote question:<id> mode:rated difficulty:<explicit estimate>`: reserve an approved source problem for rated practice.
- `/problem-admin promote question:<id> mode:practice`: reserve an approved source problem for unrated practice.
- `/problem-admin eligibility question:<id> enabled:<bool> invalid:<bool> reason:<text> [difficulty]`: disable/enable/invalidate, or change the initial difficulty before any assignment.
- `/problem-admin attempts question:<id> [offset]`: inspect affected attempts in pages of 100; long reports are attached privately.
- `/problem-admin correct attempt:<id> result:void|correct|incorrect reason:<text>`: append correction and replay affected rating history.
- `/problem-admin cancel-delivery attempt:<id> reason:<text>`: explicit recovery of an unconfirmed reservation, without scoring.
- `/problem-admin configure enabled:<bool> confirm:true [config:<complete JSON>]`: audited experimental enablement/configuration after review.
- `/problem-admin disable`: stop new rated assignments; existing valid attempts remain usable.

Complete configuration example:

```json
{
  "version": "experimental-1",
  "initial": 1200,
  "k": 32,
  "repeatWeights": [1, 0.5, 0.25],
  "cooldown": 30,
  "durationMs": 600000,
  "maxAbandonedPerDay": 3,
  "maxAssignmentsPerDay": 20,
  "provisionalUntil": 20,
  "selectionSpread": 300
}
```

## Migration, compatibility and manual rollout

The existing v2-to-v3 QOTD migration remains intact. The practice extension has its own additive `problem_schema` version 1 ledger in the same SQLite database, so `PRAGMA user_version` remains 3. Tables are `problem_catalog`, `problem_controls`, `problem_players`, `problem_attempts`, `problem_events`, `problem_corrections`, `problem_revisions`, and `problem_audit`, plus indexes and immutable-history triggers. No source rows, settings, approvals, submissions, daily scores or history are renamed, deleted or copied into a new identity scheme. Sharing the database lets daily reservation and practice-bank promotion use the same write lock.

Internal `qotd_*` identifiers, `src/qotd`, `QOTD_DB_PATH`, `QOTD_ASSET_DIR`, role-ID settings, `qotd:*` Bun scripts and old button custom IDs remain compatible. Existing frozen messages retain their original wording until Discord history naturally ages; they are not rewritten. The role itself should be manually renamed **MPoTD Ping** while retaining its ID. Do not roll back to an older binary that ignores the practice-bank exclusion without first quarantining the rated bank.

Before a separately authorized rollout:

1. Review this implementation and [simulation findings](problem-rating-simulations.md), including repeat farming and zero-penalty abandonment incentives.
2. Back up the persistent database and assets consistently. Test the additive migration on a copy and compare original row counts and history. Development here used only isolated synthetic databases; it did not inspect or mutate the live database.
3. Preserve the existing uncommitted solution-crop and moderator/personality changes when moving code. Keep source PDFs and crops on persistent storage.
4. Review grading rules and source rights. Explicitly promote a sufficient bank; do not promote all imports automatically. A 31-question pool is only a mathematical minimum, not a recommended empirically validated size.
5. Review the generated command JSON offline. Manually register `/mpotd` and `/mpotd-admin` replacing `/qotd` and `/qotd-admin`, and add `/problem` and `/problem-admin`. Reapply moderator command visibility in Discord, then manually remove stale command definitions. Do not repurpose old mathematical `/qotd` immediately as casual QOTD.
6. Start/restart/register only under a separate authorized production action. Validate private attachments, modals, owner/moderator permissions, timeout recovery and command visibility in a test server first.
7. Rated practice stays disabled until an authenticated moderator explicitly enables it after review. Public rated leaderboards and automatic calibration remain unavailable. No feature automatically posts practice results publicly.

## Validation and known limits

Run with the repo-pinned Bun 1.4.2:

```sh
export PATH="$PWD/.cache/bun/bin:$PATH"
PYTHON_EXECUTABLE="$PWD/.venv/bin/python" bun test
bun run check
bun run build
.venv/bin/python -m unittest discover -s python -p 'test_*.py'
bun run problems:simulate
git diff --check
```

The suite includes real independent-process score contention, injected clock deadlines, restart/token recovery, rollback and retry faults, repeat sequences, ownership, source-image fallback, daily behavior and additive schema reopening. These are automated/mocked Discord checks, not live delivery validation. Simulations use synthetic data only. See the separate implementation report for actual results.

Empirical difficulty calibration, automatic invalid-problem mass correction, public rated standings and the future casual QOTD are not implemented/enabled. Corrections are per-attempt and inspect views are paginated; moderators must review affected records rather than assume disabling a question erases past effects. Global bank partitioning is deliberately conservative. Private prompts may be copied or already available in published manuals. Activity, initial difficulty errors, memorization and selective abandonment can bias ratings. None of this should be presented as a validated skill measurement.
