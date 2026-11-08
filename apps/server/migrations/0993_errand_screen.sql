-- An Errand passes a screen before it reaches the owner: rules, then the `factory-errand` workflow. `reached_owner_at` is
-- when it did (null: still held, or turned away); `screen_tries` / `screen_retry_at` are the failed calls so far and when
-- the next is due; `screen_by` says who let it through or turned it away; `screen_note` is the screen's reason. A turned-away
-- Errand also sets `done_at` and `done_note`, so every query for an open Errand leaves it out.

ALTER TABLE factory.errands
  ADD COLUMN reached_owner_at timestamptz,
  ADD COLUMN screen_tries integer NOT NULL DEFAULT 0,
  ADD COLUMN screen_retry_at timestamptz,
  ADD COLUMN screen_by text CHECK (screen_by IN ('rule', 'judge', 'failed')),
  ADD COLUMN screen_note text,
  ADD COLUMN turned_away_at timestamptz;

-- The Errands that exist reached the owner before there was a screen.
UPDATE factory.errands SET reached_owner_at = raised_at;

CREATE INDEX errands_unscreened ON factory.errands (raised_at)
  WHERE reached_owner_at IS NULL AND done_at IS NULL;

CREATE OR REPLACE FUNCTION factory.changes_errand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM factory.note_change('errand', NEW.issue_id, 'raised', jsonb_build_object('errand', NEW.id));
  ELSE
    IF OLD.reached_owner_at IS NULL AND NEW.reached_owner_at IS NOT NULL THEN
      PERFORM factory.note_change('errand', NEW.issue_id, 'reached', jsonb_build_object('errand', NEW.id));
    END IF;
    IF OLD.done_at IS NULL AND NEW.done_at IS NOT NULL THEN
      PERFORM factory.note_change('errand', NEW.issue_id, 'done', jsonb_build_object('errand', NEW.id));
    END IF;
  END IF;
  RETURN NULL;
END $$;
