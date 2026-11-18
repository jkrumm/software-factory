-- The kernel's own free-memory reading and the lead aim (docs/decisions.md, "Admission is calibrated by the pressure it
-- predicts"). `kernel_free_pct` is `kern.memorystatus_level`, the share of RAM the kernel itself counts as available
-- (memory_pressure's "System-wide memory free percentage"): at the minute of Issue 2271 it read 57 to 69 % where the
-- factory's own sum (anonymous pageable memory plus wired plus compressed) left 22 %, with the pressure level normal.
-- The lead aim is the count of leads the host takes, moved once a minute by the same AIMD verdict as the slot aim.
ALTER TABLE factory.host_samples ADD COLUMN kernel_free_pct smallint;

ALTER TABLE factory.slot_aim
  ADD COLUMN lead_target smallint CHECK (lead_target >= 1),
  ADD COLUMN lead_since  timestamptz;

ALTER TABLE factory.slot_shadow
  ADD COLUMN lead_aim      smallint,
  ADD COLUMN leads_running smallint;
