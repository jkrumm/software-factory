-- The leads domain's tables: an attempt's lead as the factory started and follows it, the hook events its session
-- reports, what was typed into it, the send-backs, and what finalizing an attempt has done. Every row is a fact; a
-- session's state, a count of turns and "gone" are derived when read. `issue_id` is the work domain's id (no foreign
-- key: the domains own their tables apart).

-- One row per attempt, filled in as the start proceeds: first the worktree, then the terminal. The first try's time
-- starts the start budget, and the tries are counted.
CREATE TABLE factory.lead_attempts (
  issue_id text NOT NULL CHECK (issue_id ~ '^issue_[1-9][0-9]*$'),
  attempt integer NOT NULL CHECK (attempt >= 1),
  branch text NOT NULL,
  account text,
  repo_path text,
  worktree_path text,
  -- the commit the worktree was cut from
  base_sha text,
  terminal text,
  tab text,
  space text,
  first_try_at timestamptz NOT NULL,
  tries integer NOT NULL DEFAULT 1 CHECK (tries >= 1),
  started_at timestamptz,
  -- the lead is gone: its terminal was lost or its start failed for good
  gone_at timestamptz,
  PRIMARY KEY (issue_id, attempt)
);

-- Hook events, from the socket and from the spool. The key is session, event name and turn number: a replay is the
-- same row. `seq` is the order of arrival, which breaks a tie in `at`.
CREATE TABLE factory.lead_hook_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE,
  session text NOT NULL,
  issue_id text NOT NULL,
  attempt integer NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX lead_hook_events_by_session ON factory.lead_hook_events (session, at, seq);

-- What was typed into a lead: its brief, and the notes of `note_lead`. The key is the effect's, so a replay finds the
-- claim. `typed_at` is null while the typing is unconfirmed.
CREATE TABLE factory.lead_deliveries (
  key text PRIMARY KEY,
  issue_id text NOT NULL,
  attempt integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('brief', 'note')),
  text text NOT NULL,
  claimed_at timestamptz NOT NULL,
  typed_at timestamptz,
  -- typed into a working agent, which queues it for its next turn
  forced boolean NOT NULL DEFAULT false
);

CREATE INDEX lead_deliveries_by_attempt ON factory.lead_deliveries (issue_id, attempt);

-- A turn is sent back once: sendback:<session>:<turn>.
CREATE TABLE factory.lead_sendbacks (
  key text PRIMARY KEY,
  issue_id text NOT NULL,
  attempt integer NOT NULL,
  turn integer NOT NULL,
  at timestamptz NOT NULL
);

-- Finalize once per attempt: each step is a fact, so a crash between two steps replays to one of each.
CREATE TABLE factory.lead_finalizations (
  issue_id text NOT NULL,
  attempt integer NOT NULL,
  claim_at timestamptz,
  terminals_at timestamptz,
  transcripts_at timestamptz,
  worktree_at timestamptz,
  archived integer NOT NULL DEFAULT 0,
  -- why the worktree was kept (work not on the base, uncommitted changes) and where it is
  worktree_kept text,
  worktree_path text,
  done_at timestamptz,
  PRIMARY KEY (issue_id, attempt)
);
