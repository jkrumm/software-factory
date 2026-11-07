-- docs/plan.yaml (docs/design.md §4 "The plan files its next Issue"): the project sync reads it beside project.yaml and keeps the last
-- valid plan. `plan` is the parsed file (NULL: none), `plan_sha` the hash of the content it came from; a file that does not parse leaves
-- both alone and records itself in `plan_error` / `plan_error_sha`. Additive: a rollback to the previous release ignores all of it.
ALTER TABLE factory.projects
  ADD COLUMN plan           jsonb,
  ADD COLUMN plan_sha       text,
  ADD COLUMN plan_error     text,
  ADD COLUMN plan_error_sha text;
