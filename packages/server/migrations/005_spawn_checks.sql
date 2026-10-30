-- The assignments that existed before `assigned_at` did: the claim time, else the creation time, so the first tick
-- after the upgrade still counts them as spawns the latest sample may not show.
UPDATE factory.spawns SET assigned_at = COALESCE(claimed_at, created_at)
WHERE account IS NOT NULL AND status IN ('queued', 'starting', 'started') AND assigned_at IS NULL;

-- Tier and effort are the zod enums of the contract; a row outside them would fail every read of the spawn list.
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_tier_check CHECK (tier IN ('haiku', 'sonnet', 'opus'));
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_effort_check CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
