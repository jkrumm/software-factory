-- Admission holds a new Issue lead while the machine is overloaded (`FACTORY_LOAD_CEILING`): a spawn held for it carries hold `load`.
-- Additive: a rollback to the previous release reads no `load` hold, and a spawn held so is looked at again like any other.
ALTER TABLE factory.spawns DROP CONSTRAINT spawns_hold_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_hold_check CHECK (hold IN ('drain', 'pace', 'wave', 'claim', 'load'));
