# Future router classifier experiment — separate from Aleph personality

The current route path is `fast-router` → clause extraction → loopback semantic
sensor → signal aggregation → fuzzy decisions → floors/constraints. Discord
intents and host tool/evidence enforcement also act outside the model.

Inspected scripts include `train-router.py`, `augment-router-gold-v2.py`,
`eval-minilm-router-holdout.py`, `eval-router.ts`, and the committed
`tests/fixtures/router-holdout-v2.jsonl`. The actual ignored
`data/router-gold-v2.jsonl` **is absent from this checkout**, as are the ignored
v1 holdout files referenced by older evaluation defaults. Do not claim a dataset
content review or new benchmark score. Recover the approved version plus hash
and provenance before an experiment; don't substitute personality examples.

The existing augmentation script expects `router-gold-expanded.jsonl` and emits
six continuous targets: reasoning, freshness, externalKnowledge, ambiguity,
verificationNeed, calculation. The old trainer reads `router-gold.jsonl`, embeds
with MiniLM and trains Ridge using a random split. The holdout script uses v2
gold, v1 holdout and a KNN signal predictor. These differing paths and split
assumptions must be reconciled explicitly before future training. The committed
v2 fixture instead expresses acceptable categorical reasoning/knowledge/tool
decisions; it is an end-to-end policy regression set, not training targets.

Proposed experiment, not implemented or executed:

1. Recover/version the approved gold data; audit labels, consent, semantic
   duplicates and overlap with every evaluation fixture. Freeze holdouts.
2. Group gold by semantic situation before creating training/development folds.
   Compare a small linear/Ridge head on frozen embeddings with the existing
   baseline; optionally compare a lightweight multi-output classifier with
   calibrated scores. Select hyperparameters using development folds only.
3. Measure per-signal error/calibration and end-to-end policy decisions, especially
   false negatives for mandatory retrieval, false web use on no-web requests,
   ambiguity, niche/exact-name facts, math and casual messages. Measure ARM CPU
   latency, memory and cold-start behavior on the intended hardware later.
4. Run existing holdout once after model selection; report per-category outcomes
   and the frozen data/model hashes. Treat previously examined regression cases
   as regressions, not as a fresh unbiased benchmark. Add a separately authored
   blind set before making quality claims.
5. Review any host integration separately; retain a rollback baseline. No router
   replacement, model training or benchmark against a live sensor happened here.

The trained component supplies **signals only**. TypeScript remains final
authority for explicit no-web constraints, required verification, tool
availability, bounded evidence, trusted identity, allowlists and security. SFT
personality data must never be mixed into router gold or holdout.
