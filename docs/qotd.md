# QOTD solution-manual bank

## Import locally in WSL (Bun only)

```sh
cd /mnt/d/devstuff/math-bot
bun install --frozen-lockfile
bun run import:solmans ./solmans
```

Windows `D:\devstuff\math-bot\solmans` is `/mnt/d/devstuff/math-bot/solmans` in WSL. Use the repository's Bun version (`.bun-version`, currently 1.4.2). If Bun is not on PATH, use `export PATH="$PWD/.cache/bun/bin:$PATH"` when that local runtime is installed. Do not use npm. The command recursively scans `.pdf` files, ignores symlinks, continues after individual failures, and reports new questions, duplicate files/questions, near matches, conflicts, and failures. A second run imports only new bytes/content and does not reset approval or posting history. Unsupported/scanned files are retained and reported as needing manual extraction; no questions are fabricated.

By default the database is `data/qotd.sqlite` and retained private source assets are `data/qotd-assets/`. For a different location:

```sh
QOTD_DB_PATH=/persistent/math-bot/qotd.sqlite \
QOTD_ASSET_DIR=/persistent/math-bot/qotd-assets \
bun run import:solmans ./solmans
```

CLI commands read these environment variables directly. The running bot reads `QOTD_DB_PATH` from its selected `.env.development` or `.env.production` first, then the process environment, then the default. **Point importer, review CLI and bot at the same database.** Use separate development and production databases. The importer itself does not connect to Discord or deploy anything.

## What gets stored

- SHA-256 source-byte identity, content-derived title, competition, edition/year where detectable, level and set; each encountered original file path (including filename) is retained separately. Generic filenames never determine identity.
- Stable question ID and unique normalized-content fingerprint, question number, topic/part, question text, source choice labels/text only when present, MCQ/open kind, official answer and solution, question/solution page spans and raw extracted question/solution blocks.
- Each source occurrence retains its own answer and solution even when its question already exists. Conflicting official text returns the canonical question to pending review; it never overwrites the first imported answer or solution.
- Original PDF, page text in `pages.json`, and a `review.json` manifest with source-page fallback references and flags, including diagram/layout concerns. Assets are private, ignored local data. No copyrighted PDFs or extracted source text are committed; tests create original synthetic PDFs.

Supported layouts are PHIMO FRR 2026 Secondary 3 (Part 1 MCQ / Part 2 open-ended), VTAMPS 2024 Secondary 3 topic sections, and VTAMPS 25 / v25.0 Senior Secondary topic sections. These sources list numbered questions first, then repeat them with `Answer:` and `Solution:` or `Solution.`. Cross-page choices and solutions are joined; recurring manual footers and recognized topic headings are excluded from content blocks. Page numbers are **1-based physical PDF pages**, not printed numbering. `solutionPage` identifies the start of the solution text; raw source occurrence and PDF retain the repeated prompt as well.

Official fields are direct slices of extracted text, including their whitespace and apparent mistakes. There is no AI call, mathematical correction, or invented choice generation. PDF extraction is not a faithful mathematical typesetting conversion: fractions, radicals, exponents, glyphs and diagrams can be damaged. The original PDF and extracted pages are the preservation fallback. All records require visual source review even when no damage heuristic fires. Metadata two-digit year expansion is a convenience; the original edition/title is retained for verification.

## Review and approve

Approval is a **local operator** action, so a moderator of an unrelated Discord server cannot approve content in the shared bank.

```sh
bun run qotd:review list
bun run qotd:review show QUESTION_ID
bun run qotd:review approve QUESTION_ID --ack-source-review
bun run qotd:review reject QUESTION_ID
```

`show` includes retained source paths and each occurrence's exact imported content. Open the source PDF at the listed pages. Verify pairing, complete question text, official fields and source choices. Inspect near-duplicate flags and reject a candidate if it would repeat an already represented question. Near matches use token Jaccard similarity (0.82 threshold), not mathematical equivalence. Identical text with different diagrams also needs human review. Approval records the operator and review acknowledgement in the audit table; missing official fields or unreadable MCQ choices block approval.

For diagram-heavy or damaged math, make a **question-only PNG/JPEG crop** from the retained PDF, including any required diagrams and notation, then approve with:

```sh
bun run qotd:review approve QUESTION_ID --ack-source-review --image ./question-only.png
```

The CLI copies the reviewed image into the retained asset directory (limit 8 MB). Check the crop contains the entire question and no answers/solutions or neighboring questions. Full source pages are never automatically sent, because they may reveal solutions or other questions. The original immutable extracted text remains available alongside the image. There is no automatic OCR; scanned/unsupported PDFs and incorrect parser pairing require source-aware parser/transcription work before approval. Do not approve unreadable text without a usable crop. After changing the parser, validate on a fresh scratch database; byte-identical sources are deliberately not reprocessed in an existing bank.

## Daily posting and no repeats

After reviewing questions, register the new command through the existing **development** command workflow and test in the development server. This change does not run command registration or deployment automatically.

- `/qotd post` posts today's question in the current channel.
- `/qotd schedule channel:#math hour:0` enables automatic daily posting at 00:00 UTC (08:00 Manila). Hours are UTC, 0–23. Scheduling after today's time posts shortly if today's slot is unused.
- `/qotd disable` stops scheduled posts.
- `/qotd history` shows recent reserved, posted or uncertain records and posted message links.
- `/qotd reset question:FULL_ID confirm:true` explicitly permits that question again on a future day. It does not delete history or reopen today's slot.

All commands require **Manage Server**, checked at runtime as well as in command permissions. The bot needs View Channel, Send Messages, Attach Files and Send Polls in the destination. Only MCQs use native Discord polls. Open-response questions have no poll. Long question text is attached in full; options exceeding poll text limits are attached in full with source letters used in the poll. Official answers and solutions are never included in the public posting payload.

No-repeat is **per Discord server, across all its channels**; separate servers have independent histories over the shared reviewed bank. One SQLite transaction reserves an approved unused question and today's UTC slot **before** sending. Unique `(guild, question)` consumption and `(guild, day)` history records prevent concurrent workers, restarts, re-imports, and channel changes from selecting a used question. Exhaustion leaves the slot empty; it never silently recycles old questions. The scheduler checks once per minute and catches up the current day after restart, without backfilling earlier days.

Discord delivery and SQLite cannot be one atomic transaction. If sending errors (including ambiguous timeouts), the reservation becomes `uncertain` and remains consumed. A crash between reservation and completion leaves `reserved`, also consumed. There are no automatic delivery retries. A moderator must inspect the destination/history before choosing an explicit reset; the audit record remains. This deliberately favors preventing duplicate posts over guaranteeing a daily message after a failure.

## Persistence and deployment

Keep the same database and assets on a persistent disk/volume across redeploys. Do not delete `data/`, recreate the DB on boot, or put it in an ephemeral container layer. Back up SQLite using a consistent SQLite backup or stop the bot before copying the database and its WAL/SHM companions; retain the assets too. Stored asset paths are absolute and resolve shared-data symlinks to their persistent target, so they survive release-directory cleanup. Keep their location consistent when moving hosts or update paths deliberately. The existing deployment script already links each release data directory to /srv/math-bot/shared/data. The gateway systemd unit now permits writes to that shared directory under ProtectSystem=strict; install/reload the updated unit as part of a future explicitly authorized deployment. Importing into a *new empty database* cannot recover an old deployment's posting history. `solmans/` and `data/` are gitignored; local ignored data must be transferred/backed up separately. No production deployment is performed by these scripts.

## Dependencies and validation

`pdfjs-dist` is Mozilla's maintained PDF.js distribution. Its documented Node legacy build provides page-aware text extraction and handles the actual mixed PDF layouts without a Python service or shelling out to an external converter. It is pinned in Bun's lockfile and validated under Bun 1.4.2. Official references: [PDF.js getting started](https://mozilla.github.io/pdf.js/getting_started/) and [Node extraction example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs). PDF.js optional native canvas packages may be installed for the host platform by Bun. No additional database dependency is required: the repo already uses `node:sqlite` under Bun.

```sh
bun test
bun run check
bun run build
```

Regression tests cover the three layout families using original synthetic content, official-field preservation, cross-page choices/solutions, no invented choices, exact and near duplicates, SQL uniqueness, re-import idempotence through real PDF extraction, pending approval, persistence across database reopen, competing connections, exhaustion, explicit audited reset, successful/failed delivery and MCQ-only poll payloads.
