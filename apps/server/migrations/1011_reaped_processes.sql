-- What the reaper ended: one row per signal sent to a process of a closed lead attempt (`dry`: decided, nothing sent).
-- Kept 30 days. The session is the attempt's key (`lead-<issue>-<attempt>`); the reason is `session` or `worktree`.
CREATE TABLE factory.reaped_processes (
  at       timestamptz NOT NULL,
  pid      integer     NOT NULL,
  session  text        NOT NULL,
  worktree text,
  comm     text        NOT NULL,
  signal   text        NOT NULL CHECK (signal IN ('SIGTERM', 'SIGKILL', 'dry')),
  reason   text        NOT NULL CHECK (reason IN ('session', 'worktree')),
  age_s    integer     NOT NULL
);
CREATE INDEX reaped_processes_at ON factory.reaped_processes (at DESC);
