# Announcement automation implementation checklist

Audit date: 2026-10-08. No secrets are included in this record.

- [x] Refresh all remote branches; inventory tracked repository and reachable history.
- [x] Compare every branch to main; main/origin main = 7832d86; scoring branch is merged; audit branch +5 and moderation/security branch +9 contain unrelated changes.
- [x] Inspect production: /opt/math-bot at main 7832d86, Bun 1.4.2, PM2 aleph-zero-bot and aleph-zero-ai under mathbot; local llama-server under ubuntu. No math-bot systemd unit found. /srv scaffold exists but is not active.
- [x] Inspect DBs read-only: qotd, admin, manual reminders, AI jobs all quick_check=ok. Preserve AI database's additional reaction_roles/role_grants tables.
- [x] Record protected production training hashes and identify local training edits/backups; do not overwrite them.
- [x] Locate actual 120-row routing holdout: tests/fixtures/router-holdout-v2.jsonl. It labels routing, not full-answer correctness.
- [x] Create feature/announcement-automation from verified origin/main in an isolated worktree.
- [x] Port domain validation with separate competition/round/program identities and first-class statuses.
- [x] Dedicated versioned store, corrections/holds/cancellation, immutable jobs, uncertain delivery.
- [x] Generic provider, safe quota queue, health, no paid fallback.
- [x] Read-only Gmail sync and bounded/redacted attachment parsing.
- [x] Strict extraction and locked writing; no model-authorized policy or sends.
- [x] Private Discord /announce review, editing, media, approval, reconciliation.
- [x] Offline fixtures: 302 Bun tests, 4 Python tests, typecheck and build passed; disabled setup DB quick_check=ok.
- [x] Provider benchmark harness implemented; live comparison and human grading remain blocked on the user-supplied Groq secret.
- [x] Production backup completed at /opt/math-bot/backups/announcement-predeploy-20261008T144440Z; all four DB backups quick_check=ok. No services restarted.
- [ ] Reversible deployment, production shadow worker, command registration and live health.
- [ ] User OAuth/secret setup and real organizer shadow validation.
- [x] Public auto-send remains OFF until separate explicit approval.

Audit discrepancy: docs describe /srv as future; live host has the directories but still runs /opt. Windows SSH does not resolve oracle-vps; the configured alias works from WSL. Main does not contain the cognitive provider/protocol improvements on the feature branch. Those will be selected and tested rather than merging unrelated security/training work.


