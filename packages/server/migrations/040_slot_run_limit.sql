-- A test slot has a run limit (docs/design.md "Test slots (FL7)"). Additive: a rollback to the previous release ignores both columns
-- (it never reads them and its inserts leave them NULL, which the health line skips).

-- `granted_at` is when the slot was granted (NULL: a lease that predates this column); `run_ms` is the run limit resolved at that
-- grant (the caller's, else the project manifest's `slots.run`, else the default), kept for the whole lease.
ALTER TABLE factory.slots
  ADD COLUMN granted_at timestamptz,
  ADD COLUMN run_ms     integer;
