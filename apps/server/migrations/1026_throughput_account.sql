-- Where a lead's hours go: three records `read throughput` splits an Issue's wall time with. Expand only.

-- A step carries the directory it ran in, so a lead's steps are the ones inside its worktree.
ALTER TABLE factory.step_costs ADD COLUMN cwd text;

-- One row per `factory merge-lock` call: when it asked for the project's merge window, when it got it and when it gave it
-- back. Wait is requested to acquired, hold is acquired to released; a call that never got the window has no acquired_at.
CREATE TABLE factory.merge_windows (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project      text        NOT NULL,
  cwd          text,
  requested_at timestamptz NOT NULL,
  acquired_at  timestamptz,
  released_at  timestamptz NOT NULL,
  exit_code    integer,
  CHECK (acquired_at IS NULL OR (acquired_at >= requested_at AND released_at >= acquired_at))
);
CREATE INDEX merge_windows_by_released ON factory.merge_windows (released_at);

-- One row per finished workflow run of a project's GitHub repo: the ledger of CI. `queued_at` is when the run (or its
-- latest attempt) was created, `started_at` when it began, `finished_at` when it ended; queue is the first to the second,
-- duration the second to the third. A head is a branch (`head_branch`, a lead's branch for its pull request) and a sha.
CREATE TABLE factory.ci_runs (
  repo         text        NOT NULL,
  run_id       bigint      NOT NULL,
  workflow     text        NOT NULL,
  event        text        NOT NULL,
  head_branch  text,
  head_sha     text        NOT NULL,
  run_attempt  integer     NOT NULL DEFAULT 1,
  queued_at    timestamptz NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL,
  conclusion   text        NOT NULL,
  PRIMARY KEY (repo, run_id),
  CHECK (started_at >= queued_at AND finished_at >= started_at)
);
CREATE INDEX ci_runs_by_finished ON factory.ci_runs (finished_at);
CREATE INDEX ci_runs_by_branch ON factory.ci_runs (repo, head_branch);
