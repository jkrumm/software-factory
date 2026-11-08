-- The backfill of 0993 read the signal text with its line breaks, but intake stores a signal's text on one line (a line
-- break is a space), so it matched nothing and the history did not count. This reads both forms: the separator after the
-- finding's own line is a line break or a space. Rows 0993 wrote (and any a loop recorded since) stand: ON CONFLICT DO NOTHING.
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
    regexp_match(s.text, '(?:^|[\n ])Probe: ([a-z]+) \((.*)\)[\n ]Evidence \(') AS probe,
    regexp_match(s.text, '(?:^|[\n ])Judgment: ([a-z]+) document (.*)[\n ]Finding: ') AS judgment,
    regexp_match(s.text, '^Pattern: .* \(([^()]+)\)[\n ]Window: ') AS pattern
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
