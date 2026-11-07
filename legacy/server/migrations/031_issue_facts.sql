-- Reset row 12: one row per attempt of an Issue, the facts the KPIs of design-v3 §11 are read from. A view, not a table: nothing is
-- stored, no writer changes, and the stored events stay the only source (facts are stored, state is derived). Additive: a rollback to
-- the previous release ignores it.
--
-- `attempt` is stored on no event, so it is derived: attempt n of an Issue starts at its n-th `admitted` event (ordered by `at, id`) and
-- runs until the next one. An event belongs to the attempt whose window holds it; what came before the first admission (a note on a queued
-- Issue) is the first attempt's, and an Issue never admitted is attempt 0 with all its events. Nothing here reads the usage tracker's
-- tables: a consumer joins `lead_session_ids` with its own session windows. Review rounds are stored nowhere (only `derived.review` tier and coverage),
-- so there is no column for them.
--
-- `landed_at` is the `mergedAt` of the attempt's first `ship` (the newest commit's time at that ship); the events carry no earlier one.
-- `outcome` is `issues.outcome` for the Issue's last attempt and `retried` for an earlier one. `parks` counts events, not states: a
-- `lead_gone` is counted whether it queued the next attempt or parked, `parked` is a `park` or the third regression.
-- `verify_first_pass` is true when the first hold ended `verified` with no `verify_red` or `regression` before it.
-- `first_hold_decided` is true when the attempt has a `verified`, `verify_red` or `regression` event: the first hold has a verdict. The
-- first-hold KPI counts only decided attempts; one still in its first hold, or dropped mid-hold, is excluded and counted as open.
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
           WHERE kind IN ('note', 'retier', 'reopen')
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
