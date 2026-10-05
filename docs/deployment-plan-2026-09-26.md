# Review and manual deployment plan

This document is a plan, not an execution record. No push, production database access, command registration, PM2 restart or deployment was performed.

Completed local validation: 285/285 Bun tests across 27 files, 4/4 Python tests, typecheck, build and scoped diff checks passed. Protected training files and both tracked service backups matched their original SHA-256 hashes after validation.

## Changes to review

See the dated audit, cognitive-routing contract, and moderation design. Review the small commits on `codex/audit-aleph-development`. Training/aleph files and existing backups are intentionally uncommitted and must not be staged into these commits.

No dependencies or slash definitions changed. No command registration is needed for these fixes. No new database migration is introduced. Existing additive QOTD v2→v3, practice schema v1 and study-job column compatibility remain unchanged. Daily scoring uses the session snapshot; never rewrite historic snapshots or score contexts. Moderation remains a design, not an enabled system.

## Validation before an authorized rollout

1. Use pinned Bun 1.4.2 and the existing Python environment. Run full tests, typecheck, build, Python tests and diff checks. This suite uses synthetic/temporary databases and mocked Discord/providers.
2. Review the exact commit range and test results. Confirm hashes of protected datasets/backups still match the audit baseline.
3. With separate authorization, prepare a consistent backup of production SQLite and its full asset directory. Test existing additive migrations on a staging copy; compare schema versions and historical sessions, submissions, score contexts, delivery payloads, used-question ledger and practice events before/after. Never reset or re-import to bypass an incompatible schema.
4. In an authorized test guild, verify first-correct/replacement behavior, private practice recovery, corrupt/missing solution fallback, search permissions for private threads and revoked access, requester/creator attribution, and multi-passage citations. Live Discord permission tests remain outstanding.
5. Keep cognitive routing disabled initially. To test it, configure external endpoint/model/key privately in staging, verify local Phi JSON and external tool mode separately, then test proof/ambiguous/image routes, outage/refusal, retrieval grounding and Aleph personality with real models. Mock tests do not establish model quality or provider compatibility.
6. Present staging evidence and obtain production authorization. Then select the reviewed exact SHA and follow the existing `/opt/math-bot` PM2 procedure as the mathbot account. Do not run the future `/srv` systemd deployment script for this existing installation. Schedule outside the active daily reveal window and avoid overlapping bot processes.
7. Observe startup, queue, image fallback and delivery logs. Reconcile uncertain sends before retrying. Roll back to the pre-change binary/config if needed; this continuation introduces no schema change. Do not downgrade past the practice-bank separation implementation or change persistent DB/asset paths.

The NTTS/Sapphire reference and moderation-policy approval are separate from deploying these bug fixes. New moderation enforcement requires its own implementation, tests and rollout review.
