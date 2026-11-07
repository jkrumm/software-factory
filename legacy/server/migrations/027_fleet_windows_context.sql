-- FV Wave 4: what the headline's `agw digest` item gets besides its facts (the ordinary sessions' headlines), kept outside the facts' hash so a
-- new turn is not a new window. Additive: a rollback to the previous release ignores the column.
ALTER TABLE factory.fleet_windows ADD COLUMN context text;
