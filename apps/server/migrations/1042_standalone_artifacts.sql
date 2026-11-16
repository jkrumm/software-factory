-- A standalone artifact: a Report no Issue owns, shown to the owner for comments (`factory artifact new`). It has no Issue
-- and no lead, so it carries the repo it concerns; an Issue-bound artifact keeps `issue_id` and takes its repo from the Issue.
-- `artifact_links` says which Issues an artifact concerns beyond the one that owns it: a Spec several Issues build from,
-- a research page, a Report for a plan. Expand only: nothing is rewritten.

ALTER TABLE factory.artifacts
  ALTER COLUMN issue_id DROP NOT NULL,
  ADD COLUMN repo text,
  ADD CONSTRAINT artifacts_standalone_repo CHECK (issue_id IS NOT NULL OR repo IS NOT NULL);

CREATE TABLE factory.artifact_links (
  artifact_id text        NOT NULL REFERENCES factory.artifacts (id),
  issue_id    text        NOT NULL REFERENCES factory.issues (id),
  linked_at   timestamptz NOT NULL,
  PRIMARY KEY (artifact_id, issue_id)
);
CREATE INDEX artifact_links_by_issue ON factory.artifact_links (issue_id, linked_at);
