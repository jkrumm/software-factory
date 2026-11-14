-- The throughput loop's ledger: one row per improvement finding it filed. The loop ranks what cost most each day and files
-- one improvement signal per project with its measured `before`, a target and the query that measures it; the row keeps
-- the figure so that three days after the Issue shipped the loop reads the `after` and says whether it moved. Expand only:
-- a new table, nothing else touched. (The runner holds the migration advisory lock around this file.)

CREATE TABLE factory.throughput_findings (
  id          text PRIMARY KEY,
  project     text             NOT NULL,
  -- what the finding measures: failed_run_minutes, slot_minutes_per_issue, step_peak_mib, process_growth_mib, queued_minutes
  kpi         text             NOT NULL,
  -- what within the project: a step's tier, a process name, or '*' for the whole project
  subject     text             NOT NULL,
  -- the figure per day (minutes kinds) or the peak (memory kinds) when it was filed, and the figure it should reach
  before      double precision NOT NULL,
  target      double precision NOT NULL,
  direction   text             NOT NULL CHECK (direction IN ('up', 'down')),
  unit        text             NOT NULL,
  -- the cost the ranking sorted by, in minutes
  cost_minutes double precision NOT NULL,
  -- the command that reads the figure again
  query       text             NOT NULL,
  signal_id   text,
  issue_id    text,
  filed_at    timestamptz      NOT NULL,
  -- the improvement's ship, once its Issue shipped; the after is read three days later
  shipped_at  timestamptz,
  after       double precision,
  after_at    timestamptz,
  -- open: the Issue is not shipped; shipped: waiting for its after; moved / flat / worse: the after was read; dropped: the Issue closed without shipping; unmeasured: no data three days after
  status      text             NOT NULL CHECK (status IN ('open', 'shipped', 'moved', 'flat', 'worse', 'dropped', 'unmeasured')),
  -- the earlier finding of the same subject this one comes back from, when its after did not move
  reopens     text
);
CREATE INDEX throughput_findings_by_project ON factory.throughput_findings (project, filed_at DESC);
CREATE INDEX throughput_findings_by_status ON factory.throughput_findings (status) WHERE status IN ('open', 'shipped');
