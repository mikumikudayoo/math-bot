# aleph-zero v2 production release checkpoint

november 16, 2026, manila. **production hold.** the release candidate was recovered, updated and tested offline. this session did not reach the oracle vps or change its checkout, databases, secrets, providers, pm2 processes, discord commands or running services. no paid api call or discord message was sent. no branch was pushed.

## exact release candidate

| item | verified value |
| --- | --- |
| tested and proposed deployment source | `2a13387e5f55262966beb8e13a81d7cbb1408dec` |
| tested source tree | `1b916401bc133ce3e6d3c29a8708367ba1c2d625` |
| prior tested implementation | `cf01f4a4f3ebaa9ad0cc9fcd8b2eb76ff179464f`, tree `715961e353d76301b268b4b7520ff61e790cba7e` |
| incoming bundle head | `7c3a7694e4aab10827cd46b7934d9407caeb5dec`, tree `3fe08ff7c747d81ea1f6678a82b5a1db5584be76` |
| incoming bundle sha-256 | `54fbcb257649721c6df22d8997e54baf56177297ccdc0a35e01875fc6f366d5b` |
| github production-lineage branch | `feature/announcement-automation` returned `ce2e61e330762797fbe02df3924476ebc736bb00` via an authenticated read |
| verified github remote | `https://github.com/mikumikudayoo/math-bot.git` |
| running production revision, provider and pm2 status | unknown; no authenticated vps connection |
| deployed release sha | none from this assignment |

the incoming complete-history bundle passed `git bundle verify` and an independent clean clone passed `git fsck --full --strict`. the history runs from `ce2e61e` through `b64b84c`, `cf01f4a` and `7c3a769`. only `docs/aleph-v2-implementation.md` changed between the last two. all 307 original feature working files matched the packaged git tree including additions, even though the original branch pointer remains at `b64b84c`. the original worktree and original bundle were left in place. the earlier main branch and its untracked cancellation documents were not used for deployment.

the release working checkout was created independently of the original index. after a file write was denied in the initial workspace clone, work continued in a clean writable temp clone of the verified bundle. the candidate was committed, bundled again and imported into another clean checkout for the full comparison. the durable handoff includes the full-history bundle, a fresh checkout, its sha-256 sidecar, the verification archive and a manifest. the manifest records the tip containing this report and the tested source commit independently. the tip adds only this report to the tested code.

## release changes

| commit | change and verification |
| --- | --- |
| `0f9c08e` | two delivery regressions cover withdrawal of a previously visible preview when publication authorization times out, recovery before final delivery, and separate audience checks for concurrent requesters when one loses permission. |
| `21ba47e` | the four exact director-supplied verity mappings are included in the trusted luna orchestration prompt. formatting instructions preserve the exact supplied text. minor introductory, case, contraction and punctuation variations are accepted; unrelated, quoted and mixed requests receive normal treatment. no host interception or substitution was added. |
| `2a13387` | pins the provider sdk to the official api origin even if the process inherits a different base url. adds a synthetic release acceptance command with an isolated sqlite ledger, a durable aggregate spending limit, and tests. |

the verity suite exercises four canonical questions, four variants and four controls (mexico, a cat, a mixed-country request and a translation). a thirteenth test returns a different model response to a matching question and verifies that the host passes it through. the actual runner and discord formatter preserve the four exact returned strings. these checks used injected replies. recognition and exact output from real luna are pending. existing identity, character and permission tests also ran.

## verification in this session

| test or check | result |
| --- | --- |
| windows node 24.18.1, original handoff `b64b84c` | saved verified comparison: 749 cases, 726 pass, 23 fail |
| same runner, previous tested v2 `cf01f4a` | saved verified comparison: 851 cases, 828 pass, 23 fail |
| same runner, fresh release import `2a13387` | **870 cases, 847 pass, 23 fail**. 19 new passing tests vs `cf01f4a`, 121 vs `b64b84c`. zero missing tests, new failures, skips or cancellations. the identities and observed error categories of all 23 match both earlier sources. |
| focused release coverage | **146/146 pass** across orchestration, specialist authorization/fidelity, repeated/parallel tools, cancellation, recovery, budgets, concurrent work, discord context, creator and moderator boundaries, competition protection, images, formatting, progress, verity, seven-agent and announcement paths |
| native windows bun-only subset | **87/87 pass** using bun 1.3.14 |
| controlled discord scenarios | **90/90 pass** after adding the two delivery regressions. synthetic discord transport/identities, actual application paths and sqlite, including one real loopback service integration. the full twelve-scenario matrix is in the verification archive. |
| source and v2-test typescript checks | both passed with the installed project compiler |
| build and emitted cli | the windows package wrapper could not run the linux-style `tsc` shim. invoking the same compiler directly with windows bun emitted **144 javascript files**. the compiled math evaluation cli completed a dry run. |
| windows python diagnostic | failed during discovery at `import resource`; this is a unix worker. windows python 3.14 also lacked sympy, pillow, matplotlib and numpy. no linux python result is inferred. |

the 23 shared failures include 14 missing bun-global errors under node, three windows cleanup permission errors, three sql-worker result assertions, one spawned node typescript module resolution error, one calculator worker assertion, and one vision fixture startup failure. test names, categories and full tap output are in the verification archive. the earlier handoff's linux result was historical and does not qualify this release.

## linux, model, discord and vps gates

| gate | result and observed reason |
| --- | --- |
| pinned linux bun 1.4.2 and isolated python | wsl 2.7.10 was present with kernel 6.18.33.2, but the session saw zero registered distributions. both default execution and system-distro execution failed. no usable docker, podman, qemu, virtualbox, vmware, hyper-v cli or managed linux shell was found. host compute enumeration lacked permission, codespaces access failed, and distro/package downloads could not connect. the separate js runtime also identified itself as windows. the cached linux executable and venv cannot run directly here. none of the six required commands ran under linux. |
| paid luna, terra and sol, function calling and metering | the release cli and the compiled cli both exited at credential preflight. the authorized key was absent in the inherited environment and project settings. the smoke created no paid ledger or model request. actual spend **$0**. |
| offline acceptance of the paid-test harness | a 22-call injected-client run passed all 12 verity fixtures, a character check, three model checks, a real orchestration flow with two mocked specialists and correct numeric synthesis, and both announcement schemas. synthetic receipts totalled $0.002076; the conservative authorization counter reached $0.160627 of $0.25. neither amount was billed. a paraphrased answer failed the check. reopening an exhausted test ledger allowed zero further calls. |
| live discord | the development guild and credential were configured. read-only requests for bot and guild identity returned local `EACCES` before any http response. no gateway session, real rate limit, actual staging role change, channel write, or live image attachment was verified. the offline acceptance matrix used synthetic data throughout. |
| oracle preflight | windows `ssh -G oracle-vps` left the literal alias as its hostname. noninteractive `ssh oracle-vps hostname` exited 255 during resolution. a strict-host-key, batch-mode probe of the endpoint recorded in the handoff was denied before authentication. no key material was generated, changed or displayed. |
| live databases, backups, service health, release and push | vps sha, clean status, disk, backup integrity, process owner/status, production secret presence and provider configuration were not observed. no release was uploaded, activated or rolled back. pushing the feature branch remains after final validation. the production branch was not written. |

## resume from the saved release

1. use `aleph-zero-v2-verity-release.bundle` in the handoff directory or its `checkout` clone. check the sha-256 sidecar and run `git bundle verify`, `git fsck --full --strict`, and `git diff --name-only 2a13387 HEAD`. the only difference at the packaged documentation tip is this file. in a fresh clone from a bundle, git initially points its origin at the bundle. verify the github target before configuring it. preserve existing operator checkouts.
2. run the following in an isolated **linux** checkout of `2a13387` with pinned bun **1.4.2**, dummy test settings, and independent test databases. for unexpected failures, repeat the affected tests against the prior v2 and handoff revisions on the same linux host; fix regressions and retest any changed revision.

```sh
bun --version
bun install --frozen-lockfile
bash scripts/setup-python.sh
. .venv/bin/activate
bun run check
bun run check:v2-tests
bun test
python3 -m unittest discover -s python
bun run build
```

3. from the release root, use the existing authorized key in the environment and a single **dedicated, persistent staging sqlite file**. the parent directory must exist. run the following command once and inspect its exit status, stage results and receipts. all model, specialist and synthetic announcement calls in this command share the lifetime $0.25 authorization. leave its ledger intact across failures, crashes and retries. a database belonging to another service is rejected. each attempt consumes conservative authorization before calling the provider, including uncertain outcomes. the cap is enforced using configured prices and estimated upper allowances. the actual provider invoice remains authoritative.

```sh
bun src/scripts/release-acceptance.ts --confirm --ledger /absolute/staging/path/aleph-v2-release-smoke.sqlite
```

4. use a controlled tester channel with synthetic messages. verify the actual gateway, safe streaming, cancellation, split replies, per-user access, mid-request permission loss, real delivery and image publication. retain the director's $0.25 aggregate test allowance across any additional paid checks; allocate only remaining headroom and enforce it before dispatch. the standalone model and announcement smoke scripts are already exercised by the combined command. a failed stage should be investigated before spending more. keep announcement posting staff-controlled.
5. only after validation, verify the exact feature destination and push `feature/aleph-zero-v2` by name without force. through the existing deployment account, inspect the actual `/opt/math-bot` revision, cleanliness, disk, ownership, pm2 processes and current modes. check that the live lineage includes reviewed changes and preserve intervening commits. save the prior revision, build, dependency versions, owner-only configuration, assets and consistent sqlite backups. verify backup integrity and capture queue and approval state. keep credentials out of logs and staging data out of production.
6. follow the existing pm2 procedure in `docs/openai.md`. initially keep access limited to testers. activate study inference after the model checks and verify the deployed source sha, startup, health, luna-low, specialist access, accounting, discord publication, rate limits, cancellations and queue progress. restart only the necessary ai and bot processes. migrate and restart automation separately after schema compatibility, staff approval and worker health checks pass.
7. halt rollout on a disclosure, embargo breach, queue or approval corruption, unexpected spending, repeated failed delivery, or unstable service health. restore the affected provider mode and restart only the affected service. for an application rollback, restore the recorded previous revision, build, dependencies and configuration. retain current queue, competition and usage data; any database restore must account for writes since the backup. record actual post-rollback sha, health and queue state.

the windows verification evidence is reusable. the outstanding deployment work requires a linux staging runner, authorized model credentials, staging discord connectivity and the established ssh environment. both machines were left running.
