# Future-only announcement release

This release reconciles deployed `c93cd11` with the PC's pending-forward provenance change. Training and evaluation edits are kept outside this release. Public auto-send remains disabled; no public destination or reminder policy is invented.

Fresh announcement storage calls Gmail `profile`, verifies the configured account, and atomically saves `historyId`, bootstrap time, and `future-only` mode. It imports no messages. Later polls take IDs exclusively from History API `messageAdded` records; the restricted math-only query and approved organizer addresses independently filter those IDs. Search results are never a source of bootstrap messages. The cursor advances only after durable source persistence.

HTTP 404 for history records a durable gap, preserves the last cursor, pauses subsequent ingestion, and queues one readable private issue. Staff must review the gap before deliberately selecting a new future-only boundary. No historical scan or automatic cursor replacement is supported. Already-durable sources remain reviewable.

Training session aliases normalize to the explicit session number before identity generation and storage. Ambiguous session names are rejected for manual disposition. Login notices use one canonical login milestone per competition/round/program scope. Conflicting facts and attachment uncertainty remain review blockers. Pending forwards retain source references and new uncertainty invalidates stale approval.

Factual review notifications aggregate per organizer extraction batch, including pending forwarded facts with new uncertainty. Each candidate still requires individual factual approval. HTTP 413 blocks the oversized source for manual shortening/splitting and is diagnosed as request/payload too large, rather than credential configuration or outage. Past starts/deadlines and cancelled/postponed events do not produce approaching-unapproved notices.

## Safe production reset

Stop only the announcement worker. Verify public auto-send is false. The bot's announcement scheduler and review actions support `maintenance:reset=true`; after the scheduler finishes any in-flight tick it acknowledges maintenance and stops announcement activity. This does not stop other Discord functionality.

Create a SQLite online backup of the active dedicated announcement DB, run `PRAGMA quick_check`, and preserve a second verified historical archive. Create a new clean staging announcement DB, authenticate Gmail and bootstrap it at the current history boundary, and check the configured Groq model. Use SQLite's online backup API to atomically replace the active DB's contents with this clean DB. This preserves the active file path and live SQLite connection semantics, avoiding an unsafe rename underneath the running Discord bot. Retain the backup, historical archive, and clean bootstrap staging snapshot. Verify zero sources/candidates/events/jobs and invoke the inbox handler against the active store before starting the worker. Save the worker and bot PM2 definitions; never restart the AI service or local model for this release.

Only the announcement DB is reset. OAuth files/tokens, manual reminders, QOTD, AI databases, training files, unrelated backups and policies are preserved. Gmail remains read-only: automated fixtures test new-message processing without changing mailbox permissions or spoofing approved organizers. A real new-email test requires an actual post-bootstrap message from an approved organizer.
