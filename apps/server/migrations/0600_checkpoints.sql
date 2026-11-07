-- The checkpoints domain: Decisions with the path to their answer, artifacts with revisions, annotations and verdicts,
-- Errands, and the pages on the owner's line. Facts are stored, state is derived: a Decision is open, answered or
-- withdrawn by what its columns say, an annotation is anchored or "Unanchored" by reading the revision, and when a
-- default is due is the time it was asked plus its wait.

CREATE TABLE factory.decisions (
  id text PRIMARY KEY CHECK (id ~ '^decision_'),
  -- deterministic from the ask (Issue, attempt, question): the same ask twice is one Decision
  key text NOT NULL UNIQUE,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  repo text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  question text NOT NULL,
  recommendation text NOT NULL,
  checked text NOT NULL,
  -- [{ label, reversible, cost }]
  options jsonb NOT NULL,
  -- { consequence, default, waitMinutes }
  no_answer jsonb NOT NULL,
  asked_at timestamptz NOT NULL,
  answer text,
  settled_by text CHECK (settled_by IN ('policy', 'judge', 'default', 'owner')),
  source text,
  answered_at timestamptz,
  -- the Issue stopped waiting for it (closed, cancelled): a withdrawn Decision is on no list of open work
  withdrawn_at timestamptz,
  withdrawn_reason text,
  -- the owner's flag on an answered Decision; null while he has not said
  worth_asking boolean,
  CHECK ((answer IS NULL) = (settled_by IS NULL) AND (answer IS NULL) = (answered_at IS NULL)),
  CHECK (answered_at IS NULL OR withdrawn_at IS NULL),
  CHECK (worth_asking IS NULL OR answered_at IS NOT NULL)
);

CREATE INDEX decisions_open ON factory.decisions (asked_at) WHERE answered_at IS NULL AND withdrawn_at IS NULL;
CREATE INDEX decisions_by_issue ON factory.decisions (issue_id, asked_at);
-- the Judge's precedent lookup: Postgres text search over the question
CREATE INDEX decisions_question_search ON factory.decisions USING gin (to_tsvector('english', question));

-- The path to an answer: one row per step tried (policy, judge, default, owner). A step with a call is claimed first
-- (claimed_until), then recorded; a row with no outcome is a call in flight.
CREATE TABLE factory.decision_steps (
  decision_id text NOT NULL REFERENCES factory.decisions (id),
  step text NOT NULL CHECK (step IN ('policy', 'judge', 'default', 'owner')),
  claimed_until timestamptz,
  outcome text CHECK (outcome IN ('answered', 'passed', 'rejected', 'failed', 'open')),
  detail text,
  at timestamptz,
  PRIMARY KEY (decision_id, step),
  CHECK ((outcome IS NULL) = (at IS NULL))
);

-- One model, four kinds. A Decision is an artifact too: its id is the Decision's id, revision 1 its form.
CREATE TABLE factory.artifacts (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  kind text NOT NULL CHECK (kind IN ('concept', 'spec', 'decision', 'report')),
  title text NOT NULL,
  format text NOT NULL CHECK (format IN ('markdown', 'html')),
  author text NOT NULL CHECK (author IN ('lead', 'factory')),
  created_at timestamptz NOT NULL
);

CREATE INDEX artifacts_by_issue ON factory.artifacts (issue_id, created_at);

-- The content is a blob under the data directory (never in git); the row names it and its hash.
CREATE TABLE factory.artifact_revisions (
  artifact_id text NOT NULL REFERENCES factory.artifacts (id),
  n integer NOT NULL CHECK (n >= 1),
  key text NOT NULL UNIQUE,
  blob text NOT NULL,
  sha256 text NOT NULL,
  bytes integer NOT NULL,
  note text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (artifact_id, n)
);

-- Anchored by a quote and a path on the revision it was made on; whether the quote is still there is read, not stored.
CREATE TABLE factory.annotations (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  artifact_id text NOT NULL,
  revision integer NOT NULL,
  quote text NOT NULL,
  path text,
  comment text NOT NULL,
  author text NOT NULL CHECK (author IN ('owner', 'lead')),
  at timestamptz NOT NULL,
  FOREIGN KEY (artifact_id, revision) REFERENCES factory.artifact_revisions (artifact_id, n)
);

CREATE INDEX annotations_by_artifact ON factory.annotations (artifact_id, at);

-- The owner's verdict on a revision; the first one on a revision stands.
CREATE TABLE factory.verdicts (
  artifact_id text NOT NULL,
  revision integer NOT NULL,
  key text NOT NULL UNIQUE,
  verdict text NOT NULL CHECK (verdict IN ('looks_good', 'with_notes', 'changes', 'no_longer_applies')),
  note text,
  at timestamptz NOT NULL,
  PRIMARY KEY (artifact_id, revision),
  FOREIGN KEY (artifact_id, revision) REFERENCES factory.artifact_revisions (artifact_id, n)
);

CREATE TABLE factory.errands (
  id text PRIMARY KEY CHECK (id ~ '^errand_'),
  key text NOT NULL UNIQUE,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  summary text NOT NULL,
  detail text,
  raised_at timestamptz NOT NULL,
  done_at timestamptz,
  done_note text
);

CREATE INDEX errands_open ON factory.errands (raised_at) WHERE done_at IS NULL;

-- The owner's line: ntfy carries checkpoints only. The outbox of its own: the key is deterministic per checkpoint, so a
-- replay plans nothing twice, and a sent page is never sent again. A crash between a send and its record lets the lease
-- run out and the page goes again (at-least-once). A page is never given up on while its checkpoint is open: a failing
-- send backs off to 5 minutes and tries again, so a server started before ntfy is configured still tells the owner.
CREATE TABLE factory.checkpoint_pages (
  key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('decision', 'review', 'errand')),
  checkpoint text NOT NULL,
  issue_id text NOT NULL REFERENCES factory.issues (id),
  title text NOT NULL,
  body text NOT NULL,
  link text NOT NULL,
  planned_at timestamptz NOT NULL,
  not_before timestamptz,
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  cancelled_at timestamptz,
  error text
);

CREATE INDEX checkpoint_pages_due ON factory.checkpoint_pages (planned_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX checkpoint_pages_by_checkpoint ON factory.checkpoint_pages (checkpoint);
