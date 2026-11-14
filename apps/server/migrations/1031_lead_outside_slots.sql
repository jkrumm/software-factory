-- A lead's cost leaves out what runs under a `factory slot run` (the slot grant weighs those steps against free memory
-- before they start, so admission no longer charges them to the lead too). New rows are written with outside_slots = true;
-- every row from before this migration is set false, and the learned cost and its read model take only true rows: a
-- repo falls back to the lane prior until three attempts sampled outside slots exist. The default is true so a writer
-- that does not say (a test seed) writes a row that counts; the host loop always says.
ALTER TABLE factory.lead_samples ADD COLUMN outside_slots boolean NOT NULL DEFAULT true;
UPDATE factory.lead_samples SET outside_slots = false;
