-- Errands converge (issue 1020). An Issue whose pull request waits on a required review by someone else waits on the pull
-- request, not on the owner: the wait is `external`, and the `reviews` loop polls the pull request and wakes it. An Errand
-- the owner or the orchestrator turns back ends as `turned_back` (not done); the orchestrator is a closer too. A pushed
-- MacBook command is remembered (`pushed_at`), so the desk pass pushes one at a time and not the same one twice. The desk
-- pass keeps when it last ran, and the owner's visit keeps when he came back after a long absence.
-- (The runner holds the migration advisory lock around this file.) Expand only: no row changes.

ALTER TABLE factory.issues DROP CONSTRAINT issues_wait_reason_check;
ALTER TABLE factory.issues
  ADD CONSTRAINT issues_wait_reason_check
  CHECK (wait_reason IN (
    'timer', 'dependency', 'wall', 'unreported', 'blocked', 'lead_gone', 'regressed', 'decision', 'review', 'errand',
    'external'
  ));

ALTER TABLE factory.errands DROP CONSTRAINT errands_closed_kind_check;
ALTER TABLE factory.errands
  ADD CONSTRAINT errands_closed_kind_check
  CHECK (closed_kind IN ('done', 'not_needed', 'expired', 'superseded', 'turned_away', 'turned_back'));

ALTER TABLE factory.errands DROP CONSTRAINT errands_closed_by_check;
ALTER TABLE factory.errands
  ADD CONSTRAINT errands_closed_by_check
  CHECK (closed_by IN ('owner', 'orchestrator', 'check', 'judge', 'loop', 'request'));

-- the last time the desk pass pushed this command to the MacBook
ALTER TABLE factory.errands ADD COLUMN pushed_at timestamptz;

-- when the owner last came back after two hours or more away; the desk pass is due once this is newer than its last run
ALTER TABLE factory.console_visit ADD COLUMN returned_at timestamptz;

-- the desk pass: one row, when it last ran
CREATE TABLE factory.desk_pass (
  id boolean     PRIMARY KEY DEFAULT true CHECK (id),
  at timestamptz NOT NULL
);

-- what a review wait saw of its pull request the first time the poll looked: the number of reviews and comments by others,
-- so only a later one wakes it. One row per wait (`since` is the version that began it).
CREATE TABLE factory.review_looks (
  issue_id  text        NOT NULL REFERENCES factory.issues (id),
  since     integer     NOT NULL,
  baseline  integer     NOT NULL,
  looked_at timestamptz NOT NULL,
  PRIMARY KEY (issue_id, since)
);
