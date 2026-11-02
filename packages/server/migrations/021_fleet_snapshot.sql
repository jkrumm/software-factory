-- FV Wave 1: the fleet read model's snapshot (docs/design.md §11 "The fleet view"). One row, replaced by the builder; GET /fleet reads it.
-- Additive: a rollback to the previous release ignores the table.
CREATE TABLE factory.fleet_snapshot (
  id          smallint PRIMARY KEY CHECK (id = 1),
  model       jsonb NOT NULL,
  fingerprint text NOT NULL,
  built_at    timestamptz NOT NULL
);
