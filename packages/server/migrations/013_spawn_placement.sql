-- Where a spawn's terminal goes, as the caller asked: `child` is a hidden child of its parent's terminal, `tab` a tab of its
-- own. NULL is today's rule by role (worker roles child, others tab). Additive: a rollback to the previous release ignores it.
ALTER TABLE factory.spawns ADD COLUMN placement text CHECK (placement IN ('tab', 'child'));
