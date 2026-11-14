-- One row per test result of a finished `factory slot run` (the JUnit files the step wrote into FACTORY_JUNIT_DIR, posted
-- beside the step cost). Names follow the OTel semantic conventions where one exists: `test.suite.name`,
-- `test.case.name`, `test.case.result.status` (pass, fail; skip is a custom value as the convention allows) and
-- `vcs.ref.head.revision`. `dirty` is a working tree with uncommitted changes: a flake needs the same code, so only
-- clean runs count. Pruned by the host loop (14 days); the cost ledger it hangs on is not.
ALTER TABLE factory.step_costs ADD COLUMN vcs_ref_head_revision text;
ALTER TABLE factory.step_costs ADD COLUMN dirty boolean;

CREATE TABLE factory.test_results (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  step_cost_id            bigint      NOT NULL REFERENCES factory.step_costs (id) ON DELETE CASCADE,
  at                      timestamptz NOT NULL,
  repo                    text,
  vcs_ref_head_revision   text,
  dirty                   boolean,
  test_suite_name         text        NOT NULL,
  test_case_name          text        NOT NULL,
  test_case_result_status text        NOT NULL CHECK (test_case_result_status IN ('pass', 'fail', 'skip')),
  duration_ms             integer     NOT NULL
);
CREATE INDEX test_results_at ON factory.test_results (at);
CREATE INDEX test_results_step_cost ON factory.test_results (step_cost_id);
CREATE INDEX test_results_case ON factory.test_results (repo, test_suite_name, test_case_name, vcs_ref_head_revision);
