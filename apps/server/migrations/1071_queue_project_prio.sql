-- A project's priority, the owner's setting of the moment: stored in the project's queue-state row, 0 when none.
-- A row may now exist for a priority alone (state `run`).

ALTER TABLE factory.capacity_queue_states
  ADD COLUMN prio integer NOT NULL DEFAULT 0 CHECK (prio BETWEEN -1000 AND 1000);
