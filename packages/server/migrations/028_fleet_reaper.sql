-- FV Wave 5: the reaper. One more kind of row in the triage log: `reaped`, a finished worker session the reaper closed (kill and rm).
-- Not undoable: the terminal and its program are gone (the worktree stays). Not a pure expand: the previous release does not know the kind. Rollback order in docs/design.md §11 "The reaper":
-- before rolling back set FACTORY_REAPER=off and `DELETE FROM factory.fleet_triage_log WHERE kind = 'reaped'` (and the old release's strict
-- /fleet reading rejects the new `reaper` key until its next snapshot is stored).
ALTER TABLE factory.fleet_triage_log DROP CONSTRAINT fleet_triage_log_kind_check;
ALTER TABLE factory.fleet_triage_log
  ADD CONSTRAINT fleet_triage_log_kind_check CHECK (kind IN ('plan_stale', 'fold', 'dismiss_note', 'reaped'));
