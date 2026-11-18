-- What a lead's worktree takes on disk, the checkout and its build output together (docs/decisions.md, NL48): measured while the
-- attempt runs by the host loop (`du` of the worktree, at most every ten minutes), one row per worktree holding its largest
-- size. Admission learns a repo's footprint from the newest attempts' sizes (`domains/capacity/disk.ts`) and starts a lead only
-- when the free disk less the headroom holds it, so a disk reason needs no static `leads:` cap. Rows are kept 30 days.
CREATE TABLE factory.worktree_sizes (
  worktree    text        PRIMARY KEY,
  repo        text        NOT NULL,
  issue       integer,
  attempt     integer,
  mib         integer     NOT NULL,
  measured_at timestamptz NOT NULL
);
CREATE INDEX worktree_sizes_repo_at ON factory.worktree_sizes (repo, measured_at DESC);
