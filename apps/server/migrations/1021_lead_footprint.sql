-- A lead's process tree as its physical footprint (macOS phys_footprint, from the one `top` snapshot of the host loop),
-- recorded beside the summed RSS: footprint leaves shared clean pages out, RSS counts them once per process. Null when
-- `top` could not be read that minute and for every row before this migration; admission still learns from rss_mib.
ALTER TABLE factory.lead_samples ADD COLUMN footprint_mib integer;
