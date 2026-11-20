-- The owner pauses an Issue (issue 2562): a wait with the reason `paused`, which only his word or its time ends.
-- (The runner holds the migration advisory lock around this file.) Expand only: no row changes.

ALTER TABLE factory.issues DROP CONSTRAINT issues_wait_reason_check;
ALTER TABLE factory.issues
  ADD CONSTRAINT issues_wait_reason_check
  CHECK (wait_reason IN (
    'timer', 'dependency', 'wall', 'unreported', 'blocked', 'lead_gone', 'regressed', 'decision', 'review', 'errand',
    'external', 'paused'
  ));
