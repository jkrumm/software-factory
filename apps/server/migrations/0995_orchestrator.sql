-- The orchestrator (the owner's delegate agent) has a principal of its own: its events carry the actor `orchestrator`, and a
-- Decision it answered is settled by `orchestrator`, so the owner-touch counts read the owner alone. Widens two CHECKs.
-- (The runner holds the migration advisory lock around this file.) Expand only: no row changes.

ALTER TABLE factory.issue_events DROP CONSTRAINT issue_events_actor_check;
ALTER TABLE factory.issue_events
  ADD CONSTRAINT issue_events_actor_check
  CHECK (actor IN ('owner', 'orchestrator', 'lead', 'factory', 'steward', 'judge'));

ALTER TABLE factory.decisions DROP CONSTRAINT decisions_settled_by_check;
ALTER TABLE factory.decisions
  ADD CONSTRAINT decisions_settled_by_check
  CHECK (settled_by IN ('policy', 'judge', 'default', 'owner', 'orchestrator'));
