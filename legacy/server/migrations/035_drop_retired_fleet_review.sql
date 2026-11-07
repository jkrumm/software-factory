-- Reset row 9: the contract half of row 8's deletion. Nothing in the server, the CLI or the contract reads or writes these any more:
-- the fleet triage, act, presence, window and seen stores, the review transport's outcomes and the spawn columns it added.
-- `fleet_digest*` stays: the read API (Issue 85) reuses the digest or removes it. The runner (db.ts `migrate`) holds the migration advisory
-- lock around this file, and every name is schema-qualified.
--
-- NOT rollback-safe by itself: the release before row 8 (tag pre-reset-2026-11, `make rollback`) reads these tables. Rolling back past this
-- migration means restoring the factory schema from the pg_dump taken before the deploy.
DROP TABLE factory.fleet_triage_log;
DROP TABLE factory.fleet_ask_seen;
DROP TABLE factory.fleet_acts;
DROP TABLE factory.fleet_presence_acts;
DROP TABLE factory.fleet_seen;
DROP TABLE factory.fleet_windows;
DROP TABLE factory.review_outcomes;

ALTER TABLE factory.spawns DROP CONSTRAINT spawns_review_check;
ALTER TABLE factory.spawns DROP COLUMN review_job;
ALTER TABLE factory.spawns DROP COLUMN review_tier;
ALTER TABLE factory.spawns DROP COLUMN review_effort;
ALTER TABLE factory.spawns DROP COLUMN deep_allowed;
