-- FV Wave 4: presence, the owner-wide cursor, the window headline and the away rule's `folded` status
-- (docs/design.md §11 "The fleet view", "The owner's line"). Additive: a rollback to the previous release ignores all of it.

-- What only a person does at a place (desk: the Herdr app on the MacBook; phone: Iris). Presence is derived from the newest row per place
-- by the clock (desk 45 min, phone 10 min) and never stored. Kept 30 days. A memo and the phone's foreground are the phone's only.
CREATE TABLE factory.fleet_presence_acts (
  id    bigserial PRIMARY KEY,
  place text NOT NULL CHECK (place IN ('desk', 'phone')),
  act   text NOT NULL CHECK (act IN ('focus', 'looked', 'board_click', 'unlock', 'memo', 'foreground', 'caught_up')),
  at    timestamptz NOT NULL,
  CHECK (place = 'phone' OR act NOT IN ('memo', 'foreground'))
);
CREATE INDEX fleet_presence_acts_latest ON factory.fleet_presence_acts (place, at DESC);

-- The one owner-wide cursor: what the owner has caught up with, on any surface. Moves forward only.
CREATE TABLE factory.fleet_seen (
  id      smallint PRIMARY KEY CHECK (id = 1),
  seen_at timestamptz NOT NULL
);

-- The headline paragraph of a since window (`agw digest` kind `window`), one row per distinct window: `hash` is the hash of the facts
-- that were (or will be) sent, so equal facts are one call. `state`: queued (wanted), pending (an agw run not finished), ready, failed
-- (waits until `retry_at`). One run in flight; the failure count drives the wait.
CREATE TABLE factory.fleet_windows (
  hash         text PRIMARY KEY,
  facts        text NOT NULL,
  state        text NOT NULL CHECK (state IN ('queued', 'pending', 'ready', 'failed')),
  paragraph    text,
  run_id       text,
  failures     integer NOT NULL DEFAULT 0,
  waits_failed integer NOT NULL DEFAULT 0,
  retry_at     timestamptz,
  error        text,
  requested_at timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE INDEX fleet_windows_open ON factory.fleet_windows (requested_at) WHERE state <> 'ready';

-- The away rule: a message the owner's presence says is not worth a push is `folded` (never sent later: its facts are in the since reading).
-- `next_at` is moved to infinity, so a release that does not know the column never finds the row due.
ALTER TABLE factory.notifications
  ADD COLUMN folded_at timestamptz,
  ADD COLUMN folded_reason text,
  ADD CONSTRAINT notifications_folded_unsent CHECK (folded_at IS NULL OR (sent_at IS NULL AND failed_at IS NULL));
