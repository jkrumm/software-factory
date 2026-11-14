-- What a queued Issue waited for, as intervals: the admission pass (app/capacity-admit.ts `recordWaits`) records, per queued
-- Issue, the kind of the reason it stays queued (the kind `factory queue order` prints; the lead-fit refusal of the memory
-- gate is its own kind, `memory_fit`), and starts a new interval only when the kind changes. `to_at` is null while the
-- interval is open: the Issue still waits for that reason. Kept 400 days, as the hourly class rollups (the rows are a few per
-- Issue). `project` is the project name the Issue's repo is stored as; `message` is the reason's text when the interval began.
CREATE TABLE factory.queue_intervals (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id text        NOT NULL REFERENCES factory.issues (id),
  project  text        NOT NULL,
  kind     text        NOT NULL,
  message  text        NOT NULL,
  from_at  timestamptz NOT NULL,
  to_at    timestamptz
);

-- one open interval per Issue: the pass closes the old one before it opens a new kind
CREATE UNIQUE INDEX queue_intervals_open ON factory.queue_intervals (issue_id) WHERE to_at IS NULL;
CREATE INDEX queue_intervals_from ON factory.queue_intervals (from_at);
CREATE INDEX queue_intervals_issue ON factory.queue_intervals (issue_id, from_at);
