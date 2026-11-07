-- The cutover's ledger: which Issues of the old core's schema (`factory_legacy`) were imported, and what became of every
-- old event. The importer (`apps/server/scripts/import-legacy.ts`) owns these tables; nothing in the running server reads
-- them. Facts are stored: a second run reads the ledger and changes nothing that is in it.

-- One row per imported Issue. `last_event` is the largest old event id carried, so a later run appends only what the old
-- core recorded after it (the old core worked the Issue during a way back).
CREATE TABLE factory.import_issues (
  issue_id text PRIMARY KEY REFERENCES factory.issues (id),
  legacy_id integer NOT NULL UNIQUE,
  imported_at timestamptz NOT NULL,
  last_event bigint NOT NULL,
  -- the new core's own events on this Issue at the time of the last run: more later means a window worked it
  carried_version integer NOT NULL CHECK (carried_version >= 1)
);

-- What became of each old event: mapped to new events (their keys), dropped with the reason, or folded into another
-- table (a ship's evidence, a Decision, a priority). Every old kind and every reason has one of the three.
CREATE TABLE factory.import_events (
  legacy_event bigint PRIMARY KEY,
  legacy_issue integer NOT NULL,
  kind text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('mapped', 'dropped', 'folded')),
  -- why dropped, where folded, or what the machine said when it did not apply a mapped event
  reason text,
  keys text[] NOT NULL DEFAULT '{}'
);

CREATE INDEX import_events_by_issue ON factory.import_events (legacy_issue);
