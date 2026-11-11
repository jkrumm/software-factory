-- A Concept or Spec that waited a day for the owner's verdict is looked at once: withdrawn when its Issue moved past it, a
-- flagged Issue's Spec answered by its lead's defaults, else pushed once. The look is a recheck row like a Decision's; for an
-- artifact `through_version` is the revision it saw, so a revision is looked at once.
ALTER TABLE factory.checkpoint_rechecks DROP CONSTRAINT checkpoint_rechecks_kind_check;
ALTER TABLE factory.checkpoint_rechecks
  ADD CONSTRAINT checkpoint_rechecks_kind_check CHECK (kind IN ('decision', 'errand', 'artifact'));
