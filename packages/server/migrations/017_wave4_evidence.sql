-- F2 Wave 4: evidence, the hold and finalize (docs/design.md §4, §5, §12). Additive: a rollback to the previous release ignores it.

-- `key` makes a repeated report one row, `attempt` says which lead's work it speaks for. The table had no writer until this wave.
ALTER TABLE factory.evidence
  ADD COLUMN key     text UNIQUE,
  ADD COLUMN attempt integer;
CREATE INDEX evidence_kind ON factory.evidence (issue_id, kind, at);

-- A spawn that forks an archived session (`factory issue resume`): Claude's session id, and the archived transcript the runner puts
-- back where Claude looks for it before it starts.
ALTER TABLE factory.spawns
  ADD COLUMN fork_session text,
  ADD COLUMN fork_archive text;
