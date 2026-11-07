-- A later window, as the database's admin, with the old core stopped: the old core's schema steps aside again and the
-- new core's own schema (everything it recorded in the earlier windows) is `factory`. The import then carries forward
-- what the old core recorded in between.
\set ON_ERROR_STOP on
BEGIN;
ALTER SCHEMA factory RENAME TO factory_legacy;
ALTER SCHEMA factory_rewrite RENAME TO factory;
COMMIT;
