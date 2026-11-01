-- F2 Wave 1: Issues, the inbox and the one writer (docs/design.md §4, §12). Additive: a rollback to the previous release
-- ignores all of it.

-- What the factory knows of a repo. Wave 2 fills it from `project.yaml`; `name` is the slug `usage` shares (U4).
CREATE TABLE factory.projects (
  name         text PRIMARY KEY,
  repo         text NOT NULL,
  manifest     jsonb,
  make_targets jsonb,
  paused       boolean NOT NULL DEFAULT false,
  synced_at    timestamptz,
  created_at   timestamptz NOT NULL
);

-- `state` has one writer, `src/issues/lifecycle.ts`. `reason` says why a `waiting` Issue waits, `outcome` how a `closed` one
-- ended. `source` is open (a CHECK would make a new source a migration); `(source, source_key)` makes a replayed create one
-- Issue. `facts` is data, never instructions.
CREATE TABLE factory.issues (
  id         serial PRIMARY KEY,
  state      text NOT NULL CHECK (state IN ('settling', 'queued', 'working', 'waiting', 'watching', 'closed')),
  source     text NOT NULL,
  source_key text NOT NULL,
  repo       text NOT NULL,
  title      text NOT NULL,
  facts      jsonb NOT NULL,
  kind       text,
  class      text,
  parent     integer REFERENCES factory.issues (id),
  root_cause text,
  fix        text,
  summary    text,
  reason     text,
  outcome    text,
  attempt    integer NOT NULL DEFAULT 0,
  -- counts the ships: a regression and a second ship is a second hold of one attempt, and proof names the hold it is for
  hold       integer NOT NULL DEFAULT 0,
  wake_at    timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at  timestamptz,
  UNIQUE (source, source_key),
  CHECK ((state = 'waiting') = (reason IS NOT NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((state = 'closed') = (outcome IS NOT NULL))
);
CREATE INDEX issues_recent ON factory.issues (created_at DESC, id DESC);
CREATE INDEX issues_wake ON factory.issues (wake_at) WHERE wake_at IS NOT NULL;

CREATE TABLE factory.issue_deps (
  issue_id integer NOT NULL REFERENCES factory.issues (id),
  on_issue integer NOT NULL REFERENCES factory.issues (id),
  PRIMARY KEY (issue_id, on_issue)
);
CREATE INDEX issue_deps_on ON factory.issue_deps (on_issue);

-- Everything that concerns an Issue, one row per event under a unique key (§4's key table). `session` is set on a row
-- copied from a session event. `result` says what handling it did: applied, refused or ignored.
CREATE TABLE factory.issue_inbox (
  id         bigserial PRIMARY KEY,
  issue_id   integer NOT NULL REFERENCES factory.issues (id),
  key        text NOT NULL UNIQUE,
  kind       text NOT NULL,
  session    text,
  at         timestamptz NOT NULL,
  payload    jsonb,
  handled_at timestamptz,
  result     text CHECK (result IN ('applied', 'refused', 'ignored')),
  detail     text,
  -- the last failure of a handler that threw: the row stays unhandled and blocks only its own Issue
  error      text,
  CHECK ((handled_at IS NULL) = (result IS NULL))
);
CREATE INDEX issue_inbox_unhandled ON factory.issue_inbox (issue_id, at, id) WHERE handled_at IS NULL;

CREATE TABLE factory.issue_links (
  id         bigserial PRIMARY KEY,
  issue_id   integer NOT NULL REFERENCES factory.issues (id),
  -- F3 has no table yet to point a foreign key at
  signal_id  bigint,
  other_issue integer REFERENCES factory.issues (id),
  who        text NOT NULL,
  why        text,
  acted      boolean NOT NULL DEFAULT false,
  at         timestamptz NOT NULL
);
CREATE INDEX issue_links_issue ON factory.issue_links (issue_id);

-- §12's `events`: phases, notes, orchestrator actions, state changes. `factory.events` is the session event store since F1,
-- so this one carries the Issue's name. `key` is the inbox row that caused it (`created:<id>` for the first).
CREATE TABLE factory.issue_events (
  id         bigserial PRIMARY KEY,
  issue_id   integer NOT NULL REFERENCES factory.issues (id),
  key        text NOT NULL UNIQUE,
  kind       text NOT NULL,
  from_state text,
  to_state   text,
  at         timestamptz NOT NULL,
  payload    jsonb
);
CREATE INDEX issue_events_timeline ON factory.issue_events (issue_id, at, id);

-- What a transition asks of the world, written in its transaction; a port does it after the commit. `key` is
-- `<effect>:<inbox key>`, so a replay finds it. `done_at` is set after the port answered.
CREATE TABLE factory.issue_effects (
  id         bigserial PRIMARY KEY,
  issue_id   integer NOT NULL REFERENCES factory.issues (id),
  key        text NOT NULL UNIQUE,
  kind       text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  error      text,
  done_at    timestamptz
);
CREATE INDEX issue_effects_open ON factory.issue_effects (id) WHERE done_at IS NULL;

CREATE TABLE factory.decisions (
  id             bigserial PRIMARY KEY,
  issue_id       integer NOT NULL REFERENCES factory.issues (id),
  key            text NOT NULL UNIQUE,
  question       text NOT NULL,
  options        jsonb,
  default_option text,
  expires_at     timestamptz,
  answer         text,
  answered_by    text,
  answered_at    timestamptz,
  created_at     timestamptz NOT NULL
);
CREATE INDEX decisions_open ON factory.decisions (issue_id) WHERE answered_at IS NULL;

CREATE TABLE factory.evidence (
  id       bigserial PRIMARY KEY,
  issue_id integer NOT NULL REFERENCES factory.issues (id),
  kind     text NOT NULL,
  link     text,
  payload  jsonb,
  at       timestamptz NOT NULL,
  author   text NOT NULL
);
CREATE INDEX evidence_issue ON factory.evidence (issue_id);

-- The Issue a session works on; a session with one has its events copied into the inbox.
ALTER TABLE factory.sessions ADD COLUMN issue_id integer REFERENCES factory.issues (id);
CREATE INDEX sessions_issue ON factory.sessions (issue_id) WHERE issue_id IS NOT NULL;
