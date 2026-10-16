# Announcement hardening engineering report

## 1. Branch and checkpoint

Development branch: `work/announcement-hardening`, created from exactly
`9f6189d3581f24a1b63c8a265b8cb66659b7ab1c` (tree
`af613930077f7e60bb9a77879776c5b47d61d9b5`). The original remote feature branch
was checked again before publication and still points to that checkpoint. The
final stage-8 SHA is recorded in the delivery message and exported report; this
tracked report accompanies that commit. No second development branch was created.

## 2. Commit summary

| Stage | Commit | Result |
| --- | --- | --- |
| 1 | `25af45c` | Deterministic public privacy boundary across extraction, mutations, previews and transport. |
| 2 | `c8f1789` | Authoritative policy reconciliation and permanent logical delivery reservations. |
| 3 | `40618e6` | Source dispositions, supported entity normalization and typed fact semantics. |
| 4 | `ecf3e8c` | Correction patches, pending supersession, rejected-fact history and explicit reconsideration. |
| 5 | `716faf4` | Complete bounded evidence, field attribution and host temporal/privacy enforcement. |
| 6 | `741eab8` | Complete factual review, stable delivery numbers and fresh private alerts. |
| 7 | `8075d0f` | Resumable Gmail pagination, admission barrier and distinct freshness windows. |
| 8 | This report's commit | Synthetic lifecycle corpus, migration rehearsal and final validation evidence. |

## 3. Architecture

The existing source, candidate, approved-event, immutable-revision, job and attempt
boundaries remain. Gmail admits post-bootstrap history arrivals through the query
and organizer filters. Admission immediately establishes a durable unresolved
source barrier. Bounded parsing and host redaction precede advisory extraction.
Host privacy, identity, semantics, attribution and correction checks precede
moderator factual approval. Planning uses immutable revisions and the current
durable policy. Major text/assets retain their separate approval gate. The final
transport rechecks current policy, event, holds, payload, permissions and asset
integrity against a consumed delivery reservation.

## 4. Database changes

Additive migrations now reach schema 9. They retain existing tables and history:

- Version 3 adds public-safety markers and quarantines unsafe legacy unsent jobs.
- Version 4 adds logical job identity/projection/approval columns, permanent
  reservations and conservative legacy delivery guards.
- Version 5 adds source disposition/time/correction, semantic markers, cited IDs
  and host timezone confirmation.
- Version 6 adds fact fingerprints, correction patches, supersession links,
  rejection/reconsideration ledgers and authoritative source anchors.
- Version 7 retains field evidence on candidates, events and immutable revisions.
- Version 8 adds stable `D#` delivery numbers with permanent number tombstones.
- Version 9 adds the unresolved-source admission barrier and atomic insert trigger.

Candidate numbers and their tombstones remain intact. Migrations do not certify
legacy facts as safe, semantically complete or attributable. Planning and final
delivery reject events without retained field proof.

## 5. Privacy boundary

One deterministic module sanitizes organizer evidence and validates every public
text/URL projection. It covers source ingestion, provider input/output, imports,
edits, approval, rendering, writing, preview, reservation and final transport.
Useful public timetable cells survive alongside withheld credentials and identity
data. Encodings, split labels, blank-line credential values and credential-shaped
session headings are covered. Assessment-launch paths, personalized account paths,
authentication links and credential-bearing meeting surfaces are rejected.
Hostname checks account for trailing DNS dots.

Evidence location metadata is restricted to host MIME/page/chunk locators before
provider use or display. Unknown fields cannot carry side-channel input. The
normal rendered review and Discord payload do not expose Gmail/attachment IDs or
internal source/job keys. Approved source statements cannot be replaced behind
an immutable revision. Human approval never overrides host privacy validation.

## 6. Correction lifecycle

Host-detected errata remain corrections even if advisory import JSON says false.
Unreadable replacement evidence cannot become harmless unchanged facts. Supported
unreadable errata remain held until explicit factual resolution or dismissal.
Partial patches preserve unspecified baseline fields; explicit clear lists and
cancellation/postponement are separate operations. Inherited field proof remains
linked to the earlier source.

Reliably newer proposals supersede older pending rows and invalidate old review
versions while preserving numbers and audit history. Later equivalent confirmations
also advance source authority, preventing an intermediate delayed correction from
displacing them. Equal or missing source order requires explicit conflict
resolution. Normalized rejected fingerprints remain rejected; materially changed
facts are linked and audited, and same-fact reconsideration requires genuinely new
retained evidence plus an explicit staff reason. Missing pre-bootstrap baselines
remain review uncertainty. Sent, delivering and uncertain history is preserved.

## 7. Logical delivery and N1/N2

N1: a durable policy revision/fingerprint and compare-and-swap registration make
stale worker snapshots unable to overwrite a newer plan. Runtime policy is reloaded
after awaited work and again at final transport.

N2: logical identity binds guild, stable event identity, approved revision, stable
rule and destination, with an explicit occurrence distinction reserved for audited
host use. Templates, mention roles, staff routing and timing adjustments do not
reissue a consumed obligation. Projection hashes can replace changed unsent drafts
without changing logical identity. Reservations and attempt history survive
restart, reconciliation and policy edits. Uncertain transport is never retried
automatically. Unmappable legacy obligations remain conservatively guarded.

## 8. Source dispositions

`public` creates reviewable proposals; `private` and `ignore` produce no public
candidates and release unrelated barriers. Personal ClassMarker readiness bypasses
the provider. Unsupported HKISO/VTASP remains outside mathematics scope. Mixed or
unreadable supported corrections become `needs_review`. The host checks retained
source semantics on manual imports as well as the Gmail path. Zero public events
is valid for an explicit non-public disposition.

## 9. Availability, time and logistics

Availability distinguishes unknown, expected, available, partial and unavailable,
with observation/expected times. A link does not prove availability. Affirmative
availability must be cited, and a later negative qualifier in the complete current
message cannot be hidden by selecting an earlier chunk. Current-message checks
are separated from historical inherited proof. Redacted current context requires
explicit factual confirmation before it can certify an available-now claim.

Exact, date-only, window and relative temporal facts remain distinct. Gmail time
anchors relative wording; imprecise expressions do not invent clock times.
Non-null operative times require precision evidence. Provider
`timezoneAssumed=false` cannot establish timezone: cited explicit timezone/offset
evidence or trusted staff confirmation is required. Check-in, examination and
mock-test windows have separate identities. Venue, bring items and participant
instructions use bounded typed logistics.

## 10. Moderator workflow

The private review shows the complete public projection using readable labels,
separate candidate and event lifecycle states, evidence locations, completeness
warnings and a privacy notice. Corrections show the reviewed baseline revision
and changed before/after values. Malformed or foreign-server provenance is withheld
with an actionable review message.

Stable candidate numbers remain. Exact `D#` references work across delivery
preview, attachment and reconciliation; autocomplete returns individual delivery
references rather than collapsing multiple jobs to a candidate number. Legacy
candidate shortcuts only resolve when exactly one job matches. A new reconsider
command invokes the explicit audited rejected-fact workflow. No command
registration was performed.

## 11. Alerts

Pending candidate discovery queries actionable work directly, so an older pending
item beyond the newest 100 remains alertable. Inbox pagination remains available
for candidates, sources and deliveries. Immediately before private transport,
alerts recheck whether the candidate, source, job or provider incident is still
actionable. Resolved notices become superseded. Fresh channel, gate and private
permission checks precede send. Existing provider aggregation, cooldown and
recovery behavior remains; no per-email outage spam was added.

## 12. Gmail and scheduling

Fresh bootstrap still saves the current profile history boundary and imports
nothing. A delayed concurrent bootstrap cannot replace an established boundary.
Resumable state retains history/query tokens, deduplicated history arrivals, query
intersection and admission progress. Each tick fetches at most five pagination
pages and performs bounded admissions. Query results alone never admit messages.
Source persistence and admission progress commit atomically; the cursor advances
only after all admissions are durable. History expiration pauses without backfill.
Corrupt, oversized or conflicting pagination state pauses for review.

The source barrier begins at admission, including a source beyond the worker's
first five items and events approved after admission. Classification releases
private/unsupported sources or narrows identified proposals to affected events.
Routine freshness defaults to one minute, with bounded configurable grace and a
usable zero-offset interval. Major editorial freshness defaults to 24 hours from
fact approval, with bounded policy overrides and operative-event caps. Restarts
do not move the horizon to the current time. Expired unsent jobs become skipped
and cannot be revived by ordinary replanning or a later wider window.

## 13. Synthetic A–G corpus

| Family | Observed local regression behavior |
| --- | --- |
| A | Public sessions/deadlines survive mixed credentials; later time-only correction retains URL and increments the reviewed revision. |
| B | Empty/future folders remain expected and unresolved; Session 2 pretest stays separate; later affirmative mail can confirm Session 1 availability. |
| C | VTASP remains unsupported; supported unreadable image/PDF errata retain holds and require explicit manual resolution. |
| D | TIMO exam/mock windows survive; candidate identity, PIN and personalized links are withheld; HKISO bypasses extraction. |
| E | PIMSO check-in/exam remain distinct with typed public venue/items/parent logistics. |
| F | BBB repeat/forward normalization does not revive rejected facts; materially changed deadlines create linked audited proposals. |
| G | Personal readiness is private, with zero provider calls and zero public candidates. |

The corpus contains fabricated `TEST-*` values only. Additional cases cover prompt
injection, malformed output, unsafe links, MIME duplication, oversized evidence,
scanned PDFs and provider/Gmail outages. See `announcement-hardening-corpus.md`.

## 14. Migration rehearsal

Two isolated checkpoint-derived databases were rehearsed: schema v1 without
numbers and v2 with existing numbers/tombstones. Each migrated copy was reopened
twice more, with complete table snapshots unchanged. Schemas 1–9, delivery numbers,
cursor/bootstrap, rejected history, revisions, sent/uncertain/delivering attempts,
alerts and audit rows were verified. Integrity and foreign-key checks passed;
original fixture database hashes stayed unchanged. No Gmail client or public
transport was invoked. See `announcement-migration-rehearsal.md`.

## 15. Validation

Final validation uses an isolated, checksum-verified Windows Bun 1.4.2 runtime and
locked worktree dependencies. WSL could not start because virtualization is
unavailable; no OS feature or service was changed. File-backed Windows SQLite
checks use a local test preload that calls the real close method and then collects
released statement handles. It changes no business assertion or production code.

| Check | Result |
| --- | --- |
| Complete announcement-focused set | 254 tests across 22 files passed, 0 failed. |
| Full repository suite | 796 passed, 6 failed, 3 errors; 802 tests across 64 files. |
| Untouched exact checkpoint, same Windows runtime | 607 passed, 6 failed, 3 errors; 613 tests, 46 files. |
| A–G lifecycle corpus | 13 passed. |
| Final isolated migration rehearsal | 2 passed; two further reopens per fixture. |
| `bun run check` | Passed. |
| `bun run build` | Passed. |
| `git diff --check` | Passed. |
| Actual Python unittest suite | Blocked on both trees by Unix-only `resource` after configuring its module path. |

The full suite is **not green on this Windows host**. The same five named SQL/HTTP/
calculator failures, vision fixture setup failure and three errors reproduce on
the untouched checkpoint. They include Unix-dependent Python workers, native
Windows setup/subprocess behavior and cleanup of pre-existing open databases.
The before/after named-failure sets were compared directly. No unrelated test was
deleted, skipped or weakened; no general AI/Python implementation was changed.

## 16. Limits and deferred work

All results are local synthetic evidence. Authenticated Gmail/provider/Discord
behavior and a live production migration were not exercised. A green full suite
and Python suite on the supported Linux runtime remain required before deployment.
Scanned schedules still require manual transcription; OCR/vision is deferred.
Field linkage proves traceability, not deterministic interpretation of every PDF
table or model assertion; moderators must compare complete facts with evidence.
Ambiguous source ordering remains manual review. Conservative mixed-source
availability/privacy cases can require explicit factual separation. No automatic
legacy reconstruction, historical replay or resend/reissue mechanism was added.

## 17. Operational confirmations

Auto-send remains OFF: no production gate/default/config was enabled. No public
announcement was transported. No production deployment, merge, PR, Gmail history
replay, OAuth/config change, PM2/service restart or command registration occurred.
The original checkout and unrelated local files were preserved. Changes to
application source are confined to announcements and its existing command host;
general Aleph routing, persona, models, memory, web retrieval, calculator and
Python architecture were not modified. Only the authorized new development
branch is intended for publication.

## 18. Recommendation

Ready for independent code review of the announcement implementation, with the
Windows baseline limitations stated above. It is a candidate for a future separate
auto-send review after supported-runtime validation and live integration review.
Auto-send and automatic production deployment remain NO-GO for this branch.
