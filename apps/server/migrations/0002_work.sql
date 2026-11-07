-- The work domain's tables: the Issue, its events, and the outbox of the effects its transitions plan.
-- Facts are stored, state is derived: an Issue's state, wait reason, outcome and version are the result of its applied
-- events, kept on the row because the version guards the write. Counts and times are read from issue_events.

CREATE TABLE factory.issues (
  id text PRIMARY KEY,
  -- the one repo it works in, from its filed event; never changes
  repo text NOT NULL,
  state text NOT NULL CHECK (state IN ('settling', 'queued', 'working', 'waiting', 'watching', 'closed')),
  wait_reason text CHECK (wait_reason IN (
    'timer', 'dependency', 'wall', 'unreported', 'blocked', 'lead_gone', 'regressed', 'decision', 'review', 'errand'
  )),
  outcome text CHECK (outcome IN ('done', 'dropped', 'healed', 'cancelled')),
  -- rises by one with every applied event: UPDATE ... WHERE id = $1 AND version = $2
  version integer NOT NULL CHECK (version >= 1),
  CHECK ((state = 'waiting') = (wait_reason IS NOT NULL)),
  CHECK ((state = 'closed') = (outcome IS NOT NULL))
);

CREATE INDEX issues_open_by_state ON factory.issues (state, repo) WHERE state <> 'closed';

CREATE TABLE factory.issue_events (
  id text PRIMARY KEY,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  -- deterministic, across every Issue: the same event sent twice is stored once
  key text NOT NULL UNIQUE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  actor text NOT NULL CHECK (actor IN ('owner', 'lead', 'factory', 'steward', 'judge')),
  at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('applied', 'refused', 'ignored')),
  -- why it was refused or ignored
  detail text,
  -- the Issue version it produced; only an applied event produces one
  version integer,
  -- the state it found (null for filed, which makes the Issue) and, when applied, the transition it made
  from_state text,
  to_state text,
  wait jsonb,
  outcome text,
  causation text REFERENCES factory.issue_events (id),
  UNIQUE (issue_id, version),
  CHECK ((result = 'applied') = (version IS NOT NULL)),
  CHECK ((result = 'applied') = (to_state IS NOT NULL)),
  CHECK ((result = 'applied') = (detail IS NULL))
);

CREATE INDEX issue_events_by_issue ON factory.issue_events (issue_id, at);

-- The outbox: what an applied event asks the world to do, stored in its transaction. The runner claims an effect and
-- commits, calls the port, and records the result in a new transaction. The key makes a replay a no-op.
CREATE TABLE factory.issue_effects (
  key text PRIMARY KEY,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  event_id text NOT NULL REFERENCES factory.issue_events (id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  -- the version of the event that planned it, and its place among that event's effects: an Issue's effects run in this order
  version integer NOT NULL,
  position integer NOT NULL,
  planned_at timestamptz NOT NULL,
  -- a failed effect waits until then
  not_before timestamptz,
  -- a runner holds it until then; a runner that died lets it go by itself
  claimed_until timestamptz,
  done_at timestamptz,
  -- a close cancels what a closed Issue no longer wants
  cancelled_at timestamptz
);

CREATE INDEX issue_effects_open ON factory.issue_effects (issue_id, version, position)
  WHERE done_at IS NULL AND cancelled_at IS NULL;

-- Every call of an effect's port, as it ended: the failures are counted from here.
CREATE TABLE factory.issue_effect_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  effect_key text NOT NULL REFERENCES factory.issue_effects (key),
  at timestamptz NOT NULL,
  ok boolean NOT NULL,
  error_kind text CHECK (error_kind IN ('timeout', 'gone', 'refused', 'unreadable')),
  detail text,
  CHECK (ok = (error_kind IS NULL))
);

CREATE INDEX issue_effect_runs_by_effect ON factory.issue_effect_runs (effect_key);
