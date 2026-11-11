-- A ship records the CI conclusion of the pull request it landed through: a fourth kind of evidence next to its
-- commits, its review and its acceptance. Widens one CHECK. (The runner holds the migration advisory lock around this
-- file.) Expand only: no row changes, no backfill; ships before this have no ci row and are not counted as unproven.

ALTER TABLE factory.quality_evidence DROP CONSTRAINT quality_evidence_kind_check;
ALTER TABLE factory.quality_evidence
  ADD CONSTRAINT quality_evidence_kind_check
  CHECK (kind IN ('commits', 'review', 'acceptance', 'ci'));
