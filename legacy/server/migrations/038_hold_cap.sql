-- Admission holds an Issue lead whose every account is at the per-account lead cap (`FACTORY_LEADS_PER_ACCOUNT`): a spawn held for it carries hold `cap`,
-- so the health line can say how long and what holds it. Only widens the check, so a rollback to the previous release works.
ALTER TABLE factory.spawns DROP CONSTRAINT spawns_hold_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_hold_check CHECK (hold IN ('drain', 'pace', 'wave', 'claim', 'review_slots', 'deep_cap', 'load', 'cap'));
