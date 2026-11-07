-- Intake's tables: the signals it stored, the episodes and fingerprints of what it filed, incidents, the heal rules'
-- pending downs, and the door's registry. Intake owns these; it never alters another domain's table. An Issue is named
-- by its id as text, with no foreign key: the work domain owns `factory.issues`.

-- Every signal that was stored: held ones (quarantine) and the ones that became or joined an Issue. A source's own
-- event has a deterministic key (a replay stores nothing twice); a person's has none and replays through its fingerprint.
CREATE TABLE factory.intake_signals (
  id text PRIMARY KEY,
  key text UNIQUE,
  source text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('alert', 'request', 'feedback', 'remark')),
  origin text NOT NULL CHECK (origin IN ('you', 'application', 'infrastructure', 'github', 'feedback', 'factory')),
  trust text NOT NULL CHECK (trust IN ('owner', 'machine', 'agent', 'outside')),
  repo text,
  fingerprint text NOT NULL,
  title text NOT NULL,
  text text NOT NULL,
  link text,
  made_by text,
  -- the source's detail: subject, event, status, facts
  alert jsonb,
  received_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('held', 'filed', 'amended', 'incident', 'promoted')),
  issue_id text,
  CHECK ((state IN ('filed', 'amended', 'incident', 'promoted')) = (issue_id IS NOT NULL))
);

CREATE INDEX intake_signals_held ON factory.intake_signals (received_at) WHERE state = 'held';
CREATE INDEX intake_signals_by_issue ON factory.intake_signals (issue_id) WHERE issue_id IS NOT NULL;

-- One row per (Issue, subject): an episode of a stateful source (down until its up), or the fingerprint of a stateless
-- one. An incident's Issue has one row per alert that joined it.
CREATE TABLE factory.intake_subjects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,
  subject text NOT NULL,
  fingerprint text,
  issue_id text NOT NULL,
  group_key text,
  filed_at timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  repeats integer NOT NULL DEFAULT 0 CHECK (repeats >= 0),
  up_at timestamptz,
  writeback boolean NOT NULL DEFAULT false,
  admitted text,
  UNIQUE (issue_id, source, subject)
);

CREATE INDEX intake_subjects_latest ON factory.intake_subjects (source, subject, id DESC);
CREATE INDEX intake_subjects_fingerprint ON factory.intake_subjects (source, fingerprint, id DESC) WHERE fingerprint IS NOT NULL;
CREATE INDEX intake_subjects_by_issue ON factory.intake_subjects (issue_id);

-- The incident an Issue of kind incident is: alerts on one host or dependency join it while it takes alerts.
CREATE TABLE factory.intake_incidents (
  issue_id text PRIMARY KEY,
  group_key text NOT NULL,
  opened_at timestamptz NOT NULL,
  last_alert_at timestamptz NOT NULL
);

CREATE INDEX intake_incidents_by_group ON factory.intake_incidents (group_key, opened_at DESC);

-- A settled event key is remembered for a week, so a late retry of a `down` that already healed opens no second row.
CREATE TABLE factory.intake_seen (
  key text PRIMARY KEY,
  seen_at timestamptz NOT NULL
);

-- A `down` waiting out its project's heal rule: the grace, the runbook's results, one row per subject.
CREATE TABLE factory.intake_pending (
  source text NOT NULL,
  subject text NOT NULL,
  repo text NOT NULL,
  received jsonb NOT NULL,
  rule jsonb NOT NULL,
  opened_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (source, subject)
);

CREATE INDEX intake_pending_due ON factory.intake_pending (due_at);

-- What the Issue's closing told GitHub; one answer per Issue.
CREATE TABLE factory.intake_writebacks (
  issue_id text PRIMARY KEY,
  result text NOT NULL,
  at timestamptz NOT NULL
);

-- The door's registry: which repo a monitor's alerts file in. The owner's estate, not git's.
CREATE TABLE factory.intake_door_routes (
  source text NOT NULL,
  monitor text NOT NULL,
  repo text NOT NULL,
  quiet integer NOT NULL DEFAULT 0,
  last_quiet_at timestamptz,
  last_event text,
  PRIMARY KEY (source, monitor)
);

-- A monitor that alerted with no route: counted, and filed once when it stays down.
CREATE TABLE factory.intake_door_unrouted (
  source text NOT NULL,
  monitor text NOT NULL,
  count integer NOT NULL,
  last_seen timestamptz NOT NULL,
  last_title text NOT NULL,
  last_event text NOT NULL,
  status text CHECK (status IN ('down', 'up')),
  down_since timestamptz,
  is_group boolean NOT NULL DEFAULT false,
  filed_at timestamptz,
  filed_issue text,
  PRIMARY KEY (source, monitor)
);

-- What the door says about its sources: refusals (a stale token) and the last message it accepted.
CREATE TABLE factory.intake_door_sources (
  source text PRIMARY KEY,
  first_seen timestamptz NOT NULL,
  last_accepted timestamptz,
  refused integer NOT NULL DEFAULT 0,
  refused_since timestamptz,
  last_refused timestamptz
);
