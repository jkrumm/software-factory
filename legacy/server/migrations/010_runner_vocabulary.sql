-- The runner is herdr-core, not herdr: the factory's own vocabulary stops naming a product. Expand only, so a rollback to
-- the previous release still starts on this schema.

-- What the runner last said about a session's agent. The old columns stay and the witness keeps writing both for one
-- release (a rollback reads the old ones); drop them, and this sentence, in the release after.
ALTER TABLE factory.sessions ADD COLUMN agent_status text;
ALTER TABLE factory.sessions ADD COLUMN agent_seen_at timestamptz;
UPDATE factory.sessions SET agent_status = herdr_status, agent_seen_at = herdr_seen_at;

-- `herdr_restarted` is `runner_restarted`, filed under `_runner`. Both kinds are allowed for one release: the previous
-- release still writes the old one if it is rolled back to.
ALTER TABLE factory.events DROP CONSTRAINT events_kind_check;
ALTER TABLE factory.events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'session_started', 'turn_started', 'turn_ended', 'limit_stop', 'quota_resume', 'prompt_blocked', 'prompt_idle',
  'session_ended', 'wait_declared', 'wait_cleared', 'herdr_restarted', 'runner_restarted', 'pane_gone'));
UPDATE factory.events
SET kind = 'runner_restarted', session = '_runner', key = 'runner_restarted' || substr(key, length('herdr_restarted') + 1)
WHERE kind = 'herdr_restarted';

-- The server identity the witness carries. The value is copied as it is; its format changed (`pid@start time` became
-- `pid@core id`), which the witness knows how to read: the first pass after the change records no restart.
INSERT INTO factory.witness (name, value, at)
SELECT 'runner_server', value, at FROM factory.witness WHERE name = 'herdr_server'
ON CONFLICT (name) DO NOTHING;
