-- A door source that is refused repeatedly, or has posted nothing for weeks, reaches someone (docs/design.md §11 "Door sources").
-- Additive: a rollback to the previous release ignores the table.

-- `first_seen` is when the door or an alert first named the source; `last_accepted` the last message that passed auth (a filed alert
-- or a Kuma test message), NULL if none; `refused` the 401s since then, `refused_since` the first of them (both reset by an accepted
-- message); `last_refused` the latest 401. Only a source the door holds a token for is ever written, so the table cannot be grown
-- by a stranger. Times are the server's clock.
CREATE TABLE factory.door_sources (
  source         text PRIMARY KEY,
  first_seen     timestamptz NOT NULL,
  last_accepted  timestamptz,
  refused        integer NOT NULL DEFAULT 0,
  refused_since  timestamptz,
  last_refused   timestamptz
);
