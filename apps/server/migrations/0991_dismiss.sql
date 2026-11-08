-- A held signal can be turned away: state `dismissed`, with who, why and when. The owner and the Judge dismiss; a probe (a
-- lead's own test signal) is stored dismissed at once. A dismissed signal files nothing, so the pair CHECK between the
-- filed states and `issue_id` (intake_signals_check) holds as it is.

ALTER TABLE factory.intake_signals DROP CONSTRAINT intake_signals_state_check;
ALTER TABLE factory.intake_signals
  ADD CONSTRAINT intake_signals_state_check
  CHECK (state IN ('held', 'filed', 'amended', 'incident', 'promoted', 'dismissed'));

ALTER TABLE factory.intake_signals
  ADD COLUMN dismissed_reason text,
  ADD COLUMN dismissed_by text CONSTRAINT intake_signals_dismissed_by_check CHECK (dismissed_by IN ('owner', 'judge', 'probe')),
  ADD COLUMN dismissed_at timestamptz;

ALTER TABLE factory.intake_signals
  ADD CONSTRAINT intake_signals_dismissal_check
  CHECK ((state = 'dismissed') = (dismissed_reason IS NOT NULL AND dismissed_by IS NOT NULL AND dismissed_at IS NOT NULL)
    AND (state = 'dismissed' OR (dismissed_reason IS NULL AND dismissed_by IS NULL AND dismissed_at IS NULL)));
