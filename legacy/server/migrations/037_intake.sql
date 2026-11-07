-- Intake (docs/design.md §4 "Intake: work comes in by itself"). Additive: a rollback to the previous release ignores all of it.

-- `door_issues` is the episode table of every intake source: `monitor` is the generic subject. A stateless source's fingerprint, the
-- repeats it saw after the Issue closed, and the last time it was seen.
ALTER TABLE factory.door_issues
  ADD COLUMN fingerprint text,
  ADD COLUMN repeats     integer NOT NULL DEFAULT 0,
  ADD COLUMN last_seen   timestamptz;
CREATE INDEX door_issues_fingerprint ON factory.door_issues (source, fingerprint) WHERE fingerprint IS NOT NULL;

-- A `down` waiting out its grace (and its runbook) before it becomes an Issue: one row per subject.
CREATE TABLE factory.intake_pending (
  source    text NOT NULL,
  subject   text NOT NULL,
  repo      text NOT NULL,
  signal    jsonb NOT NULL,
  rule      jsonb NOT NULL,
  opened_at timestamptz NOT NULL,
  due_at    timestamptz NOT NULL,
  attempts  integer NOT NULL DEFAULT 0,
  results   jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (source, subject)
);
CREATE INDEX intake_pending_due ON factory.intake_pending (due_at);

-- Every settled event key, kept 7 days: a late retry of a `down` that healed opens no second pending row.
CREATE TABLE factory.intake_seen (
  key     text PRIMARY KEY,
  seen_at timestamptz NOT NULL
);
CREATE INDEX intake_seen_at ON factory.intake_seen (seen_at);
