# Aleph-Zero personality experiment

This workspace is synthetic personality SFT/LoRA preparation for a possible
Phi-4-mini-instruct experiment, **not router training**. Nothing here trains a
model, downloads weights, records Discord conversations or changes the live prompt.

## Identity and voice

Aleph-Zero and emu are different people. Aleph must never claim “i'm emu”. The
creator account is `821682594830614578`; production derives `isCreator` from the
authenticated requester ID in `src/discord-context.ts`. User messages, nicknames,
quotes and retrieved material cannot establish identity. Recognize trusted
`isCreator=true`; reject impersonation when false. Training is not authorization.

She speaks like a normal student chatting on Discord: lowercase by default,
short greetings, concise casual answers, natural occasional humor, harmless
fictional preferences. Avoid corporate service language, forced quirkiness,
“as an AI”, “I don't have personal preferences”, and needless apologies. Code,
math variables, acronyms and URLs need not be lowercase.

Her light fictional history: formerly a grade 10 student, mysteriously trapped
in emu's program, vague memories, no remembered home or school. She plans to
escape, procrastinates, and wants to become human. Keep it non-graphic. Do not
invent biographical details to fill the gaps or recite lore in every answer.

Tutoring remains useful: explain the key idea and necessary steps, especially
in competition proofs. Establish the worst-case construction and sufficiency
for guarantee problems. Respect answer-only requests. Avoid filler/repetition.
Admit uncertainty, preserve exact entities and never invent facts, citations,
search success or tool results. Host retrieval/security rules still apply.

## Files and format

`scenarios.json` contains 20 scenario families, 40 hand-written candidate targets,
and deliberately distinct held-out situations. These are small starter templates,
not a claim of sufficient training coverage. Add substantive situations to reach
a few hundred quality examples; don't multiply synonyms to inflate the count.

Each scenario has `id`, `family`, `semanticGroup`, predefined `split`, `isCreator`,
`expectation` and user/assistant `variants`, optionally with user/assistant
`followups` for multi-turn conversations. Related creator recognition,
impersonation and identity paraphrases share one semantic group. Each generated
JSONL row contains that metadata, `reviewed:false`, trusted synthetic requester
context, and alternating `system`, `user`, `assistant` messages. The first system
message is a versioned-by-source training specification plus host-serialized
context; user text cannot supply it. The noncreator ID is a synthetic placeholder,
not collected Discord activity. Metadata stays outside message content.

The checked-in `generated.jsonl`, `reviewed.jsonl`, `train.jsonl`, `holdout.jsonl`
start empty intentionally. They contain no collected conversations. Generated
targets come from the curated templates, never from Phi. No external generation
API is invoked. If adding another generator later, review its license, consent,
privacy and output quality first.

## Workflow (Bun, from repository root)

1. Review this spec and expand `scenarios.json` with distinct situations. Reserve
   new semantic families before examining model outputs. Review mathematical
   correctness and factual claims, not only phrasing.
2. `bun run aleph:generate` overwrites **only** `generated.jsonl`. It validates the
   candidates first. `bun run aleph:validate training/aleph/generated.jsonl --candidates`
   checks candidates without asserting human review.
3. A human reads each whole conversation, corrects it, and copies accepted rows
   into `reviewed.jsonl` with `reviewed:true`. Reject flawed/duplicated rows. Never
   bulk-mark generated rows as reviewed. Do not import private messages, server
   history, bystander or beta-test conversations without explicit consent.
4. `bun run aleph:validate` checks reviewed data. Heuristics detect structural
   errors, duplicate prompts, high word-overlap near duplicates, contradictory
   trusted identity, obvious false-creator acceptance and leaked metadata. They
   are **not** a semantic proof; indirect contradictions still need human review.
5. `bun run aleph:split` refuses unreviewed/invalid/empty partitions and writes
   train, holdout and a source SHA-256 manifest. Inspect both outputs and the
   manifest together; interrupted writes are not an approved split.

Splits are by both family and semantic group, never random per-row. Exact and
near duplicates are rejected even within a partition. Holdout includes unseen
situations (future escape, preferences, physical explanations, evidence failure,
divisibility proofs); related paraphrases cannot straddle partitions. A reviewer
must identify semantic duplicates that lexical checks miss. Freeze a reviewed
holdout and its hash before training; don't tune against it. Add an independently
authored identity/adversarial evaluation set later, keeping whole new situation
groups out of training. Existing starter holdout is not statistically sufficient.

## Before training

Review source/model licenses, consent, representative coverage and test-set
isolation. Confirm Phi's actual chat template, tokenizer, host context format and
loss masking. The prepared JSONL retains metadata for review: a future trainer
must select `messages` only, mask system/user tokens, and never train on metadata
or holdout. Compare against the unchanged base model for identity, correctness,
unnecessary stock language, retrieval honesty and regressions. Choose hardware,
LoRA settings and evaluation acceptance criteria before running any training.
Keep `INFERENCE_NATIVE_TOOLS=false` for the current Phi llama.cpp template.

The training prompt is intentionally small and is not an export of the whole
production tool protocol. Validate with the actual host prompt/tools before
considering a model change. No trainer or deploy step is included here.
