-- The Judge's third verdict, `back`: a lead's Decision goes back to its lead once, on its first look, with a note. The
-- Decision stays open and reaches no owner; the note is the `noted` event that carries `back` (its key names the Decision),
-- which is also how a second look knows it was sent back before: an amend clears the steps, never the events.

ALTER TABLE factory.decision_steps DROP CONSTRAINT decision_steps_outcome_check;
ALTER TABLE factory.decision_steps ADD CONSTRAINT decision_steps_outcome_check
  CHECK (outcome IN ('answered', 'passed', 'rejected', 'failed', 'open', 'back'));
