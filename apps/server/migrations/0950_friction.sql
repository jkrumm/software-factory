-- The friction loop's record: one row per weekly pass. Whether a pass is due is read from the newest `at`, never kept in
-- the runner's memory, so a restart or a deploy does not reset the week. `filed` lists the patterns a signal was filed
-- for, `over_budget` the patterns over their threshold that the pass's cap left out, `failed` the ones intake refused.

CREATE TABLE factory.friction_passes (
  id text PRIMARY KEY,
  at timestamptz NOT NULL,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  -- Issues filed in the window: what the per-Issue rates divide by
  issues integer NOT NULL CHECK (issues >= 0),
  -- [{ key, count, title }]
  filed jsonb NOT NULL,
  -- [{ key, count }]
  over_budget jsonb NOT NULL,
  -- [{ key, reason }]
  failed jsonb NOT NULL
);

CREATE INDEX friction_passes_by_time ON factory.friction_passes (at);
