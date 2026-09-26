# Modular moderation design for Aleph-Zero

Status: design only. The referenced NTTS/Sapphire configuration was not included in the request and was not found in this repository. No exact threshold, role exemption, domain list, channel mapping or punishment ladder is attributed to it. The matrix below identifies what must be mapped once the reference is available. Existing `/filter` behavior remains unchanged.

## Preserve and extend

Reuse `matchesTerm`, existing authenticated bot/service transport, runtime moderator authorization, and guild-scoped audit conventions. Keep moderation independent of inference, provider availability, AI tester admission, MPoTD and practice. Never use a model's proposed action as execution authorization. Do not import screenshot word lists or infer that educational terminology is abusive.

Proposed modules:

| Module | Responsibility | Interface |
| --- | --- | --- |
| `moderation/events` | Normalize Discord create/edit/delete/member events | Immutable event ID, guild/channel/actor IDs, bounded message facts |
| `moderation/policy` | Validate versioned per-guild policies and exemptions | `evaluatePolicy(event, config)`; pure deterministic decisions |
| `moderation/detectors/*` | Independent phrase, repeated-message, mention-burst, invite/link and attachment rules | Findings with rule ID, matched evidence offsets, severity and reason |
| `moderation/engine` | Combine findings, apply exemptions, deduplicate and choose permitted action | One decision per message revision/policy version |
| `moderation/actions` | Recheck current Discord permissions/hierarchy; execute bounded actions | Action ID, target, preconditions, definitive/uncertain outcome |
| `moderation/cases` | Persist append-only cases and reversals | Guild-scoped case ID and actor/reason audit |
| `moderation/commands` | Inspect, dry-run, version, enable, disable and appeal/review | Ephemeral previews and authenticated changes |

Flow: event → current policy → exemption checks → enabled detectors → deterministic decision → dry-run or action reservation → fresh authorization → Discord action → durable outcome → redacted mod log. A message edit re-evaluates only its new revision. Repeated gateway events must not repeat sanctions.

## Configuration mapping awaiting the reference

| Proposed capability | Safe initial state | Reference information needed |
| --- | --- | --- |
| Whole words/phrases | Existing explicit rules only | Terms, contextual exceptions, flag/delete choice |
| Spam/repetition | Disabled; shadow findings only when enabled for evaluation | Window, minimum count, repetition similarity and exempt channels |
| Mention bursts | Disabled | User/role mention counts, everyone/here handling, exemptions |
| Invites and links | Disabled | Allowed guild invites/domains, channels, redirection policy |
| Attachments | Disabled | Explicit types/size rules and educational upload exceptions |
| Escalation ladder | No automatic timeout/kick/ban | Action sequence, decay/window, appeal and reset rules |
| Mod logs | Existing configured log channel | Case channel, visibility, retention, redaction preferences |
| Role/channel bypasses | Preserve current Manage Messages bypass until separately reviewed | Exact role/channel IDs and whether exemption is per detector or global |

Each detector has `enabled`, `mode` (shadow/enforce), scope and validated bounded thresholds. Policy changes create a new immutable version with actor, reason and a diff. Precedence is explicit: protected targets and unavailable authorization stop punitive actions; configured scope/exemptions precede detectors; the engine chooses at most one sanction and one case per event. Multiple detectors may contribute evidence without multiplying punishment.

Use NFKC/case normalization consistently with the current filter, whole-word Unicode boundaries and literal phrase escaping. Do not accept arbitrary administrator regex until runtime limits and complexity validation exist. Link matching must parse URLs and compare normalized hosts, not use substring allowlists. No URL fetching is required for basic link moderation. Limit per-guild/user windows in memory and persist only evidence needed for enabled escalation policies.

## Permissions and delivery failures

Recheck guild, target membership, invoker authority, bot permissions and role hierarchy immediately before an action. Never act on the guild owner, self or an unmanageable member. Validate duration/action bounds in the executor, not only command UI. A detector failure yields a logged diagnostic, not a punishment. Configuration/service outages must not freeze educational discussion.

Deletion and timeout are separate actions with separate outcomes. Record intent before dispatch. A definitive denial records failure; an ambiguous network result becomes uncertain and needs reconciliation before any non-idempotent escalation. A failed mod-log send must not repeat the sanction. Case messages use `allowedMentions: {parse: []}` and exclude raw private message content by default. Review evidence should be available only to authorized moderators, with a documented retention limit. Removal/appeal appends a reversal rather than erasing the original case.

## Future additive storage and rollout

Use a separate moderation schema ledger and tables for policy versions, cases, action attempts, case events and retention metadata. Existing study `rules`/`audit` tables remain intact. An explicit bridge can read legacy phrase rules; do not copy them into a second live enforcement path. Unique `(guild,event,revision,policy,action)` keys prevent duplicate actions. No SQL migration is delivered or applied in this design phase.

Implement modules behind disabled flags after the reference mapping is reviewed. Test detector boundaries, educational false positives, Unicode, burst windows, cross-guild isolation, permission/hierarchy changes, duplicate events, edit races, bot restarts, uncertain actions, retention and appeals using isolated databases and mocked Discord. Run shadow mode in an authorized test guild before enabling one detector at a time. No kick/ban/timeout defaults, command registration or production rollout are authorized by this document.
