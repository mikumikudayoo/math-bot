# Announcement coverage and current MPoTD answer aliases

The release preserves the 12-page PDF and 50,000-byte evidence limits. Oversized PDFs are skipped, complete evidence already collected is retained, and evidence-budget exhaustion stops further evidence consumption. Incomplete evidence remains explicitly flagged and cannot be approved without factual review. Image timetables remain manual; no OCR/vision is enabled.

Production intake adds icestaffph@gmail.com, info.ice.th@gmail.com and motliphilippines.csr@gmail.com to BOTH the explicit sender allowlist and restricted Gmail query. Subject matching includes PIMSO and its full official name. The generic subject:science exclusion is removed because PIMSO's official name contains Science; host classification still rejects unsupported science and holds mixed math/science notices for review. Gmail history admission, bootstrap, and cursor behavior are unchanged. No old message is replayed.

Private moderator commands:
- `/mpotd-admin answer-key`: current posted MPoTD number, date, question ID, official answer, grading configuration, and all added aliases.
- `/mpotd-admin answer-add answer:1/2`: add an audited, durable alias to the current unscored post.
- `/mpotd-admin answer-remove answer:1/2`: remove a matching added alias. Original accepted answers cannot be removed.

All responses are ephemeral with mentions disabled and use the existing moderator authorization. Existing Discord command permissions continue to apply. Added aliases are per-post and do not rewrite question-bank answers, grading/scoring snapshots, or finalized results. Scored/revealed posts are read-only. Active submissions are evaluated against aliases when scoring runs; historical scores are not recalculated.

An explicitly added fraction alias uses the existing numeric scorer, accepting `1/2`, `1 / 2`, `1⁄2`, a complete two-line `1\n2`, `2/4`, and `0.5`. Numeric grading configured with fractions also recognizes stacked fractions and Unicode fraction slashes. Exact text stays exact unless a moderator deliberately adds a fraction alias. `1 2` is never concatenated to `12`; zero denominators, partial numbers, and arbitrary expressions are not fractions. Plain text aliases use exact matching or the question's normalized-text policy. At most 20 aliases of 200 characters each are accepted. Canonical answers remain protected.

Storage is additive: `qotd_answer_aliases` references the daily session; changes and actor/time are recorded transactionally in `qotd_audit`. Existing schema compatibility and daily snapshots are retained. Back up production SQLite with its backup API before deployment. Turn announcement auto-send off, deploy and register commands, inspect inventory and Gmail state, and restore auto-send only after safety checks pass.
