-- FV Wave 2, the digest's call lifecycle (docs/design.md §11 "The digest"). Additive: a rollback ignores both.
-- The one run `agw` has not finished (exit 10): its id and the batch it answers. While it exists the digest only waits for it.
CREATE TABLE factory.fleet_digest_pending (
  id         smallint PRIMARY KEY CHECK (id = 1),
  run_id     text NOT NULL,
  batch      jsonb NOT NULL,
  started_at timestamptz NOT NULL
);

-- An item whose last answer failed (an error answer, a failed call, a store that was refused): not asked again before `retry_at`,
-- doubled with every failure for the same content (`fingerprint`).
CREATE TABLE factory.fleet_digest_backoff (
  key         text PRIMARY KEY,
  fingerprint text NOT NULL,
  failures    integer NOT NULL,
  -- the size of the batch it last failed in: the next call with it is at most half as big
  batch       integer NOT NULL DEFAULT 1,
  retry_at    timestamptz NOT NULL,
  error       text
);
