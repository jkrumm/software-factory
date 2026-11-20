-- One ledger for the asks of the agw workflows: the queue loop's asks (`queue_asks`, 0960) become rows of `loop_calls` with
-- loop = 'queue'. A queue call is about a repo, not an Issue, so `issue_id` may be null and `repo` is set instead; `scope`
-- is whichever of the two the call is about, and the call's round is unique within (loop, scope, subject). The queue loop's
-- subject is the shape of the repo's queue. `applied` is what was done with an answer (the queue loop's edges applied and
-- refused and the shape after them); null until it was applied. `queue_asks` is no longer written; dropping it is a later step.

ALTER TABLE factory.loop_calls DROP CONSTRAINT loop_calls_loop_check;
ALTER TABLE factory.loop_calls ADD CONSTRAINT loop_calls_loop_check CHECK (loop IN ('steward', 'triage', 'queue'));
ALTER TABLE factory.loop_calls ALTER COLUMN issue_id DROP NOT NULL;
ALTER TABLE factory.loop_calls ADD COLUMN repo text;
ALTER TABLE factory.loop_calls ADD CONSTRAINT loop_calls_one_scope CHECK ((issue_id IS NULL) = (repo IS NOT NULL));
ALTER TABLE factory.loop_calls ADD COLUMN scope text GENERATED ALWAYS AS (COALESCE(issue_id, repo)) STORED;
ALTER TABLE factory.loop_calls ADD COLUMN applied jsonb;

ALTER TABLE factory.loop_calls DROP CONSTRAINT loop_calls_loop_issue_id_subject_round_key;
ALTER TABLE factory.loop_calls ADD CONSTRAINT loop_calls_scope_round_key UNIQUE (loop, scope, subject, round);
DROP INDEX factory.loop_calls_by_issue;
CREATE INDEX loop_calls_by_scope ON factory.loop_calls (scope, loop, subject, round);

-- Every ask is copied, answered ones included: the queue order and "this shape was asked" read them.
INSERT INTO factory.loop_calls (key, loop, repo, subject, round, claimed_at, lease_until, outcome, answer, detail, finished_at, applied)
SELECT key, 'queue', repo, shape, round, claimed_at, lease_until, outcome, answer, detail, finished_at,
  CASE WHEN applied IS NULL THEN NULL
    ELSE jsonb_build_object('applied', applied, 'refused', COALESCE(refused, '[]'::jsonb), 'afterShape', after_shape) END
FROM factory.queue_asks;
