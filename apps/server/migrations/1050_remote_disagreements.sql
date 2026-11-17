-- Remote steps (issue 2028): what disagreed, how the VPS's calm is measured, and why a step ran where it did.
-- A run on the mini that found a red off the mini green carries the red run's failing tests (name, remote duration,
-- timeout when the output names one) or the last lines of its output: the repo can fix the test instead of losing the host.
ALTER TABLE factory.step_costs ADD COLUMN disagreement jsonb;
-- production's pressure on the step host at each probe reading, and how many step containers ran then: a reading with
-- none is the baseline the pressure threshold is set from
CREATE TABLE factory.remote_samples (
  at              timestamptz PRIMARY KEY,
  memory_pressure double precision,
  io_pressure     double precision,
  steps_running   integer NOT NULL
);
-- where a step the project declared remote was placed, and why it stayed on the mini (free, no_room, not_sooner, held)
CREATE TABLE factory.step_placements (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL,
  name   text        NOT NULL,
  host   text        NOT NULL,
  reason text        NOT NULL
);
CREATE INDEX step_placements_name_at ON factory.step_placements (name, at DESC);
-- the hold reads a step's disagreements and its green runs off the mini
CREATE INDEX step_costs_vps_green ON factory.step_costs (name, at DESC) WHERE host = 'vps' AND exit_code = 0;
