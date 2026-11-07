-- Reset row 12, corrected: the steward's wake or nudge is filed as an inbox `note` with `who: 'steward'`, and the owner never wrote it.
-- `owner_touches` counted every `note` event, so the factory's own acts read as owner touches and spoiled the zero-touch KPI. A `note`
-- whose payload `who` is `steward` is no longer counted. Same view, same columns, one condition: additive, and a rollback to the
-- previous release reads the view as it is.
CREATE OR REPLACE VIEW factory.issue_facts AS
WITH admits AS (
  SELECT issue_id, at, id, row_number() OVER (PARTITION BY issue_id ORDER BY at, id)::int AS attempt
  FROM factory.issue_events
  WHERE kind = 'admitted' AND to_state = 'working'
),
bounds AS (
  SELECT issue_id, attempt,
         CASE WHEN attempt = 1 THEN NULL ELSE at END AS lo_at,
         CASE WHEN attempt = 1 THEN NULL ELSE id END AS lo_id,
         lead(at) OVER (PARTITION BY issue_id ORDER BY attempt) AS hi_at,
         lead(id) OVER (PARTITION BY issue_id ORDER BY attempt) AS hi_id,
         at AS admitted_at,
         max(attempt) OVER (PARTITION BY issue_id) AS last_attempt
  FROM admits
),
attempts AS (
  SELECT * FROM bounds
  UNION ALL
  SELECT i.id, 0, NULL, NULL, NULL, NULL, NULL::timestamptz, 0
  FROM factory.issues i
  WHERE NOT EXISTS (SELECT 1 FROM admits a WHERE a.issue_id = i.id)
),
ev AS (
  SELECT a.issue_id, a.attempt, e.id, e.kind, e.to_state, e.at, e.payload
  FROM attempts a
  JOIN factory.issue_events e ON e.issue_id = a.issue_id
   AND (a.lo_at IS NULL OR (e.at, e.id) >= (a.lo_at, a.lo_id))
   AND (a.hi_at IS NULL OR (e.at, e.id) < (a.hi_at, a.hi_id))
),
agg AS (
  SELECT issue_id, attempt,
         min(at) FILTER (WHERE kind = 'ship') AS shipped_at,
         (array_agg((payload->'derived'->>'mergedAt')::timestamptz ORDER BY at, id) FILTER (WHERE kind = 'ship'))[1] AS landed_at,
         min(at) FILTER (WHERE kind = 'verified') AS verified_at,
         (array_agg(id ORDER BY at, id) FILTER (WHERE kind = 'verified'))[1] AS verified_id,
         max(at) FILTER (WHERE to_state = 'closed') AS closed_at,
         (count(*) FILTER (WHERE kind IN ('ask', 'block')))::int AS asks,
         jsonb_build_object(
           'wall', count(*) FILTER (WHERE kind = 'limit_stop' AND to_state = 'waiting'),
           'lead_gone', count(*) FILTER (WHERE kind = 'lead_gone'),
           'unreported', count(*) FILTER (WHERE kind = 'unreported'),
           'parked', count(*) FILTER (WHERE kind = 'park' OR (kind = 'regression' AND to_state = 'waiting'))
         ) AS parks,
         (count(*) FILTER (
           WHERE (kind = 'note' AND coalesce(payload->>'who', '') <> 'steward')
              OR kind IN ('retier', 'reopen')
              OR (kind = 'answer' AND coalesce(payload->>'who', '') NOT IN ('default', 'closed'))
         ))::int AS owner_touches,
         (array_agg(payload->'derived'->'review'->>'tier' ORDER BY at DESC, id DESC) FILTER (WHERE kind = 'ship'))[1] AS review_tier,
         (count(*) FILTER (WHERE kind = 'ship'))::int AS holds,
         bool_or(kind = 'reopen') AS reopened,
         bool_or(kind IN ('verified', 'verify_red', 'regression')) AS first_hold_decided
  FROM ev
  GROUP BY issue_id, attempt
)
SELECT
  i.id AS issue_id,
  a.attempt,
  i.repo,
  i.kind,
  i.size,
  i.lead_tier,
  i.lead_effort,
  i.created_at AS filed_at,
  a.admitted_at,
  g.landed_at,
  g.shipped_at,
  g.verified_at,
  g.closed_at,
  CASE WHEN a.attempt < a.last_attempt THEN 'retried' ELSE i.outcome END AS outcome,
  coalesce(g.asks, 0) AS asks,
  coalesce(g.parks, '{"wall":0,"lead_gone":0,"unreported":0,"parked":0}'::jsonb) AS parks,
  coalesce(g.owner_touches, 0) AS owner_touches,
  g.review_tier,
  coalesce(g.holds, 0) AS holds,
  coalesce(g.holds, 0) > 0 AND g.verified_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ev x
    WHERE x.issue_id = a.issue_id AND x.attempt = a.attempt AND x.kind IN ('verify_red', 'regression')
      AND (x.at, x.id) < (g.verified_at, g.verified_id)
  ) AS verify_first_pass,
  coalesce(g.first_hold_decided, false) AS first_hold_decided,
  coalesce(g.reopened, false) AS reopened,
  array(
    SELECT s.claude_session_id FROM factory.sessions s
    WHERE s.id = 'lead-' || i.id || '-' || a.attempt AND s.claude_session_id IS NOT NULL
    ORDER BY s.claude_session_id
  ) AS lead_session_ids
FROM attempts a
JOIN factory.issues i ON i.id = a.issue_id
LEFT JOIN agg g ON g.issue_id = a.issue_id AND g.attempt = a.attempt;
