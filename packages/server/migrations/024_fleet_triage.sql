-- FV Wave 3: the fleet triage (docs/design.md §11 "The fleet view"). Additive: three new tables; a rollback to the previous release ignores them.
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

-- The rows that change the model, however old (the build reads exactly these every 30 s).
CREATE INDEX fleet_triage_log_effect_idx ON factory.fleet_triage_log (id)
  WHERE (kind IN ('fold', 'dismiss_note') AND undone_at IS NULL) OR (kind = 'plan_stale' AND undone_at IS NOT NULL);

-- Which asks the builds have seen. An ask is one occurrence while it is listed by its source; when a build does not list it the
-- occurrence ends, and a return is the next one with a new first-seen time. What the owner did with an ask is of one occurrence.
-- first_seen is also what the builder restarts with, so a restart does not re-time an ask (and reverse a fold by ordering).
CREATE TABLE factory.fleet_ask_seen (
  ask_id     text PRIMARY KEY,
  occurrence integer NOT NULL CHECK (occurrence > 0),
  first_seen timestamptz NOT NULL,
  present    boolean NOT NULL DEFAULT true,
  absent_at  timestamptz
);

-- What the owner did with an ask, through POST /fleet/asks/:id/act. An occurrence of an ask is closed once (resolve, deny or
-- hand_off: one of them), a plan is archived once per occurrence; a repeated act answers with the first. `later` is a timer, one
-- row per occurrence, the latest `until` wins.
CREATE TABLE factory.fleet_acts (
  id         bigserial PRIMARY KEY,
  ask_id     text NOT NULL,
  occurrence integer NOT NULL DEFAULT 1 CHECK (occurrence > 0),
  intent     text NOT NULL CHECK (intent IN ('resolve', 'deny', 'later', 'archive_plan', 'hand_off')),
  note       text,
  at         timestamptz NOT NULL,
  until      timestamptz,
  result     jsonb NOT NULL
);
CREATE UNIQUE INDEX fleet_acts_closed_once ON factory.fleet_acts (ask_id, occurrence) WHERE intent IN ('resolve', 'deny', 'hand_off');
CREATE UNIQUE INDEX fleet_acts_archive_once ON factory.fleet_acts (ask_id, occurrence) WHERE intent = 'archive_plan';
CREATE UNIQUE INDEX fleet_acts_later_once ON factory.fleet_acts (ask_id, occurrence) WHERE intent = 'later';
CREATE INDEX fleet_acts_ask_idx ON factory.fleet_acts (ask_id);
CREATE INDEX fleet_acts_handoff_idx ON factory.fleet_acts (at) WHERE intent = 'hand_off';
