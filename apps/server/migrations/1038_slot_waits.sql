-- What each test-slot wait waited for. A waiter's time between two calls counts to the reason its first call was given
-- (`capacity_slots.wait_split`, ms per reason: slots, memory, swap, load, unsized, line); when the step is granted (or the
-- waiter gives up) the split is appended here, one row per wait, so `read capacity-loop` can say per reason how long and how often.
ALTER TABLE factory.capacity_slots ADD COLUMN why_kind text, ADD COLUMN wait_split jsonb NOT NULL DEFAULT '{}';

CREATE TABLE factory.slot_waits (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL,
  name     text        NOT NULL,
  repo     text,
  cwd      text,
  -- granted: the step got its slot; gave_up: the waiter left the line without one
  outcome  text        NOT NULL CHECK (outcome IN ('granted', 'gave_up')),
  wait_ms  bigint      NOT NULL,
  split    jsonb       NOT NULL
);
CREATE INDEX slot_waits_at ON factory.slot_waits (at);
