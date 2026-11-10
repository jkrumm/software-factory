-- A Replan is an ordinary Issue whose lead proposes changes to a project's plan; this row says which Issue it is and why
-- it was filed (app/planning-replan.ts). At most one per project is open: the Issue's own state says whether it still is.
CREATE TABLE factory.replans (
  issue_id    text        PRIMARY KEY REFERENCES factory.issues (id),
  project     text        NOT NULL,
  trigger     text        NOT NULL CHECK (trigger IN ('owner', 'stalled')),
  ask         text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX replans_project_idx ON factory.replans (project);
