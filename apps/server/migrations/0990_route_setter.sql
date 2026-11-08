-- A door route records who set it: the owner, or a lead for its own Issue's repo (`lead:issue_<n>`).

ALTER TABLE factory.intake_door_routes ADD COLUMN set_by text NOT NULL DEFAULT 'owner';
