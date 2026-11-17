-- The edges the queue loop took back. An `after` edge the factory itself added (`planning_edges.inferred_by` set: triage
-- or the queue loop; never one somebody stated) is removed when the files of the two Issues turned out disjoint
-- (`disjoint`) or its blocker has waited on the owner for longer than the loop allows (`owner_wait`). The row keeps what
-- the removed edge carried (who inferred it, when it was added) and why it went, so that
--   1. the edge measure (`read/edge-need.ts`) still counts the edge: whether the two Issues touched the same files in the
--      end is judged for removed edges too, and
--   2. the loop does not add the same pair again (`checkQueue` refuses a pair it took back).
-- Expand only; nothing reads a row's absence.
CREATE TABLE factory.queue_edge_removals (
  issue_id text NOT NULL REFERENCES factory.issues (id),
  after_issue text NOT NULL REFERENCES factory.issues (id),
  -- as the edge stored it: `triage: <reason>` or `queue: <reason>`
  inferred_by text NOT NULL,
  added_at timestamptz NOT NULL,
  removed_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('disjoint', 'owner_wait')),
  -- one line: what held (the path counts, or the hours the blocker waited)
  reason text NOT NULL,
  PRIMARY KEY (issue_id, after_issue, removed_at)
);

CREATE INDEX queue_edge_removals_by_time ON factory.queue_edge_removals (removed_at);
