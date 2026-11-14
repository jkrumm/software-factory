-- A repo's relearn point: the lead samples before `at` are ignored when what its leads cost is learned (the learned lead
-- cost, `domains/capacity/leadcost.ts`). Set by `factory capacity relearn` once the cause of a high figure is fixed, so the
-- figure does not wait for the old attempts to age out. `repo` is the project name, as `lead_samples.repo` holds it.
CREATE TABLE factory.lead_relearn (
  repo   text        PRIMARY KEY,
  at     timestamptz NOT NULL,
  set_at timestamptz NOT NULL,
  set_by text        NOT NULL
);
