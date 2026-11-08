-- Which class of finding filed which Issue. The loops (friction, hygiene) judge a class by the outcomes of its Issues and
-- stop filing one that is mostly dropped or cancelled. A fact only: the Issue's filed time, closure and outcome are read
-- from issue_events and issues, never stored here. No foreign key: the work domain owns issues (intake does the same).

CREATE TABLE factory.loop_findings (
  issue_id text PRIMARY KEY,
  loop text NOT NULL CHECK (loop IN ('friction', 'hygiene')),
  repo text NOT NULL,
  -- the kind of finding: a probe, `judgment:<kind>`, or a friction pattern's first key segment
  class text NOT NULL,
  -- the finding's own key (`cochange:a|b`, `judgment:stale:docs/x.md`, `touch:woken`)
  key text NOT NULL
);

CREATE INDEX loop_findings_by_class ON factory.loop_findings (loop, repo, class);

-- Backfill from the signals the loops filed so far, so the history counts at once. The earliest signal of an Issue made it;
-- the finding is read back from the signal text the loops wrote (`Probe:`, `Judgment:`, `Pattern:` lines).
INSERT INTO factory.loop_findings (issue_id, loop, repo, class, key)
SELECT s.issue_id, f.loop, s.repo, f.class, f.key
FROM (
  SELECT DISTINCT ON (s.issue_id) s.issue_id, i.repo, s.text
  FROM factory.intake_signals s
  JOIN factory.issues i ON i.id = s.issue_id
  WHERE s.trust = 'agent' AND s.state IN ('filed', 'amended', 'promoted') AND s.issue_id IS NOT NULL
  ORDER BY s.issue_id, s.received_at
) s
CROSS JOIN LATERAL (
  SELECT
    regexp_match(s.text, '(?:^|\n)Probe: ([a-z]+) \(([^\n]+)\)') AS probe,
    regexp_match(s.text, '(?:^|\n)Judgment: ([a-z]+) document ([^\n]+)') AS judgment,
    regexp_match(split_part(s.text, E'\n', 1), '^Pattern: .* \(([^()]+)\)$') AS pattern
) m
CROSS JOIN LATERAL (
  SELECT 'hygiene' AS loop, split_part(m.probe[2], ':', 1) AS class, m.probe[2] AS key WHERE m.probe IS NOT NULL
  UNION ALL
  SELECT 'hygiene', 'judgment:' || m.judgment[1], 'judgment:' || m.judgment[1] || ':' || m.judgment[2]
    WHERE m.probe IS NULL AND m.judgment IS NOT NULL
  UNION ALL
  SELECT 'friction', split_part(m.pattern[1], ':', 1), m.pattern[1]
    WHERE m.probe IS NULL AND m.judgment IS NULL AND m.pattern IS NOT NULL
) f
ON CONFLICT DO NOTHING;
