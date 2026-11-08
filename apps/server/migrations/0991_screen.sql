-- The Judge screens held signals: what it made of one it left to the owner (`screen_note`, `screened_at`: not screened
-- again), and the failed calls so far with when the next try is due (`screen_attempts`, `screen_retry_at`).

ALTER TABLE factory.intake_signals
  ADD COLUMN screen_note text,
  ADD COLUMN screened_at timestamptz,
  ADD COLUMN screen_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN screen_retry_at timestamptz;
