-- What a hygiene pass did to findings already filed: an open Issue closed as healed because its probe ran green, a lead told
-- the probe is green, an Issue closed done reopened because the probe is red again, a finding left to a person.
-- [{ key, issue, action: healed | noted | reopened | kept, why, at }]. A fact of the pass, never read back to decide anything:
-- a finding's state is derived from the Issues it filed (loop_findings) and their events.
-- Expand only: a pass recorded before this has none.

ALTER TABLE factory.hygiene_passes ADD COLUMN lifecycle jsonb NOT NULL DEFAULT '[]'::jsonb;
