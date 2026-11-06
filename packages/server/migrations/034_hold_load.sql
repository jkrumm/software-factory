-- Admission holds a new Issue lead while the machine is overloaded (`FACTORY_LOAD_CEILING`): a spawn held for it carries hold `load`.
-- Only widens the check: the review-era values stay allowed, so no stored row can fail it and a rollback to the previous release works.
ALTER TABLE factory.spawns DROP CONSTRAINT spawns_hold_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_hold_check CHECK (hold IN ('drain', 'pace', 'wave', 'claim', 'review_slots', 'deep_cap', 'load'));
