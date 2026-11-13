-- What the last run of an Errand's command came to. A pushed command that failed (a non-zero exit), timed out (124) or is
-- still running does not close the Errand: it stays open and these say why. `run_attempts` counts the runs that came back
-- unsuccessful; the output is kept as its first 20 lines and its last 20, so the reason (usually the first lines) survives.
--
--   run_status   'failed' | 'timeout' | 'running'
--   run_exit     the exit code, null when the run has none (still running, killed)

ALTER TABLE factory.errands
  ADD COLUMN run_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN run_status text CHECK (run_status IN ('failed', 'timeout', 'running')),
  ADD COLUMN run_exit integer,
  ADD COLUMN run_at timestamptz,
  ADD COLUMN run_head text,
  ADD COLUMN run_tail text;
