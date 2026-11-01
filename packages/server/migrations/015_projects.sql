-- F2 Wave 2: project.yaml v0, claims and the make contract (docs/design.md §9, §12). Additive: a rollback to the previous
-- release ignores all of it.

-- `manifest` is the last valid manifest (NULL: the defaults), `manifest_sha` the hash of the content it came from. A manifest
-- that does not parse leaves both alone and records itself in `manifest_error` / `manifest_error_sha`. `make_targets` is
-- {makefile, check, test, deploy, verify, restart, quality, logs, status}, read when the project was last synced.
ALTER TABLE factory.projects
  ADD COLUMN manifest_sha       text,
  ADD COLUMN manifest_error     text,
  ADD COLUMN manifest_error_sha text,
  ADD COLUMN make_checked_at    timestamptz;
-- `name` is the directory's name; a second directory of that name under another root is keyed `<name>~<hash of its path>`.
CREATE UNIQUE INDEX projects_repo ON factory.projects (repo);

-- A lead's claim on a project: one row per Issue, `held_at` set once it holds the claim, NULL while it queues behind the
-- holders. The oldest queued Issue goes first (urgent ones before the rest). A row goes when its Issue closes.
CREATE TABLE factory.claims (
  key       text NOT NULL,
  issue_id  integer NOT NULL REFERENCES factory.issues (id),
  urgent    boolean NOT NULL DEFAULT false,
  queued_at timestamptz NOT NULL,
  held_at   timestamptz,
  PRIMARY KEY (key, issue_id)
);
CREATE INDEX claims_issue ON factory.claims (issue_id);

-- A spawn that works an Issue waits on the Issue's claim. Fleet spawns (waves, fan workers, `rd`) have none.
ALTER TABLE factory.spawns ADD COLUMN issue_id integer REFERENCES factory.issues (id);
ALTER TABLE factory.spawns DROP CONSTRAINT spawns_hold_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_hold_check CHECK (hold IN ('drain', 'pace', 'wave', 'claim'));
