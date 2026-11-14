-- The test-slot count that follows memory pressure (domains/capacity/slot-aim.ts, app/capacity-aim.ts). One row holds
-- the aimed count between 1 and the ceiling and the minute since which the host has been quiet; the host loop moves it
-- once a minute (AIMD on the pressure level and the swap in use). `factory.slot_shadow` stores each minute's decision
-- beside the live rule for the 48 hours of shadow: the rows are kept 14 days, as the host samples they join.
CREATE TABLE factory.slot_aim (
  id          smallint    PRIMARY KEY CHECK (id = 1),
  target      smallint    NOT NULL CHECK (target >= 1),
  quiet_since timestamptz,
  changed_at  timestamptz NOT NULL
);

CREATE TABLE factory.slot_shadow (
  at                  timestamptz      PRIMARY KEY,
  -- the live rule's base slots and its cap, and what the aim says
  live_slots          smallint         NOT NULL,
  live_max            smallint         NOT NULL,
  aim_slots           smallint         NOT NULL,
  holders             smallint         NOT NULL,
  waiters             smallint         NOT NULL,
  -- the minute's reading the aim moved on (null when unread)
  pressure_level      smallint,
  swap_used_pct       double precision,
  swapout_mb_per_300s double precision,
  swap_growing        boolean          NOT NULL,
  load                double precision,
  reason              text             NOT NULL
);
