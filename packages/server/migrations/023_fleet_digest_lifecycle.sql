-- FV Wave 2, the digest's call lifecycle (docs/design.md §11 "The digest"). Additive: a rollback ignores all of it.
-- The one run `agw` has not finished (exit 10): its id and the batch it answers. While it exists the digest only waits for it.
CREATE TABLE factory.fleet_digest_pending (
  id           smallint PRIMARY KEY CHECK (id = 1),
  run_id       text NOT NULL,
  batch        jsonb NOT NULL,
  started_at   timestamptz NOT NULL,
  -- waits in a row that failed without agw saying why; the run is let go at three
  waits_failed integer NOT NULL DEFAULT 0
);

-- An item that waits before it is asked about again, for the turn it was for (null: a heading). `failures`: calls in a row that
-- failed with it (a flat wait); `batch`: the size of the batch it last failed in (a batch that failed twice is retried in halves);
-- `errors`: answers in a row that came back as an error (an exponential wait). The row goes when the item is answered.
CREATE TABLE factory.fleet_digest_backoff (
  key      text PRIMARY KEY,
  turn     integer,
  failures integer NOT NULL DEFAULT 0,
  batch    integer NOT NULL DEFAULT 1,
  errors   integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL
);

-- The journal knows the batch (its hash) and whether agw ended the run for good: the count of those is the attempt in the idempotency key.
ALTER TABLE factory.fleet_digest_runs
  ADD COLUMN batch_hash text,
  ADD COLUMN terminal boolean NOT NULL DEFAULT false;
CREATE INDEX fleet_digest_runs_batch_idx ON factory.fleet_digest_runs (batch_hash) WHERE terminal;
