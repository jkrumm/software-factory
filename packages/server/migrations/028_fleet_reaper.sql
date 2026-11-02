-- FV Wave 5: the reaper. One more kind of row in the triage log: `reaped`, a finished worker session the reaper closed (kill and rm).
-- Not undoable: the terminal and its program are gone (the worktree stays). Additive: a rollback to the previous release never reads the kind.
ALTER TABLE factory.fleet_triage_log DROP CONSTRAINT fleet_triage_log_kind_check;
ALTER TABLE factory.fleet_triage_log
  ADD CONSTRAINT fleet_triage_log_kind_check CHECK (kind IN ('plan_stale', 'fold', 'dismiss_note', 'reaped'));
