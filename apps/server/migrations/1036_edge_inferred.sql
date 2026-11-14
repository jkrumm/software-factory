-- Who inferred an edge, and why: `triage: <its reason>` for an edge the settle workflow named. Null is an edge somebody
-- stated (`--after`, `planning after`, a plan row). Named in the queue order so an inferred wait can be judged at a glance.
-- Expand only: an edge stored before this column has none.
ALTER TABLE factory.planning_edges ADD COLUMN inferred_by text;
