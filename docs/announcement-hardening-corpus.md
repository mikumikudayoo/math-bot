# Announcement hardening: synthetic lifecycle corpus

The corpus is fabricated from the requested A–G behavior descriptions. It contains
no copied organizer bodies, actual participant identities, Gmail message IDs,
OAuth credentials, or live private links. `TEST-*`, Synthetic Student, Synthetic
School, `example.invalid`, and `example.org` are deliberate test data.

The readable messages are in
`tests/fixtures/announcements/families.json`. Advisory provider responses are
constructed separately in `tests/announcement-corpus.test.ts`; they pass through
the ordinary parser, redaction, source disposition, strict extraction validator,
retained evidence, candidate reconciliation, staff approval, planning, and final
payload validator. Source and candidate IDs stay internal. Transport is mocked,
and every corpus configuration keeps `autoSend: false`.

| Family | Sequence | Required behavior tested |
| --- | --- | --- |
| A: training guidelines | Mixed credentials and public timetable; later time-only correction | Both sessions and the independent HKIMO registration deadline survive redaction. Credentials never reach the provider or public candidates. The correction holds only the affected session, retains the baseline public URL, and creates revision 2 after factual approval. |
| B: materials | Empty folders and “tomorrow afternoon”; later explicit available-now confirmation | Expected availability and its imprecise relative time block approval. Session 2's pretest remains a separate milestone. A later source can confirm Session 1 materials; the major message still requires separate message approval. |
| C: erratum | Unsupported VTASP image; analogous supported VTAMPS image; explicit manual resolution | VTASP stays unsupported and never becomes VTAMPS. The supported unreadable replacement remains needs-review and holds the previous schedule, including when the extracted facts look unchanged. Manual resolution is audited. |
| D: contest guidelines | TIMO public exam/mock windows mixed with participant credentials; HKISO counterpart | TIMO's public windows survive while candidate ID, PIN, identity, and personalized links are withheld. HKISO remains outside mathematics scope and skips the provider. |
| E: onsite guidelines | PIMSO check-in, exam, venue, items, and parent/pickup instructions | Check-in and examination have separate identities and times. Venue, bring items, and participant instructions remain typed public logistics. |
| F: invitation | Original BBB invitation; rejected deadline; equivalent forward with variant version/IDs; materially changed deadline | Canonical catalog/version/session identity prevents duplicate reminders. A forward cannot revive rejection. A materially changed deadline gets a linked new proposal while the rejected record and its numeric ID remain preserved. |
| G: personal readiness | Individual ClassMarker notification | Clean private disposition, no public candidate or availability claim, and zero provider calls. |

Additional corpus cases carry prompt injection, authority fields in model output,
parameterized/private and path-token URLs, equivalent MIME bodies, HTML-only safe
links, evidence over the 50 KB budget, an image-only PDF replacement, and provider
or Gmail outages. Unsupported/private sources release their broad barrier;
unreadable corrections and retrying organizer sources retain it. These cases
never reserve or deliver a public message while auto-send is false.

The adjacent focused suites cover the remaining persistence and concurrency
boundaries:

| Concern | Regression suite |
| --- | --- |
| Pending corrections, older/equal/unknown source order, rejection and reconsideration, sent/delivering/uncertain corrections | `tests/announcement-corrections.test.ts` |
| Restart during planning, competing schedulers, logical delivery consumption, additive ledger migration | `tests/announcement-reconciliation.test.ts` |
| Final transport revalidation across channel/member/role awaits | `tests/announcement-transport-preflight.test.ts` |
| Future-only bootstrap and expired-history pause | `tests/announcement-future-only.test.ts` |
| Durable bounded history/query pagination, admission rollback, delayed arrivals, concurrent sync, overload pause | `tests/announcement-gmail-pagination.test.ts` |
| MIME/PDF page/chunk provenance, late qualifiers, scanned attachments, attachment and MIME budgets | `tests/announcement-evidence-parser.test.ts` |
| Per-field retained evidence and partial-correction inheritance | `tests/announcement-attribution.test.ts` |

Run with the repository-pinned Bun 1.4.2:

```sh
bun test tests/announcement-corpus.test.ts tests/announcement-gmail-pagination.test.ts
bun run check
git diff --check
```

These are local synthetic checks. They do not establish authenticated Gmail,
provider, Discord, or production-migration readiness. No mailbox reset, historical
replay, announcement send, service restart, or deployment is part of the corpus.
