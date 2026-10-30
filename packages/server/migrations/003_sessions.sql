-- More kinds of event: the hooks' (quota_resume, prompt_*), declared waits, and what the witness sees of herdr.
ALTER TABLE factory.events DROP CONSTRAINT events_kind_check;
ALTER TABLE factory.events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'session_started', 'turn_started', 'turn_ended', 'limit_stop', 'quota_resume', 'prompt_blocked', 'prompt_idle',
  'session_ended', 'wait_declared', 'wait_cleared', 'herdr_restarted', 'pane_gone'));

-- What the factory knows about a session it can name: `id` is FACTORY_SESSION, the spawn key or the name `rd` gave the
-- pane. `usage` owns the session entity for every lane; this row is what the factory started or follows, and the two
-- join on claude_session_id. State is never a column: it is derived from `events` when read.
CREATE TABLE factory.sessions (
  id                  text PRIMARY KEY,
  spawn_key           text,
  pane                text,
  claude_session_id   text,
  transcript_path     text,
  cwd                 text,
  -- the time of the session_started the three fields above came from: an older one delivered late does not overwrite
  bound_at            timestamptz,
  created_at          timestamptz NOT NULL,
  -- what the witness last saw of the agent in herdr
  herdr_status        text,
  herdr_seen_at       timestamptz,
  -- consecutive witness passes in which no herdr agent matched; two make the pane gone
  pane_misses         integer NOT NULL DEFAULT 0,
  worktree_changed_at timestamptz
);
CREATE INDEX sessions_claude_session ON factory.sessions (claude_session_id);

-- Rows for what is already known.
INSERT INTO factory.sessions (id, created_at)
SELECT session, min(at) FROM factory.events GROUP BY session
ON CONFLICT (id) DO NOTHING;
INSERT INTO factory.sessions (id, spawn_key, pane, created_at)
SELECT key, key, session, created_at FROM factory.spawns WHERE status = 'started'
ON CONFLICT (id) DO UPDATE SET spawn_key = EXCLUDED.spawn_key, pane = EXCLUDED.pane;

-- Single facts the witness carries from one pass to the next (herdr's server process).
CREATE TABLE factory.witness (
  name  text PRIMARY KEY,
  value text NOT NULL,
  at    timestamptz NOT NULL
);
