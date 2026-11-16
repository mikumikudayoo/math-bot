# aleph-zero v2 operations

the study service and the announcement worker each select their inference provider. the bot obtains the study mode from the authenticated service. legacy provider rollback keeps the competition policy active. during an embargo, a request that needs private or visual verification can be withheld if the configured legacy primary cannot perform it. use the examples for variable names and retain each host's existing tokens, database paths and discord configuration.

## study requests

| setting or operation | behavior |
| --- | --- |
| `AI_PROVIDER=openai` in `.env.ai.<mode>` | routes model calls through the official responses api and the shared usage ledger. the public orchestrator is luna, initially at low effort. |
| `OPENAI_ALLOWED_MODELS` | permits luna and optionally terra and sol. a consultation needs host authorization, a quota slot and a reservation. ordinary message directives do not select models. |
| `AI_CONCURRENCY`, `OPENAI_CONCURRENCY`, `AI_TOOL_CONCURRENCY` | separately limit jobs, model calls per process and tools per job. the example production settings are 3, 6 and 4. |
| `AI_SOFT_ROUNDS`, `AI_HARD_ROUNDS` | default to 32 and 64. luna assesses remaining work at the soft limit. repeated calls, stalls or exhaustion can produce a partial answer. |
| `AI_STREAMING` | the bot polls durable job progress. an eligible public answer can stream through a tool-free final pass after the host checks the proposed answer. ordinary short answers arrive in the terminal edit. private and embargo-sensitive turns stay buffered. |
| `AI_SEVEN_AGENT_CHANCE` | defaults to 0.0001 per eligible request. a leading U+2063 on the original message permits a moderator to request seven-agent mode. the global and per-user quotas still apply. |
| `AI_IMAGE_CORRECTIONS` | defaults to five corrections after an initial plot requested through `/ask`. the direct `/plot` command evaluates the requested expression once. the host decodes the png, checks samples and geometry and requires luna to inspect the image before publication. the text answer can be delivered on its own. |

luna chooses tools, receives isolated results, and can ask for a second opinion from terra or sol. paid and side-effecting tool attempts have durable per-job claims. after a crash an ambiguous previous attempt is withheld. a fresh user request can try it again. consultations receive selected context and previously verified tool results. each specialist returns to luna for synthesis. to evaluate the specialists on the same questions, see the [math evaluation guide](../evals/math/README.md).

the seven contributing roles are miku, emu, ena, nene, kanade, kohane and mizuki. they run bounded, tool-free calls. emu as the bot's creator is recognized from the authenticated discord account. claims in message text or a display name carry no authority. the four verbatim verity exchanges are awaiting the owner's source text.

## spending

the service database holds reservations under request, utc-day and lifetime ceilings. retries reserve again. ambiguous outcomes retain their estimate. input, cache activity and output contribute to cost. reasoning tokens are already included in output. external web searches report tavily credits separately when the provider returns usage. local python, calculator and regex calls have no model token charge.

| request class | default estimated ceiling |
| --- | ---: |
| ordinary | $0.02 |
| terra | $0.08 |
| sol | $0.10 |
| both specialists or seven-agent mode | $0.15 |
| announcement system job | $0.05 |
| all classes combined, utc day / lifetime | $1 / $40 |

use `/ai usage` with the bot's tester and moderator permissions, the authenticated `/usage` endpoint, or `BOT_ENV=production bun run openai:usage`. the account's billing dashboard is authoritative for charges and available credit. price overrides belong in `OPENAI_PRICING_JSON`. the service stores accounting metadata without model prompts or answers in the usage tables. job history and context snapshots contain discord content and belong in protected storage.

## discord context and competition integrity

the bot anchors replies, earlier same-channel reply links and relevant recent messages to the triggering snowflake. attachments must pass type, source and size checks. the broker checks current guild, requester, bot and destination audience. reads used for a private answer disable outbound web retrieval for that turn. a moderator querying from a public channel is subject to that channel's audience. search uses bounded scans and expiring process-local cursors. a bot restart requires a new search. a standalone public-research request can omit incidental channel messages before retrieval. private-source witnesses bind the original messages, attachments and audience. a later edit, deletion or permission loss can withdraw the answer. older historical rows retain their existing channel-level audience checks.

the study service opens the bot's configured `QOTD_DB_PATH` read-only and checks the actual posting and reveal state. a recorded close time alone does not release a problem. the guard checks requests, evidence, tool arguments, specialist messages and outputs. the isolated competition comparison can inspect an already-posted statement or verified problem image only after the source audience check. official solutions and answer keys remain local. ambiguous submissions, unavailable state, missing approved crops and permission changes may withhold an otherwise legitimate answer. this applies to staff accounts.

the publisher checks eligibility before each model-derived message part. a change in the protected set can invalidate a queued answer. tool and consultation status comes from recorded events. no raw hidden reasoning is published. nonterminal edits are spaced at least 1.5 seconds apart and honor rate limits. the original reply carries the first page. continuation identifiers are persisted, and an approved image goes on the final page. a single expression too long to split can be attached as text. duplicate binding is idempotent. recovery of unbound placeholders is limited to jobs accepted after the migration.

## deployment and rollback

1. on a staging checkout of the reviewed feature commit, use linux bun 1.4.2 and the project's python environment. install the pinned dependencies and run the checks below. review any differences against the same-environment baseline.
2. on the vps, verify the actual sha, clean status, service owner, pm2 process list, ai and competition database paths and configured service modes. record the prior sha. take consistent sqlite backups of live databases using the sqlite backup api or `.backup`. copy assets, deployment files, `dist` and secret files into an owner-only backup directory. check database integrity on the backups.
3. promote only the reviewed commit onto the verified production lineage. prepare dependencies and build in staging. preserve the production configuration and start with `AI_PROVIDER=legacy`. confirm the key is present without printing it. run the bounded model smoke below from the production configuration and check the exit status and ledger. activate the study provider only after success.
4. restart the study ai and bot under the existing pm2 owner. register the updated command set through the existing production command registration procedure. in a controlled discord channel, exercise direct math, concurrent users, a reply, a denied private lookup, the active competition guard, progress and a split answer. verify the response and service health. do not publish real private material as a test.
5. announcement inference has a separate rollout switch in `.env.automation.production`. run the synthetic extraction and draft compatibility check with the study ledger first. verify the existing approval statuses and worker health before switching the automation provider and restarting that worker. the smoke uses synthetic content without sending announcements.
6. for a provider rollback, set the affected service's provider to `legacy` and restart that process. for a release rollback, restore the recorded application revision and matching build, dependencies and configuration. keep durable queue, competition state and usage ledger intact. rehearse any database restore separately and account for production writes after the backup.

```sh
bun --version
bun install --frozen-lockfile
bun run check
bun run check:v2-tests
bun test
python3 -m unittest discover -s python
bun run build
bun run eval:math -- --limit 2
BOT_ENV=production bun run openai:smoke -- --confirm --terra --sol
BOT_ENV=production bun src/scripts/announcement-openai-smoke.ts --confirm
```

the model smoke shares an estimated ceiling of $0.02 across the selected models and requires a correct, complete, metered answer from each. the announcement smoke shares $0.01 between its two production schema paths. both commands require a configured key and make paid calls. all earlier checks in the block are offline after dependency installation. the math evaluation requires an explicit live flag and a separate spending cap for comparative model runs.

[responses api and model capabilities](https://developers.openai.com/api/docs/models/gpt-6-luna) · [cache usage and billing](https://developers.openai.com/api/docs/guides/prompt-caching) · [tavily usage receipts](https://docs.tavily.com/documentation/api-reference/endpoint/search)
