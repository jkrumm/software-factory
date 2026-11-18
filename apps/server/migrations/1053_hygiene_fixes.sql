-- The scripted fixes a hygiene pass ran before it filed (domains/loops/hygiene-fixes.ts): one entry per finding key,
-- [{ key, outcome: fixed | failed | skipped | deferred, detail, output?, settled?, at }]. A pass recorded before this column
-- ran none. Expand only: nothing reads the column but the Hygiene tab and the pass's own summary.

ALTER TABLE factory.hygiene_passes ADD COLUMN fixes jsonb NOT NULL DEFAULT '[]'::jsonb;
