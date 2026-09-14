# QOTD: original PDF question crops

QOTDs now post the original rendered question, not reconstructed text. Students see an optional configured role mention, **New QOTD of the Day!**, *Submit your answer below!*, ordered PNG crops, and a letter-only native Discord poll only when source choices exist. Extracted question text, official answer/solution, choices and metadata stay internal for fingerprints and review. Original source PDFs are never modified or uploaded by import/review.

## Local WSL commands

```sh
cd /mnt/d/devstuff/math-bot
export PATH="$PWD/.cache/bun/bin:$PATH"  # only needed if your pinned Bun is not already on PATH
bun install --frozen-lockfile
bun run import:solmans ./solmans
bun run qotd:review-ui
```

Open **http://127.0.0.1:8790**. The existing review UI has been adapted, using the same SQLite review state and audit log. It binds only to `127.0.0.1`; there is no public-host switch. Set `QOTD_REVIEW_PORT` if the port is occupied. Do not expose or tunnel this server. It checks Host/Origin and requires a per-session token for mutations.

The UI shows the exact student images in page order alongside extracted text, source choices, official answer and solution, metadata, flags, all source occurrences/conflicts and an original-PDF viewer. Switch source occurrences to inspect duplicates. Check both review boxes only after verifying the source and **every crop's completeness and absence of neighboring questions, answers or solutions**. Then approve. Keyboard A/R/S still works, but A cannot bypass the checkboxes. Nothing is automatically approved.

For failed or incomplete crops, upload 1–10 question-only PNG/JPEG files in page order (use numbered filenames). Uploading replacements revokes approval and records their content hashes in the audit log. Inspect the new previews, check both boxes, and approve again. Replacement files are decoded and saved as immutable hashed PNG assets; source text and official fields do not change.

Equivalent CLI:

```sh
bun run qotd:review list
bun run qotd:review show QUESTION_ID
bun run qotd:review replace QUESTION_ID --image ./01.png --image ./02.png
bun run qotd:review approve QUESTION_ID --ack-source-review --ack-crop-review
bun run qotd:review reject QUESTION_ID
```

`show` includes image paths, source pages and all imported occurrences. Failed crops, missing official fields and unreadable choices block approval. Approving a crop that later changes on disk is not sufficient: hashes and sizes are verified again before reservation/posting. The bot does not silently fall back to extracted question text.

## Development reset: intentionally discard the old QOTD bank

The old generated local database was **not migrated**. The crop implementation uses a fresh schema and refuses an old bank with a clear reset message. The explicitly requested development reset discards **all old QOTD approvals, review state, scheduling, posting/used history and audit entries**. Re-import produces pending questions; stable content fingerprints continue to deduplicate new imports, but discarded historical usage cannot be recovered.

Default identified path: `D:\devstuff\math-bot\data\qotd.sqlite`, or `/mnt/d/devstuff/math-bot/data/qotd.sqlite` in WSL. The separate AI database `data/development.sqlite` is untouched. Stop local QOTD review/bot processes first if they hold the database. The reset checks for open Linux file handles, rejects production mode, rejects symlinked/nonlocal databases and validates that all tables belong to QOTD before unlinking only that SQLite file and its WAL/SHM companions.

**Do not run this routinely. It destroys the local QOTD state.** To explicitly regenerate development data again:

```sh
BOT_ENV=development bun run qotd:reset-local --discard-qotd-state
bun run import:solmans ./solmans
```

No production migration, deployment, command registration or remote state change is performed. Reset never removes or changes `solmans/`, source PDFs or unrelated databases. Retained old private source assets remain under ignored `data/`; they are not an approval/history backup.

## Import and crop behavior

The recursive importer scans `.pdf` files, skips symlinks, preserves original filenames/paths, derives identity from PDF bytes/content and detects supported PHIMO FRR 2026 and VTAMPS 24 / 25 / v25.0 layouts. Each source retains metadata, raw page text and every question's own official answer/solution. Questions retain numbers, sections, source choice labels/order, physical **1-based PDF page references**, raw extracted blocks and crop geometry.

The parser identifies the separate question listing before the worked solutions. PDF.js text-block geometry locates question boundaries, next questions, headings and footers. Rendering uses the original page at 3x scale (216 DPI) through PDF.js and `@napi-rs/canvas`, including vectors, images, diagrams and mathematical notation. Pixel bounds trim blank space **inside** the hard exclusions and reject cuts that cross visible ink. Multi-page questions become multiple ordered images. No OCR, mathematical rewriting, choice invention or AI correction occurs.

Crops are not generated from worked-solution listings. Unknown/rotated layouts, ambiguous numbered content, mismatched anchors, answer markers, empty regions, ink crossing a boundary, oversized images or unsupported pages fail closed and remain reviewable. A failed question stays in the bank with its source and official fields, but cannot be approved until replacement images are provided. Minor page rules/whitespace may remain; reviewers can replace these if desired. Automatic geometry cannot prove semantic ownership of every graphic, which is why human completeness/answer-leak review is mandatory even for successfully generated crops.

Local assets: `data/qotd-assets/<source-hash>/source.pdf`, `pages.json`, `review.json` and `crops/*.png`; replacements are in `data/qotd-assets/overrides/`. Paths resolve shared-data symlinks to their persistent target. `data/`, `.cache/`, `solmans/` and database sidecars remain ignored. Do not commit generated assets or source PDFs. Tests use original synthetic PDFs, including vector drawings, generated temporarily at runtime.

The summary distinguishes source-occurrence counts (`mcq`, `open`, `crops`, `cropFailures`) from deduplicated bank counts (`bankMcq`, `bankOpen`, `bankCrops`, `bankCropFailures`, `pending`). Three copied PDFs may be skipped without incrementing question duplicate counts. Repeat imports add only new material and preserve review/used history. Near matches are flagged using token Jaccard similarity, and conflicting official fields revoke approval rather than silently overwriting the first imported official fields. Review all source occurrences before accepting a corrected/near-duplicate question.

## Start and test the development bot immediately

After at least one crop is approved, in a second WSL terminal:

```sh
cd /mnt/d/devstuff/math-bot
export PATH="$PWD/.cache/bun/bin:$PATH"
bun run commands:deploy:dev   # manual development registration for updated QOTD options
bun run dev
```

Then in the configured development server/channel:

```text
/qotd post
/qotd history
```

`/qotd post` uses the **same posting function and reservation transaction** as the scheduler; it does not wait for the scheduled hour. It is restricted to Manage Server users and consumes today's UTC slot and that question's used state. It deliberately does not bypass no-repeat or today's slot for repeated testing. The review UI provides unlimited local previews without consuming questions or sending messages. No Discord post or registration is performed by tests.

To enable scheduled posting and optionally set the role mention:

```text
/qotd schedule channel:#math hour:0 role:@QOTD
/qotd disable
```

Hours are UTC; 00:00 UTC is 08:00 Manila. Alternatively set `QOTD_ROLE_ID` in `.env.development` for immediate posts without creating a schedule. No role is mentioned unless configured. Only that role is allowed through Discord's allowed-mentions filter. Make the role mentionable or grant the bot the required mention permission. The bot also needs View Channel, Send Messages, Attach Files and Send Polls.

A separate manual reveal matches the answer-announcement part of the reference layout:

```text
/qotd history
/qotd reveal post-id:1
```

The post ID is shown in history. Reveals post the preserved official answer in the original channel, **only at least 24 hours after confirmed posting**, after the poll window. It never marks the correct option in the initial poll. A reveal is reserved/audited before sending and is never automatically repeated after ambiguous failure. There is no automatic reveal schedule or automatic discussion-thread creation. The full official solution remains available internally in review; solution crops are not part of the student question assets.

## No-repeat and persistence guarantees

No-repeat remains per guild across all its channels. Only approved, explicitly crop-reviewed questions are eligible. SQLite atomically reserves an unused question and `(guild, UTC-day)` slot before any Discord call. Used state survives restarts and ordinary re-imports. Send failure or a crash leaves the question consumed (`uncertain` or `reserved`); it is never automatically retried. Exhaustion never recycles old questions. `/qotd reset question:FULL_ID confirm:true` is the explicit audited moderator escape hatch; it permits that one question on a future day but preserves history and does not reopen today's slot.

Use one persistent database/assets location for importer, CLI, review UI and bot. All now resolve `QOTD_DB_PATH` and `QOTD_ASSET_DIR` consistently from the selected `.env.development` / `.env.production`, then process environment, then `data/` defaults. Use separate development and production data. A future authorized deployment must retain the database and assets, not perform a development reset. Existing shared-data deployment configuration remains intact. Keep asset paths consistent when moving machines.

## Dependencies and checks

Bun 1.4.2 is pinned by the repo. The existing `pdfjs-dist` handles extraction and rendering; its native canvas dependency is now explicitly declared as `@napi-rs/canvas` so rendering is available on the host platform, rather than depending on a transitive optional install. There is no UI framework, external OCR service or AI dependency. Source references: [PDF.js Node examples](https://github.com/mozilla/pdf.js/tree/master/examples/node) and [native canvas](https://github.com/Brooooooklyn/canvas).

```sh
bun run check
bun test
bun run build
```

Tests cover actual synthetic PDF rendering, vector-only diagrams, excluding neighboring questions/answers, multi-page choices, failure flags, no invented choices, crop acknowledgements and tamper checks, replacement revocation, exact/near duplicates, idempotence, no-repeat after reopening, immediate payload construction, reveal timing, local review access controls and development-only reset protection. Private AI access and unrelated moderation tests remain in the full suite.
