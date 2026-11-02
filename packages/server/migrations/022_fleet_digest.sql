-- FV Wave 2: the fleet digest's cache and its pass journal (docs/design.md §11 "The fleet view"). Additive: a rollback ignores both.
-- One row per digested item (`heading:<hash>`, `session:<id>`, `reply:<id>`): the fingerprint is the content that was sent.
CREATE TABLE factory.fleet_digest (
  key         text PRIMARY KEY,
  fingerprint text NOT NULL,
  answer      jsonb NOT NULL,
  at          timestamptz NOT NULL
);

-- One row per `agw digest` call: what a day cost, and how many calls failed (the status line, `factory fleet --format json`).
CREATE TABLE factory.fleet_digest_runs (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL,
  ok           boolean NOT NULL,
  items        integer NOT NULL,
  failed_items integer NOT NULL DEFAULT 0,
  cost_usd     numeric(12, 6),
  error        text
);
CREATE INDEX fleet_digest_runs_at_idx ON factory.fleet_digest_runs (at);
