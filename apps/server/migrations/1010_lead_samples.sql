-- What each lead's process tree cost, once a minute with the host sample (app/loops/host.ts): rows are kept 30 days, and
-- the grant rule and Improve learn a repo's lead from their per-attempt peaks. The worktree is the key: an attempt has one.
CREATE TABLE factory.lead_samples (
  at       timestamptz NOT NULL,
  worktree text        NOT NULL,
  repo     text        NOT NULL,
  issue    integer,
  attempt  integer,
  rss_mib  integer     NOT NULL,
  procs    integer     NOT NULL,
  PRIMARY KEY (at, worktree)
);
CREATE INDEX lead_samples_repo_at ON factory.lead_samples (repo, at DESC);

-- The capacity facts of that minute: leads running (claims held), Issues queued, the leads the accounts may hold, and
-- the load ceiling in force. Null when the minute could not read them.
ALTER TABLE factory.host_samples ADD COLUMN leads integer;
ALTER TABLE factory.host_samples ADD COLUMN queued integer;
ALTER TABLE factory.host_samples ADD COLUMN seats integer;
ALTER TABLE factory.host_samples ADD COLUMN load_ceiling double precision;
