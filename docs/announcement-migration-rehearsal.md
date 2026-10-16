# Isolated announcement migration rehearsal

`tests/announcement-migration-rehearsal.test.ts` builds two fabricated legacy
databases from the announcement CREATE schema at checkpoint
`9f6189d3581f24a1b63c8a265b8cb66659b7ab1c`. The schema-only fixture is
`tests/fixtures/announcements/legacy-v1-schema.sql`; no production database,
organizer body, Gmail credential, or actual message ID is involved.

The first fixture starts at schema v1 without moderator numbers. The second adds
the checkpoint's v2 numeric-ID table and trigger, with preserved numbers 41, 52,
63, and a deleted-candidate tombstone at 90. Both contain approved, pending, and
rejected candidates, two approved event revisions, seven jobs, sent/uncertain/
delivering attempt history, staff alerts, audit entries, draft retry state,
provider incident history, and a saved future-only Gmail cursor of 150 with its
original bootstrap boundary of 100.

Each fixture is checkpointed, closed, and copied into a separate temporary
rehearsal database. Only the copy is opened by the current `AnnouncementStore`.
The test verifies:

- Original candidate state, review versions, source identity, evidence,
  provenance, revisions, audit rows, staff alerts, and attempt history remain
  unchanged.
- Existing numeric IDs and tombstones remain stable; v1 numbers are backfilled
  once. A subsequently deleted candidate consumes a new number permanently.
- Sent, uncertain, and delivering jobs retain their state and receipts. Unsafe
  legacy unsent jobs become blocked, with message approval cleared and legacy
  delivery guards retained.
- Migration does not certify public safety, semantic completeness, or field
  attribution. Legacy facts stay at safety/semantics version 0 and have no
  invented field evidence. Old pending facts cannot be approved automatically.
- Planning creates no replacement public job for the legacy approved event.
  Auto-send remains false; the mocked transport is never called and the three
  historical attempts stay intact.
- The saved cursor and bootstrap boundary remain unchanged. No Gmail client is
  constructed or called, and no mailbox reconstruction occurs.
- A complete snapshot of every resulting table, including schema versions and
  numeric sequences and delivery numbers, stays identical across two additional constructor reopens.
  The test requires migrations 1–9 and includes any subsequently registered
  additive migrations in that snapshot.
- SQLite integrity and foreign-key checks pass. A SHA-256 comparison proves the
  original legacy fixture database was not modified by migration of its copy.

Validation with the repository-pinned Bun 1.4.2: **2 tests passed, 0 failed**.

```sh
bun test tests/announcement-migration-rehearsal.test.ts
```

This is a synthetic local rehearsal. It does not attest that an authenticated
production database migration has been exercised. No service, mailbox, live
credential, announcement, or production checkout is changed.
