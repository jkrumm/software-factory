-- What an Errand needs from the owner (`secret`, `hands`, `approval`, `place`), stored when the screen lets it through, and
-- the approval he gave to run its command on the mini. Errands that reached him before it carry none: the read falls back to
-- the rule over their shape.
ALTER TABLE factory.errands
  ADD COLUMN need text CHECK (need IN ('secret', 'hands', 'approval', 'place')),
  ADD COLUMN approved_at timestamptz;

-- A second Issue whose Errand repeats an open one (same command or same check) waits on that Errand instead of raising its
-- own: one row per joined Issue, ended with the Errand.
CREATE TABLE factory.errand_joins (
  errand_id text        NOT NULL REFERENCES factory.errands (id),
  issue_id  text        NOT NULL,
  attempt   integer     NOT NULL,
  -- the raise's own key: the same call again finds its join instead of joining twice
  key       text        NOT NULL UNIQUE,
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (errand_id, issue_id)
);
CREATE INDEX errand_joins_issue ON factory.errand_joins (issue_id);
