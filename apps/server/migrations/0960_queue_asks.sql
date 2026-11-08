-- The queue loop's record: every ask of `factory-queue` about one shape of a repo's queue. The shape is a fingerprint of
-- what the answer depends on (the queued Issues, their priority and blockers, the running Issues), so the same shape is
-- asked once; `after_shape` is the shape the edges left behind, so an edge the loop made does not ask again. Whether a repo
-- may be asked now is read from the newest `claimed_at`, never kept in memory. Facts are stored, state is derived.

CREATE TABLE factory.queue_asks (
  -- the idempotency key of the agw run
  key text PRIMARY KEY,
  repo text NOT NULL,
  shape text NOT NULL,
  round integer NOT NULL CHECK (round >= 1),
  claimed_at timestamptz NOT NULL,
  -- a claimed ask is held until then; a server that died lets it go by itself
  lease_until timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('answered', 'rejected', 'failed')),
  answer jsonb,
  -- [{ issue, after, reason }] the edges applied; null until the answer was applied
  applied jsonb,
  -- [{ issue, after, why }] the edges of the answer that were refused
  refused jsonb,
  after_shape text,
  detail text,
  finished_at timestamptz,
  UNIQUE (repo, shape, round),
  CHECK ((outcome IS NULL) = (finished_at IS NULL))
);

CREATE INDEX queue_asks_by_repo ON factory.queue_asks (repo, claimed_at);
