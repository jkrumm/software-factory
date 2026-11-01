-- Contract: the vocabulary aliases and the old capacity table go. One user and a drained queue make a rollback a
-- decision, not a constraint; expand/contract stays for migrations only.

-- The runner's word and time for a session's agent are `agent_status` and `agent_seen_at` (migration 010).
ALTER TABLE factory.sessions DROP COLUMN herdr_status;
ALTER TABLE factory.sessions DROP COLUMN herdr_seen_at;

-- `herdr_restarted` was renamed by migration 010. A release from before it that ran since may have written the old kind
-- again: convert such a row, and drop one whose new key already exists.
UPDATE factory.events e
SET kind = 'runner_restarted', session = '_runner', key = 'runner_restarted' || substr(e.key, length('herdr_restarted') + 1)
WHERE e.kind = 'herdr_restarted'
  AND NOT EXISTS (
    SELECT 1 FROM factory.events x
    WHERE x.key = 'runner_restarted' || substr(e.key, length('herdr_restarted') + 1));
DELETE FROM factory.events WHERE kind = 'herdr_restarted';
ALTER TABLE factory.events DROP CONSTRAINT events_kind_check;
ALTER TABLE factory.events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'session_started', 'turn_started', 'turn_ended', 'limit_stop', 'quota_resume', 'prompt_blocked', 'prompt_idle',
  'session_ended', 'wait_declared', 'wait_cleared', 'runner_restarted', 'pane_gone'));

-- The server identity migration 010 copied under its new name.
DELETE FROM factory.witness WHERE name = 'herdr_server';

-- Replaced by `quota_readings` (migration 004); nothing feeds it any more.
DROP TABLE factory.capacity_readings;

-- A session no spawn describes took its tab from the classic `HERDR_TAB_ID`; the hook no longer reports one, and a pane it
-- moves to would keep the old tab.
UPDATE factory.sessions SET tab = NULL WHERE spawn_key IS NULL;
