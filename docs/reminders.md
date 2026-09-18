# Moderator reminders

Reminders run in the Discord bot process, independently of inference, the AI service, its enable/disable state, tester allowlist and MPoTD. All five `/reminder` actions require Manage Server, checked at runtime by Discord permissions. Responses are private to the moderator. Destinations are server text channels that both the moderator and bot can view and send in. Optional roles must belong to the server and be mentionable by the bot. No messages are generated or rewritten by AI.

## Commands

`/reminder create template:session channel:#sessions at:2030-10-20 17:00 details:VTAMPS starts at 18:00 Manila; bring your worksheet. role:@participants`

`/reminder create template:pretest channel:#sessions at:2030-10-19 18:00 details:Please complete the ClassMarker pre-test before tomorrow's session.`

`/reminder create template:deadline channel:#competitions at:2030-10-20 12:00 details:Registration closes tomorrow; use the registration link in the official announcement.`

`/reminder create template:update-roles channel:#staff at:2030-10-20 09:00 details:Review participant roles. repeat:months interval:5`

`/reminder list` lists the first 50 records with IDs and states. `/reminder view id:ID` shows details, send time, recurrence, creator/editor and last message ID. `/reminder edit id:ID at:2030-10-21 09:00` reschedules a pending reminder; other create fields are optional edits. `clear-role:true` removes the role. `/reminder cancel id:ID` cancels pending or uncertain records. Already claimed/delivering or finished reminders cannot be edited or cancelled.

Templates are `session`, `pretest` (including ClassMarker), `deadline` (including registration), `update-roles`, and `generic`. Each supplies a fixed heading, exact moderator-provided details (up to 1,200 characters), optional role and scheduled timestamp. Users/everyone/here and roles embedded in details are not pinged; only the explicitly configured role is permitted. Details are not escaped or rewritten, so moderators control their formatting. The bot does not invent event dates, URLs or deadlines.

## Time and recurrence

Enter the **send time**, not the event time, as `YYYY-MM-DD HH:mm` in Asia/Manila (UTC+8). To remind one hour before an 18:00 session, choose 17:00. No natural-language dates, cron, automatic lead-time calculation or AI parsing is used. SQLite stores Unix milliseconds; Discord displays native `<t:...:F>` / relative timestamps in each viewer's timezone. Creation/rescheduling requires a future time within 100 years.

Recurrence defaults to `none`. `days` or `months` uses `interval` 1–120 (default 1); annual means months/12. Monthly recurrence preserves the original Manila day and clock time, clamping to the last day of shorter months: January 31 → February 28 → March 31. Leap-day yearly schedules clamp to February 28 outside leap years. Editing resets the recurrence anchor to the resulting send time.

The scheduler polls every 15 seconds, processes at most 25 due reminders per tick, and prevents overlapping ticks. Overdue pending reminders send once on restart. After a successful recurring send, the next occurrence is the first anchored time strictly after completion; missed occurrences are skipped, never burst-posted. Slow delivery can delay other reminders.

## Persistence and ambiguous delivery

`REMINDER_DB_PATH` is read from the isolated bot environment, defaulting to `data/reminders.development.sqlite` or `data/reminders.production.sqlite`. A bot-owned SQLite connection uses WAL and a busy timeout. Startup creates only `reminders`, its due-time index and `reminder_deliveries` in this database; AI/MPoTD schemas and data are untouched. No database is opened merely by loading command definitions.

Claiming uses an immediate transaction and a conditional pending-state update, plus a unique `(reminder, due)` delivery reservation. The claim is durable **before** contacting Discord. Competing connections cannot claim the same occurrence. Discord messages also use a stable per-occurrence nonce with enforcement to reduce duplicates from transport retries. Success and recurrence advancement commit atomically.

Exactly-once delivery cannot be guaranteed across SQLite and Discord. We prefer potentially missing a reminder over duplicate pings: errors leave it `uncertain`; a crash around sending can leave it `delivering`. Neither is automatically retried or advanced, even after restart. Inspect the destination and message ID. For an uncertain record, cancel and explicitly create a replacement only if appropriate. For a stuck delivering record, first ensure the old worker is stopped and inspect Discord before manually creating any replacement. There is no automatic lease expiry or recovery resend. These states remain visible in list/view; there is no extra staff-alert channel. Removing destination permissions/roles requires moderator review.

## Current legacy production: /opt/math-bot + PM2

Local WSL validation uses the pinned Bun runtime and the installed Python virtual environment: `PYTHON_EXECUTABLE="$PWD/.venv/bin/python" bun test`, `bun run check`, `bun run build`, and `.venv/bin/python -m unittest discover -s python -p test_math.py`. Tests use temporary databases and mocked Discord sends; never point them at production storage.

1. Review/test, commit and push through the normal workflow. Back up persistent data using SQLite-aware backups. No production database was touched during implementation.
2. For the current /opt/math-bot installation, the recommended bot setting is `REMINDER_DB_PATH=/opt/math-bot/data/reminders.production.sqlite`. Retain /opt/math-bot/data across in-place updates and ensure Unix user mathbot can write it. This is an absolute path independent of PM2 working-directory resolution. Use separate development storage.
3. Current production uses Bun, python3 and PM2 under Unix user mathbot. During an authorized update, work in /opt/math-bot and use the existing PM2 process identity in that user account; process names are not specified here. Restart only the Discord bot for reminders. Do not use the future /srv release script or systemd instructions on this installation. First startup creates the additive reminder schema; no MPoTD reset is required.
4. Manually register changed command definitions (development first; production only during the intended rollout). Nothing registers on startup. Production uses `bun run commands:deploy:production` separately from deployment.
5. In an approved test channel, manually create a near-future reminder without a role, verify timestamps/delivery and cancellation, then test the intended role and staff permissions. Live Discord sends were not performed during implementation.

## Future target: /srv/math-bot exact-SHA releases

After a separately planned migration, use `REMINDER_DB_PATH=/srv/math-bot/shared/data/reminders.production.sqlite`. The future release layout links each release's data directory to shared/data. Preserve the existing reminder database and delivery ledger when migrating; changing only the path would create an empty database. The manual `scripts/deploy-vps.sh FULL_COMMIT_SHA` architecture and systemd templates remain the future design described in [operations](operations.md). They are not instructions for today's PM2 installation.

No reminders are created from existing announcements automatically. No delivery retry/resume command, arbitrary cron, timezone selector, attachment support, or historical pruning is included in this MVP.
