-- Steps off the mini (issue 1793): a test slot and a finished step say which host they are on. A slot of the VPS counts
-- in the VPS's own fit, never in the mini's; a step's run is learned per host, its peak across hosts. NULL is the mini:
-- every row written before this migration ran there.
ALTER TABLE factory.capacity_slots ADD COLUMN host text;
ALTER TABLE factory.step_costs ADD COLUMN host text;
ALTER TABLE factory.slot_waits ADD COLUMN host text;
-- the git tree a run off the mini ran on (the worktree's snapshot): the identity of what ran, for counting the same tree
-- run twice
ALTER TABLE factory.step_costs ADD COLUMN tree text;
-- a run on the mini that found a red off the mini green: the step loses its remote place for 7 days
ALTER TABLE factory.step_costs ADD COLUMN disagreed boolean;
CREATE INDEX step_costs_disagreed ON factory.step_costs (name, at DESC) WHERE disagreed;
