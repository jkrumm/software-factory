-- The host sample's memory and swap as amounts, beside the shares stored since 1002: RAM, the memory in use (app, wired and
-- compressed, as Activity Monitor counts it), and the swap in use and its size, in bytes (null where the minute read none).
-- The Throughput page draws them as gigabytes; a minute stored before this one is read as its share of the RAM.
ALTER TABLE factory.host_samples ADD COLUMN ram_bytes bigint;
ALTER TABLE factory.host_samples ADD COLUMN memory_used_bytes bigint;
ALTER TABLE factory.host_samples ADD COLUMN swap_used_bytes bigint;
ALTER TABLE factory.host_samples ADD COLUMN swap_total_bytes bigint;
