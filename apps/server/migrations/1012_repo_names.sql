-- A repo is stored as its project name, never as a path. Rows filed through an agent signal or `issue new` with a path
-- (or a linked worktree below one) carry the absolute path; the Console then showed one project twice and per-repo counts
-- split. Rewrite each to the directory name of its main checkout. Expand only: no column changes, no code is left reading
-- the path. A second directory of a name already taken is the one project whose Issues name its path (`<name>~<hash>`),
-- so a path that a stored project owns under such a name stays. The old fingerprints of signals are hashes of the path
-- and stay as they are: they age out of the triage window.

CREATE FUNCTION factory.repo_name_of(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN $1 !~ '^/' THEN $1
    ELSE coalesce(
      nullif(regexp_replace(regexp_replace($1, '/\.claude/worktrees/.*$', ''), '^.*/', ''), ''),
      $1
    )
  END
$$;

-- The same fact lives on the Issue row and in its filed event, which a replay reads: both are rewritten.
UPDATE factory.issue_events e
SET payload = jsonb_set(e.payload, '{repo}', to_jsonb(factory.repo_name_of(e.payload ->> 'repo')))
WHERE e.kind = 'filed'
  AND e.payload ->> 'repo' ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = e.payload ->> 'repo' AND p.name LIKE '%~%');

UPDATE factory.issues i SET repo = factory.repo_name_of(i.repo)
WHERE i.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = i.repo AND p.name LIKE '%~%');

UPDATE factory.intake_signals s SET repo = factory.repo_name_of(s.repo)
WHERE s.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = s.repo AND p.name LIKE '%~%');

UPDATE factory.intake_pending s SET repo = factory.repo_name_of(s.repo)
WHERE s.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = s.repo AND p.name LIKE '%~%');

UPDATE factory.intake_door_routes s SET repo = factory.repo_name_of(s.repo)
WHERE s.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = s.repo AND p.name LIKE '%~%');

UPDATE factory.capacity_claims s SET repo = factory.repo_name_of(s.repo)
WHERE s.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = s.repo AND p.name LIKE '%~%');

UPDATE factory.capacity_assignments s SET repo = factory.repo_name_of(s.repo)
WHERE s.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = s.repo AND p.name LIKE '%~%');

UPDATE factory.decisions s SET repo = factory.repo_name_of(s.repo)
WHERE s.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = s.repo AND p.name LIKE '%~%');

UPDATE factory.loop_findings s SET repo = factory.repo_name_of(s.repo)
WHERE s.repo ~ '^/'
  AND NOT EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.repo = s.repo AND p.name LIKE '%~%');

DROP FUNCTION factory.repo_name_of(text);
