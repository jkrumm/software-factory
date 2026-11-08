-- The hygiene loop's record: one row per full pass over one project. Whether a project is due is read from its newest `at`,
-- never kept in the runner's memory, so a restart or a deploy does not reset the week. `report` is the sweep as it was
-- (probe runs, findings, the documents picked for a read), `judgment` what `factory-hygiene` made of it, `filed` the
-- signals filed, `over_budget` the findings the pass's cap left out, `failed` the ones intake refused.

CREATE TABLE factory.hygiene_passes (
  id text PRIMARY KEY,
  repo text NOT NULL,
  at timestamptz NOT NULL,
  -- the commit swept (full sha)
  ref text NOT NULL,
  -- { ref, runs, findings, stale, slop }
  report jsonb NOT NULL,
  -- { outcome: answered | failed | skipped, attempts, judgedAt, reason, findings }
  judgment jsonb NOT NULL,
  -- [{ key, title }]
  filed jsonb NOT NULL,
  -- [{ key, title }]
  over_budget jsonb NOT NULL,
  -- [{ key, reason }]
  failed jsonb NOT NULL
);

CREATE INDEX hygiene_passes_by_repo ON factory.hygiene_passes (repo, at);
