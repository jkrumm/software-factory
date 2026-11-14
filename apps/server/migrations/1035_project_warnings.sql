-- What reading a project's `project.yaml` changed without refusing it (a `leads` above the bound, clamped to it), named in
-- `factory project show`. Expand only: a row stored before this column has none.
ALTER TABLE factory.planning_projects ADD COLUMN project_warnings jsonb NOT NULL DEFAULT '[]';
