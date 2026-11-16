-- A retired artifact: a Report the owner no longer needs on the Artifacts screen (a copy a standalone Report superseded, a
-- page of a cancelled Issue). `retired_at` is a fact: the list hides it by default, its address and revisions still work,
-- and `artifact restore` clears it. Expand only: nothing is rewritten.

ALTER TABLE factory.artifacts ADD COLUMN retired_at timestamptz;
