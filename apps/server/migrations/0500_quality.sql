-- The quality domain's tables: what a ship was checked against, the evidence it left, and the watch after it.
-- Facts are stored, state is derived: a watch's retry count and next check are read from its checks, never kept.

-- Every ship the gate looked at, accepted or refused. A refusal is a fact too (friction counts it); a lead that
-- ships again after one makes a new row. `event_key` is the key of the `shipped` event the call stands for, so the
-- same call twice is one accepted row.
CREATE TABLE factory.quality_ships (
  id text PRIMARY KEY,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  event_key text NOT NULL,
  at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('accepted', 'refused')),
  -- the verb's error when refused: the gate's, or the machine's
  detail text,
  -- the commits the lead named, as it named them
  reported jsonb NOT NULL,
  CHECK ((result = 'refused') = (detail IS NOT NULL))
);

CREATE UNIQUE INDEX quality_ships_accepted_once ON factory.quality_ships (event_key) WHERE result = 'accepted';
CREATE INDEX quality_ships_by_issue ON factory.quality_ships (issue_id, at);

-- What an accepted ship proved: its merged commits, and its review when there was one (its absence is a row too, with
-- the reason). What verify found is in `quality_checks`.
CREATE TABLE factory.quality_evidence (
  id text PRIMARY KEY,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  -- the ship (`quality_ships.event_key`) this belongs to
  source_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('commits', 'review')),
  at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (source_key, kind)
);

CREATE INDEX quality_evidence_by_issue ON factory.quality_evidence (issue_id, at);

-- One watch per ship, opened by the `start_watch` effect (its key). `window_ms` is the project's setting as it stood
-- when the watch began. `answer` is how it ended: `passed` and `regressed` are the events it recorded on the Issue,
-- `ended` is a watch whose Issue had moved on (cancelled) before verify ran.
CREATE TABLE factory.quality_watches (
  key text PRIMARY KEY,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  watch integer NOT NULL CHECK (watch >= 1),
  started_at timestamptz NOT NULL,
  window_ms bigint NOT NULL CHECK (window_ms >= 0),
  -- a check holds the watch until then; a server that died lets it go by itself
  claimed_until timestamptz,
  answer text CHECK (answer IN ('passed', 'regressed', 'ended')),
  answered_at timestamptz,
  UNIQUE (issue_id, watch),
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);

CREATE INDEX quality_watches_open ON factory.quality_watches (started_at) WHERE answer IS NULL;

-- Every run of verify, as it ended. `red` is not yet an answer: the watch retries before it regresses.
CREATE TABLE factory.quality_checks (
  watch_key text NOT NULL REFERENCES factory.quality_watches (key),
  n integer NOT NULL CHECK (n >= 1),
  at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('green', 'red', 'blocked')),
  checks jsonb NOT NULL,
  PRIMARY KEY (watch_key, n)
);
