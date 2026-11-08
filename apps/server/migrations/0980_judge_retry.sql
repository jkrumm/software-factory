-- The Judge sees a Decision before the owner does: a failed Judge call is tried again, so a step counts its calls
-- (`tries`), and a Decision remembers who asked it (`asked_by`), so a second ask from the same asker on a question still
-- open amends it instead of raising another.

ALTER TABLE factory.decision_steps ADD COLUMN tries integer NOT NULL DEFAULT 1 CHECK (tries >= 1);

ALTER TABLE factory.decisions ADD COLUMN asked_by text NOT NULL DEFAULT 'lead' CHECK (asked_by IN ('lead', 'steward'));
