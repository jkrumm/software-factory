-- When each loop's pass last ended, ok or failed (app/loops/runner.ts): a restart schedules the loop from here, not from
-- boot, so a loop with a long interval (fix-classes, 6 h) still reaches its pass when the server restarts on every deploy.
CREATE TABLE factory.loop_passes (
  loop         text        PRIMARY KEY,
  last_pass_at timestamptz NOT NULL
);
