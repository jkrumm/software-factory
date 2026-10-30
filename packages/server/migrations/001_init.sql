CREATE TABLE factory.events (
  id      bigserial PRIMARY KEY,
  key     text NOT NULL UNIQUE,
  session text NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('session_started', 'turn_started', 'turn_ended', 'limit_stop', 'session_ended')),
  at      timestamptz NOT NULL,
  payload jsonb
);
CREATE INDEX events_session_order ON factory.events (session, at, id);

CREATE TABLE factory.capacity_readings (
  id             bigserial PRIMARY KEY,
  account        text NOT NULL,
  weekly_used    double precision NOT NULL,
  five_hour_used double precision NOT NULL,
  resets_at      timestamptz NOT NULL
);
CREATE INDEX capacity_readings_latest ON factory.capacity_readings (account, id DESC);

-- queued:   assigned to an account, starts on the next tick
-- waiting:  no capacity; due again at resume_at, or when a new reading arrives
-- starting: claimed by a tick, the Runner call is in flight; reclaimed once claimed_at is older than the lease
CREATE TABLE factory.spawns (
  key        text PRIMARY KEY,
  repo       text NOT NULL,
  prompt     text NOT NULL,
  status     text NOT NULL CHECK (status IN ('queued', 'waiting', 'starting', 'started', 'failed')),
  account    text,
  -- the reading the account was chosen against: assignments made against the account's current reading are not in it yet
  reading_id bigint,
  resume_at  timestamptz,
  claimed_at timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  session    text,
  error      text,
  created_at timestamptz NOT NULL
);
CREATE INDEX spawns_pending ON factory.spawns (created_at) WHERE status IN ('queued', 'waiting', 'starting');
