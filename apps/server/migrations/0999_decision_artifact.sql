-- A Decision the lead raises while its Issue waits for an artifact's review is about that artifact. Expand only: one
-- nullable column; a Decision raised any other time keeps null.

ALTER TABLE factory.decisions ADD COLUMN artifact_id text REFERENCES factory.artifacts (id);
