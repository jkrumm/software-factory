-- The time of a spawn's first claim: its retry budget runs from here. Cleared when the spawn goes back to waiting for
-- capacity (waiting is not failing) and when a failed spawn is re-queued.
ALTER TABLE factory.spawns ADD COLUMN first_claimed_at timestamptz;
