# Private administrative tools

**Raw SQL is for trusted moderators who understand SQL. Incorrect statements can
destroy or corrupt bot data. There is no automatic undo. Back up and understand
the schema first.** All new command replies, errors and audits are ephemeral.
No commands are registered or deployed by startup or by these changes.

## Permissions and command visibility

Moderator checks use role `1419154303326621739`, the authenticated creator
`821682594830614578`, or the command's existing stronger Discord permission
(Manage Server; Manage Messages for filters). Existing QOTD, reminder, filter and
AI administration now recognize the role. AI administration still additionally
requires tester admission. Public QOTD statistics and ordinary commands keep
their existing access. User-provided IDs/names never authenticate an actor.

New admin commands default to disabled in Discord command permissions. An
administrator must explicitly allow the moderator role / creator under Server
Settings → Integrations after manually registering reviewed definitions. UI
permissions cannot bypass runtime checks. The existing filter/reminder/AI UI
defaults also need a role override when the role lacks their permission bit.

`/sql` can affect the **entire selected database, across guilds**. Treat anyone
granted access as a database administrator. To avoid Manage Server in an unrelated
guild granting global access, SQL requires the moderator role itself, the creator,
or stronger permission in the guild that actually contains that specific role.
The creator must still use SQL in a guild. Other QOTD commands stay guild-scoped.

## Owner-managed testers

- `/ai-testers list`
- `/ai-testers add user:<member>`
- `/ai-testers remove user:<member>`

These use a separate command so the creator can manage admission even if not
currently an AI tester. All operations require the exact authenticated creator
ID; moderator/admin privileges do not bypass this. Runtime IDs persist in
`ADMIN_DB_PATH`. Effective admission is the union of `AI_TESTER_USER_IDS` and
runtime entries. Duplicate add / missing remove are no-ops. Removing a runtime
entry never removes a static entry; the confirmation says when static access
remains. No environment files are rewritten. Changes apply on the next admission
check without a restart. Existing accepted jobs are not cancelled. Discord tool
dispatch rechecks the gate, so removing a tester can prevent subsequent Discord
lookups for their already-accepted jobs; ordinary inference/delivery is unchanged.

The shared gate covers slash commands, direct submission, mentions/replies and
Discord tool dispatch. Mention prompting still also requires message features.
A failed runtime-store read denies dynamic admission; static IDs remain valid.
Service authentication, queue and coach policies remain independent.

## QOTD correction

- `/qotd-admin view user:<member>` — derived stats and last ten finalized records.
- `/qotd-admin set user:<member> post:<id> points:<number> [correct:<bool>]`
- `/qotd-admin add user:<member> post:<id> points:<signed delta> [correct:<bool>]`
- `/qotd-admin reset user:<member> confirm:true`

Points and correctness can be supplied independently. Corrections target an
existing **scored** submission in the current guild, never an active answer.
Points must be finite, nonnegative, at most 1,000,000, with at most three decimal
places. Incorrect submissions require zero points. Setting correctness false
without points zeros the score. Setting it true retains existing points; provide
the intended score explicitly. This is a manual correction, not automatic
regrading using the original scoring formula.

Placements are recalculated from correctness and submission order (timestamp,
then user ID) for the whole affected day. First/second/third counts, accuracy,
participation, rank and weekly/monthly/total points remain query-derived; no
duplicate counters were introduced. Correcting one member can change another's
placement. Other members' point values remain unchanged.

Reset permanently deletes the target's finalized submission records in this
guild and reranks affected days. It preserves active/unscored submissions, bank
questions, posting/no-repeat history and session/delivery state. Reset is not a
zero-points correction; use `set` for that. Mutations are transactional. Already
sent reveal messages and frozen delivery payloads are **not rewritten**; publish
any explanatory correction manually. No competition schema migration was needed.

The separate command avoids unsupported four-level Discord command nesting.

## SQL

- `/sql databases` — `qotd`, `reminders`, `ai`, with no filesystem paths.
- `/sql schema database:qotd` — table/index definitions (bounded).
- `/sql run database:qotd command:SELECT ...`
- `/sql audit` — last ten admin entries for the invoking guild, bounded.

Registry paths come only from the existing isolated bot/QOTD/AI configuration,
never Discord input. Missing database files are not created by SQL. `admin` is
not selectable: its tester registry and audit trail cannot be altered via SQL.
Configuring its path to alias a selectable database disables registry access.
Keep it a distinct regular file; operators must not hard-link it to another DB.

One statement per execution. Multi-statement execution is deliberately disabled:
transaction control, implicit commits and ambiguous result sets would undermine
rollback and audit clarity. The worker wraps the statement in a transaction,
enforces foreign keys and rolls back SQLite errors. DDL and ordinary mutations
are allowed. No SQL keyword filter attempts to make destructive edits harmless.

SQLite authorizer restrictions deny ATTACH/DETACH (including VACUUM INTO),
extensions, filesystem functions, virtual-table creation and caller-controlled
transactions/savepoints. PRAGMA is limited to table/index/foreign-key schema
inspection; file/connection-changing PRAGMAs are blocked. No arbitrary path,
shell command or executable argument is accepted. `database_list` is blocked to
avoid exposing paths. Existing SQLite errors are returned as safe error codes,
not raw messages which may echo paths or sensitive values.

Ordinary stores still use Bun's existing `node:sqlite`. The local Bun authorizer
was checked and enforced denial, but the SQL escape hatch uses an isolated Python
stdlib worker for its established authorizer, progress handler and SQLite limits,
plus Linux CPU/address-space limits. This adds no package dependency. Bun remains
the bot runtime; `ADMIN_PYTHON_EXECUTABLE=python3` is the production default.
Run under WSL/Linux; no host Windows worker fallback is promised.

Limits: 4,000 SQL characters, 3-second VM deadline, 4 CPU seconds, 6-second parent
timeout, 256 MiB address space, 1 MiB SQLite value limit, 100 columns, at most 20
shown rows / 8,000 encoded row characters, 200 characters per cell, blobs omitted,
Discord reply at most 1,800 characters. Counts report **shown** rows, not an
expensive total. Truncation is explicit. Narrow the query to inspect more.
DDL may report zero affected rows. Worker interruption near commit can leave an
uncertain outcome: inspect data/audit before retrying; never assume safe retry.

## Audit and storage

New additive admin database schema v1: `testers(user,actor,created)` and
`admin_audit(id,created,actor,username,guild,action,target,phase,details)`.
It is initialized lazily, uses WAL and a busy timeout, and is separate from all
selectable SQL databases. Audit APIs only append/read; no erase command exists.
This is application-level append-only, not tamper-proof against OS administrators.

SQL logs an attempt before executing, then outcome/affected rows/error code.
Discovery, schema, audit reads and unauthorized uses are audited too. Full SQL
is retained deliberately for accountability: **never paste tokens, passwords or
other secrets into SQL**. Protect the DB and backups as sensitive. No raw SQL is
printed in ordinary logs. Recent audit output is ephemeral and guild-filtered.

Tester mutations and their audit are in one transaction. QOTD mutations record
before/after target records (including answers), actor and action. SQL/QOTD data
and audit are separate databases, so a crash after commit can leave an attempt
without completion. Inspect such attempts; do not blindly retry. If initial audit
storage is unavailable, these commands stop before mutation. Completion audit
failure is reported as uncertain. Audit rows contain private content and require
the same access protection as the source records.

## Manual rollout review — nothing deployed

Current production remains `/opt/math-bot`, Bun, `python3`, PM2 under `mathbot`.
Example `ADMIN_DB_PATH=/opt/math-bot/data/admin.production.sqlite` is persistent
for this existing in-place layout; retain/back up it alongside other databases.
Use a distinct development path. Configure normal Unix permissions so only the
bot operator can access admin storage and backups. No current secret file changed.

Future `/srv/math-bot` exact-SHA manual releases/systemd remain a separate planned
architecture. When explicitly migrating later, use persistent shared admin
storage such as `/srv/math-bot/shared/data/admin.production.sqlite`, not a release
directory. Do not assume that layout exists now.

Before a future deployment: review these permission/SQL/reset decisions, back up
the databases, reconcile the VPS-only `src/commands/qotd.ts` edit without discarding
it, configure the admin path and Python executable, check worker file packaging,
and test in the development guild. Review generated command JSON and manually
register only when ready; the existing definition-change comparison remains.
An operator must separately approve deployment/restart under the current PM2
layout. No model training, service restart, registration, commit or push is part
of this implementation.
