-- A lead whose terminal is live but runs no agent (a host restart brings every kept terminal back as a login shell) is lost
-- until its session starts again (`app/leads-follow.ts`). One row per loss: `closed_at` null is a loss still open, which the
-- health lines name; the friction read counts the rows as lost leads whether or not the revival worked.
CREATE TABLE factory.lead_losses (
  issue_id text NOT NULL REFERENCES factory.issues (id),
  attempt integer NOT NULL,
  at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (issue_id, attempt, at)
);
CREATE UNIQUE INDEX lead_losses_open ON factory.lead_losses (issue_id, attempt) WHERE closed_at IS NULL;
