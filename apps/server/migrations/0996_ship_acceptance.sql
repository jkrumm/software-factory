-- A ship states what it found against each acceptance line of the Issue: a third kind of evidence next to its commits
-- and its review. Widens one CHECK. (The runner holds the migration advisory lock around this file.) Expand only: no
-- row changes, no backfill; ships before this have no acceptance row and are not counted as stating nothing.

ALTER TABLE factory.quality_evidence DROP CONSTRAINT quality_evidence_kind_check;
ALTER TABLE factory.quality_evidence
  ADD CONSTRAINT quality_evidence_kind_check
  CHECK (kind IN ('commits', 'review', 'acceptance'));
