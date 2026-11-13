-- A lead's turn that ends on an API error (Claude Code's `StopFailure`, or the error line at the end of its transcript) is
-- the `api_error` hook fact; no new column holds it. What this migration adds is what the factory does about one:
--
--  * a `continue` typed into the session is a delivery of kind `resume` (key `resume:<session>:<incident>:<n>`, so a replay
--    never types it twice and the count of an incident is the count of its keys);
--  * an account whose login failed (a 401, an expired or revoked token) is marked here, and capacity reads the mark as
--    "not signed in" so nothing new is admitted on it; the mark closes when the owner's Errand for it does;
--  * a burst of transient errors across leads (three or more within five minutes) is one edge incident, the row the
--    friction counts read: its number of leads and its window, and how many of the owner's own plan sessions (hc names
--    `plan-*`) were in the same state; those are counted and never resumed.

ALTER TABLE factory.lead_deliveries DROP CONSTRAINT lead_deliveries_kind_check;
ALTER TABLE factory.lead_deliveries
  ADD CONSTRAINT lead_deliveries_kind_check CHECK (kind IN ('brief', 'note', 'resume'));

CREATE TABLE factory.account_auth_marks (
  account text PRIMARY KEY,
  marked_at timestamptz NOT NULL,
  -- null while the account is marked; set when the owner's Errand for it closed
  cleared_at timestamptz,
  -- the request key of the Errand "log in account X": open while this mark is
  errand_key text NOT NULL,
  label text NOT NULL
);

CREATE TABLE factory.api_edge_incidents (
  key text PRIMARY KEY,
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  leads integer NOT NULL CHECK (leads >= 1),
  plans integer NOT NULL DEFAULT 0,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX api_edge_incidents_by_time ON factory.api_edge_incidents (first_at);

-- the retro's "minutes blocked on API errors" reads these by time
CREATE INDEX lead_hook_events_api_errors ON factory.lead_hook_events (at) WHERE kind = 'api_error';
