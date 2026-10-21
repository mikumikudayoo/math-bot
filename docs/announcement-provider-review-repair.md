# Announcement rejection and moderator notification repair

## Verified findings (2026-10-21)

Production and the PR base were `ce2e61e330762797fbe02df3924476ebc736bb00` on `feature/announcement-automation`. Read-only inspection confirmed Gmail healthy, future-only bootstrap, auto-send enabled, zero policies, zero delivery jobs, two extracted sources and two blocked sources. Five staff alerts were recorded as sent. No production configuration, source disposition, cursor, credentials, process, or deployment was changed by this repair.

The October 19 HTTP 400 was recorded as a configuration error because the shared provider adapter discarded every error body and labeled all non-transient failures `misconfigured`. The exact historical cause cannot be recovered from the retained failure record or automation logs. A live request using the existing `openai/gpt-oss-120b`, existing credential, and exact extraction schema returned HTTP 200 with synthetic input. This establishes current request acceptance only; it does not establish organizer extraction correctness or justify changing credentials. Persisted health remains the worker's last observation, not a continuously refreshed credential test.

The October 21 mixed supported/unsupported warning is the intended mathematics-only safety boundary, not a reason to widen sender or subject scope. Mixed mail stays blocked for explicit factual separation. Unsupported-only mail remains ignored. Zero policies means nothing can be scheduled even with auto-send enabled.

Staff messages previously used `allowedMentions: { parse: [] }` with no role text or role allowlist. They could post but could not notify a moderator role. Production had no separate staff notification role configured.

## Changes

- Bound provider error inspection to 16 KiB and retain only fixed categories. JSON/tool output validation failures, other request rejections, and authentication/permission failures are distinct. Raw error text, failed generations, and secrets never enter alerts or logs. HTTP 400 now records `request-rejected` health rather than claiming bad credentials. Rejected sources remain blocked; no fallback, automatic replay, or approval occurs.
- Reject mixed/unidentified scope before provider calls even through the direct extraction API. Preserve supported correction proposals and their existing manual-review barriers.
- Add optional `staffRole` to the policy JSON. It must be a valid non-everyone role paired with `staffChannel`. Fetch the role and recheck configuration and private-channel permissions before claiming the alert. Only that role can be mentioned; user/everyone/here mentions remain disabled. Preflight failures leave alerts pending; ambiguous sends remain uncertain and are not resent.
- Explain zero policies and moderator-ping configuration in `/announce status`.
- Add a synthetic API/schema diagnostic that never opens announcement storage, reads Gmail, posts to Discord, or updates durable health.

## Verification and release steps

Local verification completed with Bun 1.4.2 and the repository Python environment: 835 Bun tests passed, four Python tests passed, TypeScript check/build passed, and `git diff --check` passed. Initial test runs exposed missing Python dependencies and a correction-path regression; both were resolved before the final full run. Discord role/notification tests use a fake transport, not live Discord sends.

1. Use Bun 1.4.2 and the repository Python environment (Pillow/SymPy). Run `bun install --frozen-lockfile`, `bun run check`, `bun run build`, and `bun test`. Tests cover HTTP rejection categories/redaction, durable source blocks, mixed-scope suppression, configured/default/changed staff routing, permission failures, and uncertain-send deduplication.
2. With the private automation environment present, run `BOT_ENV=production bun src/scripts/announcement-provider-check.ts`. This sends only synthetic data to the configured Groq endpoint. A success does not clear old blocked sources or update stored health. Groq documents strict model/schema support at https://console.groq.com/docs/structured-outputs .
3. No credential rotation is currently indicated. If the diagnostic later reports authentication/permission rejection, privately verify the automation-specific `GROQ_API_KEY` and project/model access. For request rejection, verify `EXTERNAL_INFERENCE_MODEL` and strict schema support; do not disable host validation or silently downgrade models.
4. After approval, configure `staffRole` with the actual moderator role ID in the private policy file. Do not reuse the public competition role automatically. Verify the staff channel remains private, moderators can view it, and the bot can view/send there. The role must be mentionable or the bot must have the applicable MentionEveryone permission. Omitting/null `staffRole` preserves unpinged private alerts. Actual Discord notification behavior has not been exercised by this repair.
5. Configure reviewed public destination, competition role, event types, and lead times only with explicit approval. Do not invent policies from the zero-policy status. Back up and validate storage before any approved release; follow the existing rollout gates. Merge/deployment/restart are separate approval steps.
6. Review the two blocked sources in `/announce inbox kind:sources`. Inspect redacted evidence via `/announce source`. For mixed mail, explicitly separate and verify only supported mathematics facts; use the existing reviewed JSON import/candidate approval workflow if needed. For the HTTP 400 source, inspect evidence and manually propose verified facts. Do not delete records, reset Gmail bootstrap, bulk-retry old mail, or dismiss a source merely to clear the warning. Release holds only through an audited moderator decision; major messages still need exact message/media approval.

No live Discord post/mention test, real-mail re-extraction, deployment, merge, credential change, policy change, or historical replay is part of this PR.
