-- The factory door (docs/design.md §11). Additive: a rollback to the previous release ignores all of it.
-- Monitor names and repos are the owner's estate: the registry is data, never tracked in git.

-- Which repo an alert of (source, monitor) concerns. `quiet` counts the alerts that filed nothing here (an `up` with no open Issue);
-- `last_event` makes a retry of the same event one count.
CREATE TABLE factory.door_routes (
  source     text NOT NULL,
  monitor    text NOT NULL,
  repo       text NOT NULL,
  quiet      integer NOT NULL DEFAULT 0,
  last_quiet_at timestamptz,
  last_event text,
  PRIMARY KEY (source, monitor)
);

-- Every alert the homelab has arrives here until the owner routes it (Kuma attaches every provider to every monitor), so a row
-- is a counter and the last title, nothing more.
CREATE TABLE factory.door_unrouted (
  source     text NOT NULL,
  monitor    text NOT NULL,
  count      integer NOT NULL DEFAULT 1,
  last_seen  timestamptz NOT NULL,
  last_title text NOT NULL,
  last_event text NOT NULL,
  PRIMARY KEY (source, monitor)
);
CREATE INDEX door_unrouted_recent ON factory.door_unrouted (last_seen DESC);

-- The Issue an alert created, by the monitor it came from: `Issues` has no column for it and the key of a create is only a string.
CREATE TABLE factory.door_issues (
  issue_id integer PRIMARY KEY REFERENCES factory.issues (id),
  source   text NOT NULL,
  monitor  text NOT NULL
);
CREATE INDEX door_issues_monitor ON factory.door_issues (source, monitor);
