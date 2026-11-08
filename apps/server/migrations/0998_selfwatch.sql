-- The self-watch loop's memory: one row per subject (kind + ':' + subject) it has seen. A subject is filed once; while its
-- row is open and the evidence is the same nothing is filed again, a changed evidence hash files once more under the same
-- title (intake's repeat path amends the open Issue), and a subject the pass no longer sees is cleared. Expand only: a new
-- table, nothing else touched. (The runner holds the migration advisory lock around this file.)

CREATE TABLE factory.selfwatch_findings (
  subject_key text PRIMARY KEY,
  kind text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  -- sha256 of the finding's stable evidence lines: the facts, never the clock
  evidence_hash text NOT NULL,
  last_filed_at timestamptz NOT NULL,
  -- the intake signal the last filing made; null when intake gave none
  signal_id text,
  -- set when the condition stopped holding; a later reappearance files anew
  cleared_at timestamptz
);
