-- A project may be read from a host-local file when its repo has no committed project.yaml (source 'local'). Expand only:
-- the allowed values grow by one, no row changes.
ALTER TABLE factory.planning_projects DROP CONSTRAINT planning_projects_source_check;
ALTER TABLE factory.planning_projects
  ADD CONSTRAINT planning_projects_source_check CHECK (source IN ('file', 'local', 'defaults'));
