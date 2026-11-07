-- Planning's tables: the projects the factory has read, the chain between Issues, the owner's priorities and the plan
-- rows that became Issues. Facts are stored, state is derived: a row's state (done, open, filable, waiting) and an
-- Issue's place in the queue are computed from these and from the Issues, never stored.

CREATE TABLE factory.planning_projects (
  -- the repo directory's name; `<name>~<hash>` for a second directory of that name
  name text PRIMARY KEY,
  repo text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source IN ('file', 'defaults')),
  -- the project in force, defaults filled in
  project jsonb NOT NULL,
  project_sha text,
  -- the content now on the default branch does not parse; `project` is the last valid one
  project_error jsonb,
  plan jsonb,
  plan_sha text,
  plan_error jsonb,
  plan_warnings jsonb NOT NULL DEFAULT '[]',
  branch text,
  synced_at timestamptz
);

-- The chain: `issue` runs only after `after_issue` has closed, in any outcome. An edge is satisfied once, when its
-- blocker is seen closed; a blocker that reopens holds nobody back.
CREATE TABLE factory.planning_edges (
  issue_id text NOT NULL REFERENCES factory.issues (id),
  after_issue text NOT NULL REFERENCES factory.issues (id),
  created_at timestamptz NOT NULL,
  satisfied_at timestamptz,
  PRIMARY KEY (issue_id, after_issue),
  CHECK (issue_id <> after_issue)
);

CREATE INDEX planning_edges_open ON factory.planning_edges (after_issue) WHERE satisfied_at IS NULL;

-- The owner's priority of an Issue: an append-only log, the latest by (at, id) is the Issue's `prio`; none is 0. Nothing
-- but the owner's own verb writes it, and nothing overrides it.
CREATE TABLE factory.planning_prios (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  value integer NOT NULL CHECK (value BETWEEN -1000 AND 1000),
  actor text NOT NULL,
  at timestamptz NOT NULL
);

CREATE INDEX planning_prios_by_issue ON factory.planning_prios (issue_id, at DESC, id DESC);

-- The Issue a plan row became: written in the transaction that files it, so a row is filed once.
CREATE TABLE factory.planning_filed_rows (
  project text NOT NULL,
  row_key text NOT NULL,
  issue_id text NOT NULL UNIQUE REFERENCES factory.issues (id),
  filed_at timestamptz NOT NULL,
  PRIMARY KEY (project, row_key)
);
