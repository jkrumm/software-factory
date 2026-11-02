-- FV Wave 4: a window a newer request let go is `superseded` and never started (docs/design.md §11 "Away and back"). Expand only: the state
-- check gains a word. 025 stays as it was applied.
ALTER TABLE factory.fleet_windows DROP CONSTRAINT IF EXISTS fleet_windows_state_check;
ALTER TABLE factory.fleet_windows
  ADD CONSTRAINT fleet_windows_state_check CHECK (state IN ('queued', 'pending', 'ready', 'failed', 'superseded'));
