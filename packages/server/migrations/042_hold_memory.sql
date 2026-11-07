-- Admission holds a new Issue lead while the host is under memory pressure (`FACTORY_SWAPOUT_CEILING_MB`, `FACTORY_SWAP_CEILING_PCT`): a spawn held for it carries hold `memory`.
-- Only widens the check, so a rollback to the previous release works.
ALTER TABLE factory.spawns DROP CONSTRAINT spawns_hold_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_hold_check CHECK (hold IN ('drain', 'pace', 'wave', 'claim', 'review_slots', 'deep_cap', 'load', 'cap', 'memory'));
