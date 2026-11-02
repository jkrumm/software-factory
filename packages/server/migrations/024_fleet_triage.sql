-- FV Wave 3: the fleet triage (docs/design.md §11 "The fleet view"). Additive: a rollback ignores both tables.
-- What the triage did on its own (bookkeeping only: it never runs a command and never denies). One row per decision; the
-- unique key is what it was about, so a decision the owner undid is not made again for the same fact.
CREATE TABLE factory.fleet_triage_log (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('plan_stale', 'fold', 'dismiss_note')),
  subject     text NOT NULL,
  fingerprint text NOT NULL,
  what        text NOT NULL,
  why         text NOT NULL,
  evidence    text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL,
  undone_at   timestamptz,
  UNIQUE (kind, subject, fingerprint)
);

-- What the owner did with an ask, through POST /fleet/asks/:id/act. An ask is closed once (resolve, deny or hand_off: one of them,
-- ever), a plan is archived once per ask; a repeated act answers with the first. `later` is a timer, the latest `until` wins.
CREATE TABLE factory.fleet_acts (
  id     bigserial PRIMARY KEY,
  ask_id text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('resolve', 'deny', 'later', 'archive_plan', 'hand_off')),
  note   text,
  at     timestamptz NOT NULL,
  until  timestamptz,
  result jsonb NOT NULL
);
CREATE UNIQUE INDEX fleet_acts_closed_once ON factory.fleet_acts (ask_id) WHERE intent IN ('resolve', 'deny', 'hand_off');
CREATE UNIQUE INDEX fleet_acts_archive_once ON factory.fleet_acts (ask_id) WHERE intent = 'archive_plan';
CREATE INDEX fleet_acts_ask_idx ON factory.fleet_acts (ask_id);
