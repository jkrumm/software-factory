-- The host sample's CPU split: the user and system share of `top`'s header beside the idle share stored since 1022
-- (percent of all cores, null when the header was not read). The remainder of 100 is the idle share, so the three tell a busy
-- host from a stalled one without the class rows, whose CPU covers only the processes `top` listed.
ALTER TABLE factory.host_samples ADD COLUMN cpu_user_pct double precision;
ALTER TABLE factory.host_samples ADD COLUMN cpu_sys_pct double precision;
