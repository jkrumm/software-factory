-- What `factory digest` made of a project's Issues (app/loops/digest.ts): a fact, a new row per call, the Console reads the
-- newest. `input_hash` is the hash of what the workflow was shown without the window and the previous headline, so an
-- unchanged project is not asked again; `route` is the agw route the digest was made on.
CREATE TABLE factory.project_digests (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project    text        NOT NULL,
  at         timestamptz NOT NULL,
  input_hash text        NOT NULL,
  route      text        NOT NULL,
  digest     jsonb       NOT NULL
);
CREATE INDEX project_digests_project_at ON factory.project_digests (project, at DESC);
