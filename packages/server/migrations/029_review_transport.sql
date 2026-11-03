-- Review v4's hidden transport (docs/design.md §3 "The review transport"): a reviewer spawn carries agw's job, runs in a hidden terminal and is
-- admitted against the review slots, the review ceiling and the day's deep cap. Expand only: the previous release ignores the new columns
-- and never writes the new values. Rolling back with a reviewer spawn queued or running leaves it to the old release, which would start it as
-- a plain worker: drain the queue first (`factory queue set drain`) and let the reviewers end.
ALTER TABLE factory.spawns ADD COLUMN review_job text;
ALTER TABLE factory.spawns ADD COLUMN review_tier text CHECK (review_tier IN ('light', 'standard', 'deep'));
ALTER TABLE factory.spawns ADD COLUMN review_effort text CHECK (review_effort IN ('low', 'medium', 'high'));
-- The owner's `allow` on a held deep review: this spawn, and only it, may start past the day's deep cap.
ALTER TABLE factory.spawns ADD COLUMN deep_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_review_check CHECK ((review_job IS NULL) = (review_tier IS NULL) AND (review_job IS NULL) = (review_effort IS NULL));

ALTER TABLE factory.spawns DROP CONSTRAINT spawns_hold_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_hold_check CHECK (hold IN ('drain', 'pace', 'wave', 'claim', 'review_slots', 'deep_cap'));
ALTER TABLE factory.spawns DROP CONSTRAINT spawns_placement_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_placement_check CHECK (placement IN ('tab', 'child', 'hidden'));

-- How a reviewer attempt ended, once: `submitted` (agw took the reply), `refused` (agw refused it), `idle` (the session stopped growing, never started, or was lost), `walled` (a usage limit stopped it),
-- `needs_human` (the second attempt failed too), `superseded` (agw says the job is abandoned or another attempt won: final, no retry). The primary key is the deterministic effect key, so a replayed pass records nothing twice.
CREATE TABLE factory.review_outcomes (
  spawn_key text PRIMARY KEY,
  job_id    text NOT NULL,
  attempt   integer NOT NULL CHECK (attempt > 0),
  outcome   text NOT NULL CHECK (outcome IN ('submitted', 'refused', 'idle', 'walled', 'needs_human', 'superseded')),
  detail    text,
  at        timestamptz NOT NULL
);
CREATE INDEX review_outcomes_human ON factory.review_outcomes (at) WHERE outcome = 'needs_human';

-- `factory spawn cancel`: a queued or waiting spawn that was never claimed ends as `cancelled` (its key is spent, like an ended one's).
ALTER TABLE factory.spawns DROP CONSTRAINT spawns_status_check;
ALTER TABLE factory.spawns ADD CONSTRAINT spawns_status_check CHECK (status IN ('queued', 'waiting', 'starting', 'started', 'failed', 'cancelled'));

-- The owner's `allow` (fleet act) closes an ask like resolve, deny and hand_off do.
ALTER TABLE factory.fleet_acts DROP CONSTRAINT fleet_acts_intent_check;
ALTER TABLE factory.fleet_acts ADD CONSTRAINT fleet_acts_intent_check CHECK (intent IN ('resolve', 'deny', 'later', 'archive_plan', 'hand_off', 'allow'));
DROP INDEX factory.fleet_acts_closed_once;
CREATE UNIQUE INDEX fleet_acts_closed_once ON factory.fleet_acts (ask_id, occurrence) WHERE intent IN ('resolve', 'deny', 'hand_off', 'allow');
