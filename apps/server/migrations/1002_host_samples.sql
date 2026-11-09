-- One reading of the host a minute, kept for a day (app/loops/host.ts): the Console's Live popover draws it, so a deploy
-- restart does not empty the chart. A figure the host could not read at that minute is null.
CREATE TABLE factory.host_samples (
  at                   timestamptz      PRIMARY KEY,
  load                 double precision,
  memory_used_pct      double precision,
  swap_used_pct        double precision,
  swapout_mb_per_300s  double precision
);
