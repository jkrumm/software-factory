-- Contract step of the Spec screen (migration 1029). Its readers and writers of the owner's mark left on 2026-11-23, two
-- days before this migration: the two verdicts columns go. The table that stores each Spec revision's path stays and takes
-- the name of what it holds, with its constraints and its partial index.
-- (The runner holds the migration advisory lock around this file.)

ALTER TABLE factory.verdicts DROP COLUMN needed_me, DROP COLUMN needed_at;

ALTER TABLE factory.spec_screens RENAME TO spec_paths;
ALTER TABLE factory.spec_paths RENAME CONSTRAINT spec_screens_pkey TO spec_paths_pkey;
ALTER TABLE factory.spec_paths RENAME CONSTRAINT spec_screens_artifact_id_revision_fkey TO spec_paths_artifact_id_revision_fkey;
ALTER TABLE factory.spec_paths RENAME CONSTRAINT spec_screens_outcome_check TO spec_paths_outcome_check;
ALTER TABLE factory.spec_paths RENAME CONSTRAINT spec_screens_by_check TO spec_paths_by_check;
ALTER TABLE factory.spec_paths RENAME CONSTRAINT spec_screens_source_check TO spec_paths_source_check;
ALTER TABLE factory.spec_paths RENAME CONSTRAINT spec_screens_check TO spec_paths_check;
ALTER INDEX factory.spec_screens_held RENAME TO spec_paths_held;
