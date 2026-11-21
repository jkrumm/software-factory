-- The load tripwire at each slot minute. A tripped tripwire holds a second test step (one at a time until the load settles),
-- so a base slot empty beside a waiter in such a minute is the intended hold, not a refusal by memory: the self-watch's
-- base_empty rule leaves those minutes out.
ALTER TABLE factory.slot_shadow ADD COLUMN load_tripped boolean NOT NULL DEFAULT false;
