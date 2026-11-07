-- Capacity's tables: what the accounts' windows said, who sits where, which account each lead was admitted on, the
-- queue states and the test slots.

-- Every poll of the account picker is a fact. Percentages are of the window; null is "no sample".
CREATE TABLE factory.capacity_readings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account text NOT NULL,
  read_at timestamptz NOT NULL,
  sampled_at timestamptz,
  enabled boolean NOT NULL,
  auth_ok boolean NOT NULL,
  five_hour_used double precision,
  weekly_used double precision,
  five_hour_resets_at timestamptz,
  weekly_resets_at timestamptz,
  exhausted_until timestamptz
);

CREATE INDEX capacity_readings_by_account ON factory.capacity_readings (account, id DESC);

-- A lead's claim in its repo, with the account it runs on. An Issue holds one while its lead works; a wait that needs a
-- person or a clock gives it back, and the lead takes one again before it is told its wait is over.
CREATE TABLE factory.capacity_claims (
  issue_id text PRIMARY KEY REFERENCES factory.issues (id),
  repo text NOT NULL,
  urgent boolean NOT NULL,
  account text,
  taken_at timestamptz NOT NULL
);

CREATE INDEX capacity_claims_by_repo ON factory.capacity_claims (repo);

-- The account each attempt was admitted on: package 4's start_lead reads it.
CREATE TABLE factory.capacity_assignments (
  issue_id text NOT NULL REFERENCES factory.issues (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  account text NOT NULL,
  repo text NOT NULL,
  assigned_at timestamptz NOT NULL,
  PRIMARY KEY (issue_id, attempt)
);

CREATE INDEX capacity_assignments_by_account ON factory.capacity_assignments (account, assigned_at);

-- `run`, `pace` or `drain` per scope: the whole queue (project null) or one project. No row is `run`.
CREATE TABLE factory.capacity_queue_states (
  project text PRIMARY KEY DEFAULT '',
  state text NOT NULL CHECK (state IN ('run', 'pace', 'drain')),
  set_at timestamptz NOT NULL
);

-- The host's test slots: a semaphore with leases. A holder that stops renewing loses its slot at the next call of anyone.
CREATE TABLE factory.capacity_slots (
  id text PRIMARY KEY,
  name text NOT NULL,
  requested_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL,
  slot integer CHECK (slot >= 1),
  leased_until timestamptz,
  granted_at timestamptz,
  run_ms integer
);
