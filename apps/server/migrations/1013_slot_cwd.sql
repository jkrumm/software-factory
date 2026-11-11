-- The directory a `factory slot run` was started in: how the steward ties a held or queued slot to the lead whose worktree it is.
ALTER TABLE factory.capacity_slots ADD COLUMN cwd text;
