-- A lead whose Issue waits past the quiesce threshold has its `claude` ended; the attempt keeps its worktree and session and
-- the wake starts the session again (`app/leads-quiesce.ts`). `dormant_at` marks the dormant attempt; `revive_tries` counts the
-- resumes that failed since, so a third failure takes the lost-lead path.
ALTER TABLE factory.lead_attempts
  ADD COLUMN dormant_at timestamptz,
  ADD COLUMN revive_tries integer NOT NULL DEFAULT 0;
