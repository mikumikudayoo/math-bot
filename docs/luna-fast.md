# luna fast mode and the competition-screening release

## command and deployment

`/luna-fast mode:enable` enables fast processing on new gpt-6-luna api attempts. use `mode:disable` to select standard and `mode:status` to read the stored setting. discord replies privately. the setting starts disabled on a new database. each attempt snapshots the setting before reserving its budget. continuations and retries can pick up a change while an outstanding call keeps its existing tier and reservation.

the discord handler checks the authenticated user id `821682594830614578`. the service requires its ordinary bearer credential plus a separate capability dedicated to this endpoint. the body supplies the mode. claimed identities and roles confer no authority. for an authorized rollout, set the same distinct, randomly generated `AI_LUNA_FAST_TOKEN` of at least 32 characters in the bot and ai service environment files. absent capability makes the command unavailable while inference can continue. the ai database persists the setting across restarts.

the tier is selected centrally for all calls in the luna role using gpt-6-luna. this includes routing, screening, repair, fallback review, inspections, and orchestration subcalls. terra and sol explicitly request `default`. the control is unavailable with a different model in the luna role.

## metering

openai documents luna fast at 2× applicable standard rates. short-context input, cached input, 30-minute cache writes and output cost $0.10/$0.01/$0.125/$0.50 per million tokens at standard and $0.20/$0.02/$0.25/$1.00 at fast. the ledger accounts for cache retention and long context. reasoning counts within output. each reservation uses the selected tier and the existing conservative estimate before dispatch. the receipt records requested and reported tiers separately. a reported downgrade settles at standard rates. missing or unrecognized tier information keeps the reservation. rate-limited attempts follow the existing bounded retry policy.

- [gpt-6 luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [fast mode and downgrades](https://developers.openai.com/api/docs/guides/fast-mode)
- [openai pricing](https://developers.openai.com/api/docs/pricing)

## calendar incident

for production job `1572501472740909117`, the first semantic screen passed and luna ran the calculator. the calculator completed, then another semantic screen returned `classifier_exact` before luna made a second orchestration call. the database event timing and deployed call path place the refusal on the calculator result.

the revised classifier receives the original request alongside derived content and must identify a specific mathematical correspondence before confirming a match. it still checks derived content for protected information. lexical checks, reference authorization, verdict decisions and fail-closed behavior are preserved. logs distinguish context, tool arguments, tool results, reviews and final screens without leaking contents. the calendar regression uses an injected provider, so live recognition on the revised prompt remains unverified.

## rollout and rollback

after authorization, use the existing isolated release process, back up sqlite, configure the shared capability, and register the updated application commands. verify ownership and one standard and one fast receipt under an explicit live-test spending limit. check a specialist receipt stays standard and rerun the calendar question plus an embargo control in the controlled channel. turn fast off with `/luna-fast mode:disable`. for a code rollback, restore the prior bot and ai release and command registration. the additive setting table and ledger columns can stay in sqlite.

## verification

the isolated checkout starts from the verified github development tip `d781303`, which contains the vps revision `8fbcd96`. linux under wsl, bun 1.4.2 and the frozen lockfile produced 1,197 passing baseline tests and 1,204 passing candidate tests, with zero failures in both runs. 108 focused tests, both typescript checks, the build, and all four python worker tests passed. the vps was inspected read-only. no paid inference, live discord command registration or rollout was performed.
