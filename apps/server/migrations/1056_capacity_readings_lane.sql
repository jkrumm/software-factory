-- The package's verdict for the bulk lane rides on every reading (packages/accounts, docs/architecture.md "Accounts"): whether the
-- account takes work, its place in the order, why not and when it opens. The separate rank table is dropped: the order is the
-- readings' positions, read in the same poll, so the two cannot disagree. Rows from before this migration read as closed and
-- are stale within minutes.
ALTER TABLE factory.capacity_readings
  ADD COLUMN bulk_open boolean NOT NULL DEFAULT false,
  ADD COLUMN bulk_position integer,
  ADD COLUMN bulk_reason text,
  ADD COLUMN closed_why text,
  ADD COLUMN opens_at timestamptz,
  ADD COLUMN wall_reset_at timestamptz;

DROP TABLE factory.capacity_ranks;
