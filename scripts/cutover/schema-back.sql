-- The way back, as the database's admin, with the new core stopped: the new core's schema is kept aside under its own
-- name (nothing it recorded is deleted) and the old core's schema is `factory` again.
\set ON_ERROR_STOP on
BEGIN;
ALTER SCHEMA factory RENAME TO factory_rewrite;
ALTER SCHEMA factory_legacy RENAME TO factory;
COMMIT;
