-- Every request the API refuses with a 4xx (a malformed request, a caller the policy turns away, an unknown id), one row each:
-- which operation, which caller, which status and, for a 422, the names of the fields. No body, query or value is stored, so a
-- row says where a caller went wrong and never what it sent. `factory read friction` counts them by operation and status.

CREATE TABLE factory.api_refusals (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  -- the OpenAPI operation id (`issue.list`); `unknown` for a path no route has
  operation text NOT NULL,
  -- owner, orchestrator, agent, machine, signal or read; `none` when no token resolved
  caller text NOT NULL,
  status integer NOT NULL CHECK (status BETWEEN 400 AND 499),
  -- the names of the fields a validation refused (a JSON array of strings), empty for any other status
  fields jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX api_refusals_by_time ON factory.api_refusals (at);
