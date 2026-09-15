# QOTD: private answers, reviewed source crops, and persistent scores

## Daily behavior

All times and leaderboard dates use Asia/Manila (UTC+8). The existing schedule uses UTC hours: configure `/qotd schedule channel:#math hour:0 role:@QoTD Ping` for **08:00 Manila**. A restart during the submission window catches up today's missing post. `/qotd post` uses the same no-repeat reservation and is available only between 08:00 and 21:59:59. It does not bypass today's slot.

The main message contains the reviewed original question crop, optional configured role ping, concise discussion/replacement instructions, and one **Submit Answer** button. A dated discussion thread attaches to this message. No polls, answer slash commands, answer reactions, or extra submission buttons are created. Reaction-role management was already absent from this checkout; this upgrade preserves the existing `QOTD_ROLE_ID` and schedule-role selection. Manage role membership using your existing server process.

Clicking the main message's button opens a private modal. Every submission replaces the user's answer **and timestamp**, including correct → wrong → correct changes. The ephemeral acknowledgement never discloses correctness. By submitting, participants consent to being mentioned in that day's results. Discussion messages are never submissions. Humans can discuss answers and solutions freely; normal AI mentions/replies in these threads are silently ignored before conversation lookup or queuing. Unrelated AI and moderation behavior is unchanged.

At **21:59:59** the server rejects all new answers, including already-open modals, and attempts to disable the main button. The backend checks the trusted close timestamp inside the write transaction even if the scheduler or Discord edit is late. At **22:00** it grades final answers, commits scores once, and delivers the official answer, solution and correct-participant results. The scheduler checks every second; network/host delays may delay visible edits or messages, but never extend acceptance. Failed button edits retry and do not prevent reveal. Due modal-era sessions are recovered across dates even if their posting schedule has since been disabled.

## Import and moderator review (WSL, Bun only)

Windows `D:\devstuff\math-bot\solmans` is `/mnt/d/devstuff/math-bot/solmans`:

```sh
cd /mnt/d/devstuff/math-bot
export PATH="$PWD/.cache/bun/bin:$PATH"
bun install --frozen-lockfile
BOT_ENV=development bun run import:solmans ./solmans
BOT_ENV=development bun run qotd:review-ui
```

The local review UI at `http://127.0.0.1:8790` retains collaborative review claims, source previews, replacement uploads and acknowledgement checks. Review the full source, official fields, duplicate flags, crop completeness and answer leaks. All new imports remain pending until explicitly approved. Equivalent commands:

```sh
bun run qotd:review list
bun run qotd:review show QUESTION_ID
bun run qotd:review replace QUESTION_ID --image ./01.png --image ./02.png
bun run qotd:review approve QUESTION_ID --ack-source-review --ack-crop-review
bun run qotd:review reject QUESTION_ID
```

The recursive importer supports the existing PHIMO mixed-choice/open-response and VTAMPS topic-based formats. Content-derived source identity and normalized question fingerprints provide idempotence independent of filenames; the uniqueness constraint and persistent used-question ledger survive re-imports. Original filenames are retained privately. Near duplicates and conflicting official fields require review, never automatic correction. Official answer and solution text remain exactly as imported. Choices are never invented.

Question crops use PDF.js geometry and rendering at 3x scale, preserve original diagrams/math, and exclude worked answers and neighboring questions. Ambiguous crops fail closed. Approval and posting validate image hashes, size and count. The maintained, pinned `pdfjs-dist` and explicit `@napi-rs/canvas` dependencies already provide Bun/Node-compatible extraction/rendering; no new PDF or AI dependency was added. See [PDF.js Node examples](https://github.com/mozilla/pdf.js/tree/master/examples/node). Tests generate synthetic PDFs; do not commit source manuals or generated assets. `solmans/` and `data/` remain ignored.

## Grading and scoring configuration

Use `bun run qotd:configure question QUESTION_ID ./grading.json` before posting. Configuration is local moderator work and writes an audit entry. It does not change official source fields, crop approvals, fingerprints or existing daily snapshots. Review configuration against the actual source before enabling the schedule. With no configuration the conservative default is **exact_text**, accepting only the official answer with outer extraction whitespace trimmed; no aliases or mathematical equivalence are inferred. The original official text itself is unchanged.

Example `grading.json` (also in `examples/qotd-grading.json`):

```json
{
  "grading": {
    "mode": "numeric_with_unit",
    "value": "3",
    "units": ["cm"],
    "unitRequired": true,
    "fractions": true
  },
  "scoring": {
    "strategy": "linear-time",
    "version": 1,
    "basePoints": 10,
    "speedBonus": 2,
    "bonusWindowSeconds": 3600
  },
  "difficulty": "optional moderator label"
}
```

| Mode | Configuration | Matching |
| --- | --- | --- |
| `exact_text` | `answers: ["Blue"]` | Exact string, including case/spacing |
| `normalized_text` | `answers: ["blue sky"]` | NFKC, trim/collapse whitespace, lowercase |
| `multiple_choice` | `answers: ["A", "option A"]` | Same normalization; only explicit aliases, no poll |
| `numeric` | `value: "0.5", fractions: true` | Decimal/exponent forms; fractions only when enabled |
| `numeric_with_unit` | `value: "3", units: ["cm"], unitRequired: true` | `3cm`, `3 cm`, `3 CM`; incompatible units rejected |
| `variable_value` | `value: "3", variable: "x", wrapperOptional: true` | `3`, `x=3`, `x = 3`; other variables rejected |

For optional units use `unitRequired: false`: a bare number is accepted but a supplied incompatible unit is still rejected. Units are explicit aliases for the same scale, **not conversions**; do not list `m` as an alias for `cm`. Numeric modes accept an optional nonnegative absolute `tolerance` (default zero). Fractions/decimals use finite JavaScript numbers; this is for short numeric answers, not symbolic algebra or arbitrary-precision proofs. `variable_value` requires its wrapper when `wrapperOptional` is false. Variable names are case-sensitive. No grading path calls a model or evaluates submitted code.

The centralized `src/qotd/scoring.ts` exports `scoreSubmission(context, config)` and `DEFAULT_SCORING`. Default correct points are:

`round_to_0.001(10 + 2 × max(0, 1 − elapsedSeconds / 3600))`

Incorrect submissions earn zero. Correct submissions at 30 seconds get 11.983, at 4 minutes 11.867, and after an hour still get 10. Placement does not add a separate default bonus. Tune the three numeric config values per question, or change `DEFAULT_SCORING` for future unconfigured questions. For a different strategy extend the strategy/version validator and centralized function; persistence already stores the complete config and context. Existing scores are never recomputed. Context includes openedAt, final submittedAt, elapsedSeconds, placement, participant/correct counts, question type and optional difficulty. Opening time is the actual posting attempt, so delayed catch-up posts do not start with a time penalty.

## Separate solution assets and public source metadata

The existing automatic pipeline produces **question** crops only. It cannot safely be relabeled as solution extraction. For a source solution crop, inspect/crop the solution separately and use the existing image-normalization/hash infrastructure:

```sh
bun run qotd:configure question QUESTION_ID ./grading.json \
  --solution-image ./solution-01.png --solution-image ./solution-02.png \
  --ack-solution-review
```

The CLI stores distinct hashed PNG assets under `QOTD_ASSET_DIR/solution-overrides`. It rejects reuse of an identical question crop. At reveal a valid solution crop takes precedence over duplicate solution text; otherwise official solution text is shown, or only the answer if absent. Oversized official text is attached intact. Missing/tampered crops fall back to text when first planning delivery. Once a delivery is planned its payload/asset hashes are frozen; restore missing assets before resuming that delivery.

Public source data is saved separately in the daily snapshot: known competition, year, edition, level, set, question number and 1-based physical PDF question/solution pages. The arbitrary import filename, source title guess and storage path are not public source names. A moderator may set `publicSource` with these exact field names in configuration when reliable source details need correction. Omit unknown optional fields; no competition-name expansion is invented.

Only the initial question may mention the configured ping role. Official source messages have `allowedMentions: {parse: []}`. Correct-result messages are separate, contain actual stored participant IDs, and allow only those exact user mentions, at most once per participant. They never enable roles, everyone/here or reply pings. Incorrect private answers are never displayed. No correct answers produces a short clean announcement.

## Public standings

`/qotd leaderboard` shows top 10 total, current calendar month and current Monday–Sunday week. `/qotd stats [user]` shows all three points/ranks, final correct/submitted counts, accuracy and first/second/third finishes. These commands are available to ordinary members; post/reveal/history/schedule/disable/reset retain runtime Manage Server checks. Standings do not ping users.

Daily correct placements sort by final submission timestamp, then Discord user ID ascending for exact time ties. Standings sort by persisted points descending, correct count descending, then user ID ascending (lexicographic); ranks are ordinal. Accuracy uses completed, scored QOTDs where the user submitted; an unanswered day and a still-open day are not an incorrect answer. Replacements count once. Periods use the question's Manila date, even if reveal was delayed into a later period.

Weekly/monthly reset notices appear on the first reserved QOTD of a new period, persisted with unique guild/period keys. Both may appear together. No scores are deleted. An ambiguous initial send keeps its reservation and notices consumed, preventing duplicate announcements on restart.

## Schema, failures and recovery

Opening an existing **v2** QOTD database applies an additive, transactional **v3** migration. Existing bank, source occurrences, review claims, approvals, schedules, used-question ledger, posting history and audit rows stay intact. Added tables: `qotd_question_settings`, `qotd_sessions`, `qotd_submissions`, `qotd_modal_tokens`, `qotd_period_notices`, `qotd_delivery`. Legacy posts have no fabricated submissions or scores and are not retroactively reopened or automatically revealed by the modal scheduler. Perform rollout after the old day's reveal when possible. Older pre-crop/unknown schemas remain rejected; do not reset a production database to bypass this.

Each main-message button is checked against guild, channel, stored main message, active daily ID and close time. Modal tokens are random, persisted, single-use, and bound to that user and original context. Acceptance occurs inside an immediate SQLite transaction, with server time read after acquiring the lock. Final grading/score updates commit in one transaction and are idempotent. Keep the host clock synchronized.

Discord documents that a [thread started from a message shares that message's ID](https://docs.discord.com/developers/resources/channel#start-thread-from-message). This lets the bot recognize the discussion immediately, even if the thread-creation response is lost.

Posting reserves an unused question before sending. Failed or ambiguous initial sends remain consumed. `/qotd reset question:FULL_ID confirm:true` is the audited moderator escape hatch for a future day; it never erases scores/history or reopens today's slot. Do not use `qotd:reset-local` for this upgrade—it is a destructive development-only tool, not a migration.

Reveals save scores before delivery and freeze an ordered message plan. Confirmed parts are never sent again. Definitive HTTP 4xx failures retry after permission/payload repair; a timeout, 5xx, or crash after reserving a send is **uncertain**, since Discord may already have received it. Automatic retry is intentionally blocked to avoid duplicate participant pings. Inspect the original channel and reconcile each uncertain part locally:

```sh
bun run qotd:configure delivery POST_ID
# If the part exists in Discord:
bun run qotd:configure reconcile POST_ID PART --message DISCORD_MESSAGE_ID
# Only after verifying it did NOT arrive:
bun run qotd:configure reconcile POST_ID PART --confirm-not-delivered
```

Then the scheduler or `/qotd reveal post-id:POST_ID` resumes unsent parts without rescoring. The development reveal helper also honors the 22:00 cutoff; it no longer bypasses it. If a discussion thread fails to create, the confirmed question remains usable and its message ID remains recognized as the discussion thread ID if created manually later.

## Manual VPS rollout checklist (not automatic)

1. Finish/reveal the old day's QOTD; stop the bot and review processes. Back up the persistent QOTD SQLite database consistently (including WAL if not cleanly stopped) and its complete asset directory. Keep secrets private.
2. Review/apply this code; retain the persistent `QOTD_DB_PATH` and `QOTD_ASSET_DIR` paths and separate dev/production data. Do not reset, overwrite or move production state into an ephemeral release folder.
3. With Bun 1.4.2, run `bun install --frozen-lockfile`, `bun run check`, `bun test`, and `bun run build`. The full suite also needs the existing Python virtualenv. No dependencies were changed by this upgrade.
4. Inspect grading configs and solution assets for approved questions. The additive migration runs when the QOTD store opens. Verify v3 and existing history counts on a backed-up staging copy first.
5. **Redeploy slash commands manually**: `bun run commands:deploy:production` (or `bun run commands:deploy:dev` for development). The parent command permission must update so leaderboard/stats are public; runtime moderator checks remain. Remove any stale server-side command overrides that block ordinary members.
6. Grant View Channel, Send Messages, Attach Files, Read Message History and Create Public Threads; check role mention permission. Send Polls is no longer used. Keep schedule hour 0 for 08:00 Manila, then start/restart the bot.
7. In a test server verify the crop/button/modal, private replacements, human-only discussion, close/reveal and public standings. Monitor uncertain delivery logs; retain DB/assets across all future releases. No live Discord send, registration or VPS deployment is part of automated tests.
