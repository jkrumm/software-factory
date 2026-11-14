-- The Spec screen and the owner's "needed me" mark (Issue 1096). Expand only: a new table and a new nullable column.
--
-- A Spec revision is screened before it reaches the owner: the rules, then the `factory-spec-screen` workflow. One row per
-- screened revision: `outcome` is null while the screen holds it (a call failed and is tried again at `retry_at`),
-- `passed` when it reached the owner (Needs you, the page), `settled` when the factory gave it looks_good itself. `source`
-- is who made the Spec owed, as the screen saw it: `triage` (factory-triage set the checkpoint), `filer` (the filer set it,
-- or attached the Spec), `replan` (the Replan's own proposal), `lead` (the lead judged one due).
CREATE TABLE factory.spec_screens (
  artifact_id text        NOT NULL,
  revision    integer     NOT NULL,
  outcome     text        CHECK (outcome IN ('passed', 'settled')),
  by          text        CHECK (by IN ('rule', 'judge', 'failed')),
  source      text        NOT NULL CHECK (source IN ('triage', 'filer', 'replan', 'lead')),
  note        text,
  tries       integer     NOT NULL DEFAULT 0,
  retry_at    timestamptz,
  at          timestamptz NOT NULL,
  PRIMARY KEY (artifact_id, revision),
  FOREIGN KEY (artifact_id, revision) REFERENCES factory.artifact_revisions (artifact_id, n),
  CHECK ((outcome IS NULL) = (by IS NULL))
);

CREATE INDEX spec_screens_held ON factory.spec_screens (retry_at) WHERE outcome IS NULL;

-- The owner's one-click mark on a verdict, like `decisions.worth_asking`: did this Spec or Report need him. Null: not marked.
ALTER TABLE factory.verdicts ADD COLUMN needed_me boolean;
ALTER TABLE factory.verdicts ADD COLUMN needed_at timestamptz;

-- Every Spec revision handed over before the screen existed reached the owner: it is recorded as passed, so Needs you shows
-- what it showed and the screen never looks at the past.
INSERT INTO factory.spec_screens (artifact_id, revision, outcome, by, source, note, at)
SELECT r.artifact_id, r.n, 'passed', 'rule',
  CASE
    WHEN EXISTS (SELECT 1 FROM factory.replans p WHERE p.issue_id = a.issue_id) THEN 'replan'
    WHEN a.key LIKE 'filed-spec:%' THEN 'filer'
    WHEN EXISTS (
      SELECT 1 FROM factory.issue_events e
      WHERE e.issue_id = a.issue_id AND e.kind = 'settled' AND e.result = 'applied' AND e.payload->>'checkpoint' = 'spec'
    ) THEN 'triage'
    WHEN EXISTS (
      SELECT 1 FROM factory.issue_events e
      WHERE e.issue_id = a.issue_id AND e.kind = 'filed' AND e.result = 'applied' AND e.payload->>'checkpoint' = 'spec'
    ) THEN 'filer'
    ELSE 'lead'
  END,
  'handed over before the screen existed', r.created_at
FROM factory.artifact_revisions r
JOIN factory.artifacts a ON a.id = r.artifact_id
WHERE a.kind = 'spec';

-- The first precedents: the owner said in his verdict notes that these five Specs did not need him (2026-11-13..14).
UPDATE factory.verdicts v SET needed_me = false, needed_at = v.at
FROM factory.artifacts a
WHERE a.id = v.artifact_id AND a.kind = 'spec' AND v.needed_me IS NULL
  AND a.issue_id IN ('issue_1024', 'issue_1046', 'issue_1073', 'issue_1081', 'issue_990');
