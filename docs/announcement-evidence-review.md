# Retained public evidence and manual review

The host sanitizes organizer text before extraction and again before retention.
The 50 KB evidence budget, 50 MIME nodes, 5 MB attachment bound, and 12-page PDF
bound remain enforced. Long statements are retained in stable chunks of at most
16,000 characters. Redaction happens before chunking. Missing or unreadable
content creates a completeness warning and requires explicit review.

Safe HTML anchor destinations remain beside their visible text. Personalized
assessment, account, authentication, and meeting access links are withheld. PDF
page coordinates help the reviewer locate statements; they do not certify table
interpretation. Image-only pages remain local manual-review work. No vision
provider receives them.

Each candidate stores field-level links to retained source statements. Explicit
`fieldEvidence` groups can assign individual public fields to different evidence
IDs. When omitted, every proposal-level cited statement must be reviewed against
every present public field. Missing evidence blocks approval. Partial corrections
retain baseline field links and add correction links for changed fields. Immutable
approved revisions retain the exact linkage reviewed for that revision.

For manual transcription, use a new source identity, bounded `evidence`, and
candidate `evidenceIds`, as demonstrated in the fabricated
`docs/examples/announcements/synthetic-reviewed-import.json`. All facts still need
moderator approval. Historical examples without evidence remain readable but do
not receive new source-support certification automatically. Existing retained
source evidence cannot be replaced by an import. A host-detected erratum remains
a correction even if advisory JSON says otherwise.

Source displays use ordinal email numbers and host MIME/page/chunk locations.
Raw Gmail/attachment identities and internal database keys stay out of the
rendered review. Staff must compare proposed values with the retained statements;
field linkage proves traceability, not the correctness of model interpretation.
These local checks do not verify authenticated provider or Discord behavior.
