-- The owner's delegate agent (the orchestrator token) may dismiss a quarantined signal, recorded as itself, never as the owner.

ALTER TABLE factory.intake_signals DROP CONSTRAINT intake_signals_dismissed_by_check;
ALTER TABLE factory.intake_signals
  ADD CONSTRAINT intake_signals_dismissed_by_check
  CHECK (dismissed_by IN ('owner', 'orchestrator', 'judge', 'probe'));
