-- The owner's last visit to the Console, one row: `seen_at` is the last time he read the "since you were here" band,
-- `since_at` the start of the band he sees now. A visit more than 30 minutes after the last read moves `since_at` to the
-- old `seen_at` (app/visit.ts), so a refetch within one visit shows the same band.
CREATE TABLE factory.console_visit (
  id       boolean     PRIMARY KEY DEFAULT true CHECK (id),
  seen_at  timestamptz NOT NULL,
  since_at timestamptz NOT NULL
);
