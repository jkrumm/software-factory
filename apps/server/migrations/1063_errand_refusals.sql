-- An Errand a rule refused when it was raised or requested (issue 2589): nothing is stored of it but this row, so the share the
-- rules turn away is a part beside the Errand KPI (`errands_refused_by_rule_share`). The rule is its name in the code
-- (`keyless`, `off_macbook`, `host_class`, `declined` ...); `source` is who asked for a request, null for an Issue's Errand.
CREATE TABLE factory.errand_refusals (
  id     bigserial   PRIMARY KEY,
  at     timestamptz NOT NULL,
  rule   text        NOT NULL,
  source text
);
CREATE INDEX errand_refusals_at ON factory.errand_refusals (at);
