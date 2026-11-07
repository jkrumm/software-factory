-- The loops' own table: every ask of an agw workflow (the steward's and triage's), so a replayed pass acts on the stored
-- answer and never asks twice. Facts are stored, state is derived: whether a subject was answered, is in flight, is
-- backing off or has used its rounds is read from these rows, never kept as a column.

CREATE TABLE factory.loop_calls (
  -- the idempotency key of the agw run
  key text PRIMARY KEY,
  loop text NOT NULL CHECK (loop IN ('steward', 'triage')),
  issue_id text NOT NULL REFERENCES factory.issues (id),
  -- what the call is about: `wait:<version>` for a stall, `settle` for an Issue settling
  subject text NOT NULL,
  round integer NOT NULL CHECK (round >= 1),
  claimed_at timestamptz NOT NULL,
  -- a claimed call is held until then; a server that died lets it go by itself
  lease_until timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('answered', 'rejected', 'failed')),
  answer jsonb,
  detail text,
  finished_at timestamptz,
  UNIQUE (loop, issue_id, subject, round),
  CHECK ((outcome IS NULL) = (finished_at IS NULL))
);

CREATE INDEX loop_calls_by_issue ON factory.loop_calls (issue_id, loop, subject, round);
