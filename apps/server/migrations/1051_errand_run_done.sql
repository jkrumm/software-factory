-- A pushed command that ran and exited 0 is recorded on the Errand like one that failed (issue 2211): the desk pass must
-- know the command already ran, or it offers the same command again every few hours while its check still says "needed".
-- `run_attempts` stays the count of unsuccessful runs; a run that succeeded does not add to it.
--
--   run_status   'done' | 'failed' | 'timeout' | 'running'
ALTER TABLE factory.errands DROP CONSTRAINT IF EXISTS errands_run_status_check;
ALTER TABLE factory.errands
  ADD CONSTRAINT errands_run_status_check CHECK (run_status IN ('done', 'failed', 'timeout', 'running'));
