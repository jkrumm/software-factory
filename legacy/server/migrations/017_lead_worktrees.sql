-- F2 Wave 3 review: a lead's worktree is made off the tick (git fetch and wtp can take minutes), one row per Issue and attempt,
-- written before the work starts. `pending` is due at `next_at` (a failed try backs off), `making` is in flight (a row left `making`
-- by a process that died is tried again), `made` has its `path`, `failed` is past the retry budget counted from `first_at`.
-- Additive: a rollback to the previous release ignores it.
CREATE TABLE factory.lead_worktrees (
  issue_id integer NOT NULL REFERENCES factory.issues (id),
  attempt  integer NOT NULL,
  status   text NOT NULL CHECK (status IN ('pending', 'making', 'made', 'failed')),
  path     text,
  base     text,
  sha      text,
  tries    integer NOT NULL DEFAULT 0,
  first_at timestamptz NOT NULL,
  next_at  timestamptz NOT NULL,
  error    text,
  PRIMARY KEY (issue_id, attempt)
);
