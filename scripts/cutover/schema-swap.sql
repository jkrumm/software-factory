-- Window 1, as the database's admin: the old core's schema steps aside, the new core gets an empty `factory` it owns.
-- The `factory` role owns its schema but holds no CREATE on the database, and RENAME needs both: this is the admin's step.
-- Undo: schema-back.sql (after the new core has run) or, before it ever ran, DROP SCHEMA factory; then rename factory_legacy back.
\set ON_ERROR_STOP on
BEGIN;
ALTER SCHEMA factory RENAME TO factory_legacy;
CREATE SCHEMA factory AUTHORIZATION factory;
COMMIT;
