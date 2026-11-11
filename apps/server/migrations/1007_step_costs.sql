-- What each test-slot step cost, one row per finished `factory slot run` (POST /slots/:id/cost): the grant rule learns a
-- step's peak memory from its newest rows. The slots table carries the live size of the holder's process tree.
CREATE TABLE factory.step_costs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz      NOT NULL,
  name         text             NOT NULL,
  repo         text,
  peak_rss_mib integer,
  cpu_seconds  double precision,
  duration_ms  bigint           NOT NULL,
  wait_ms      bigint           NOT NULL,
  exit_code    integer
);
CREATE INDEX step_costs_name_at ON factory.step_costs (name, at DESC);

ALTER TABLE factory.capacity_slots ADD COLUMN rss_mib integer;
ALTER TABLE factory.capacity_slots ADD COLUMN peak_rss_mib integer;
-- why a waiter is still waiting, as of its last call (the capacity view shows it)
ALTER TABLE factory.capacity_slots ADD COLUMN why text;
