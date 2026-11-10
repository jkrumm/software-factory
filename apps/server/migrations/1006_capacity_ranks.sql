-- The account picker's order of accounts for a lane, as the poll last read it (app/capacity-admit.ts). One row per
-- lane, replaced on every poll: admission takes only the order from it, the gates stay the factory's.
CREATE TABLE factory.capacity_ranks (
  lane      text        PRIMARY KEY,
  read_at   timestamptz NOT NULL,
  picked_at timestamptz NOT NULL,
  ordering  jsonb       NOT NULL
);
