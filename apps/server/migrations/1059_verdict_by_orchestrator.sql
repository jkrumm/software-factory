-- The owner's delegate may give a verdict on a Spec that is no owner gate (Issue 2541). Expand only: a CHECK that admits one more value.
--
-- `by` was `owner` or `factory`; the orchestrator's verdict on his behalf is `orchestrator`, so it is never read as his own and he
-- can reopen it with a verdict of his own (which replaces it and says `owner`).
ALTER TABLE factory.verdicts DROP CONSTRAINT verdicts_by_check;
ALTER TABLE factory.verdicts ADD CONSTRAINT verdicts_by_check CHECK (by IN ('owner', 'factory', 'orchestrator'));
