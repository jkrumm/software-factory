CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  session    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('session_started', 'turn_started', 'turn_ended', 'limit_stop', 'session_ended')),
  at         timestamptz NOT NULL,
  payload    jsonb
);
CREATE INDEX events_session_order ON events (session, at, id);

CREATE TABLE capacity_readings (
  id             bigserial PRIMARY KEY,
  account        text NOT NULL,
  weekly_used    double precision NOT NULL,
  five_hour_used double precision NOT NULL,
  resets_at      timestamptz NOT NULL
);
CREATE INDEX capacity_readings_latest ON capacity_readings (account, id DESC);

CREATE TABLE spawns (
  key        text PRIMARY KEY,
  repo       text NOT NULL,
  prompt     text NOT NULL,
  status     text NOT NULL CHECK (status IN ('queued', 'waiting', 'started', 'failed')),
  account    text,
  resume_at  timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  session    text,
  error      text,
  created_at timestamptz NOT NULL
);
CREATE INDEX spawns_pending ON spawns (created_at) WHERE status IN ('queued', 'waiting');
