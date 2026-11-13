-- A Replan is also filed when a plan row with `after_needs: shipped` is held behind an `after` row that closed
-- dropped or cancelled (app/planning-pass.ts, trigger `held`).
ALTER TABLE factory.replans DROP CONSTRAINT replans_trigger_check;
ALTER TABLE factory.replans ADD CONSTRAINT replans_trigger_check CHECK (trigger IN ('owner', 'stalled', 'held'));
