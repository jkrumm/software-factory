-- Who gave a verdict (Issue 2157). Expand only: a new column with a default.
--
-- A verdict the factory gave for the owner (the default after the wait, a Spec screen settle, a withdrawal) read the same as
-- his own in `verdicts`; only the note's words told them apart. `by` is the actor: `owner` or `factory`. Rows already
-- stored are marked `factory` where a record shows the factory gave them: its `verdict_given` or `noted` event, a recheck
-- row of its own, or a Spec screen settle. A verdict with no such record stays `owner`.
ALTER TABLE factory.verdicts ADD COLUMN by text NOT NULL DEFAULT 'owner' CHECK (by IN ('owner', 'factory'));

UPDATE factory.verdicts v SET by = 'factory'
WHERE EXISTS (
    SELECT 1 FROM factory.issue_events e
    WHERE e.actor = 'factory'
      AND e.key IN ('verdict_given:' || v.artifact_id || ':' || v.revision, 'noted:verdict:' || v.artifact_id || ':' || v.revision))
  OR EXISTS (
    SELECT 1 FROM factory.checkpoint_rechecks c
    WHERE c.checkpoint_id = v.artifact_id AND c.through_version = v.revision AND c.kind = 'artifact' AND c.by = 'factory')
  OR EXISTS (
    SELECT 1 FROM factory.spec_screens s
    WHERE s.artifact_id = v.artifact_id AND s.revision = v.revision AND s.outcome = 'settled');
