-- One ledger for what a loop filed (issue 2597): `loop_findings` takes the selfwatch loop's and the throughput loop's rows and
-- gains the figure a finding was filed against and a verdict once its Issue closed (moved, flat, worse, unmeasured; null until
-- read). Expand only: columns added, two tables copied, nothing dropped (the old tables stay unread until the contract row
-- drops them). (The runner holds the migration advisory lock around this file.)

ALTER TABLE factory.loop_findings DROP CONSTRAINT loop_findings_loop_check;
ALTER TABLE factory.loop_findings
  ADD CONSTRAINT loop_findings_loop_check CHECK (loop IN ('friction', 'hygiene', 'selfwatch', 'throughput'));

ALTER TABLE factory.loop_findings
  -- every loop: when it filed, the signal it filed, the number the finding was filed against, and what came of it
  ADD COLUMN filed_at     timestamptz      NOT NULL DEFAULT now(),
  ADD COLUMN signal_id    text,
  ADD COLUMN figure       double precision,
  -- the figure read again once the Issue closed (throughput: three days after its ship), and the verdict from the two
  ADD COLUMN measured     double precision,
  ADD COLUMN measured_at  timestamptz,
  ADD COLUMN verdict      text CHECK (verdict IN ('moved', 'flat', 'worse', 'unmeasured')),
  -- throughput: the unit and target of the figure, what the ranking said it cost, the ship its after is measured from, and
  -- the earlier Issue of the same subject this one comes back from
  ADD COLUMN unit         text,
  ADD COLUMN target       double precision,
  ADD COLUMN direction    text CHECK (direction IN ('up', 'down')),
  ADD COLUMN cost_minutes double precision,
  ADD COLUMN shipped_at   timestamptz,
  ADD COLUMN reopens      text,
  -- selfwatch: the loop's memory of the subject (the key): the evidence it filed on and when it saw and cleared it
  ADD COLUMN evidence_hash text,
  ADD COLUMN first_seen_at timestamptz,
  ADD COLUMN last_seen_at  timestamptz,
  ADD COLUMN cleared_at    timestamptz;

-- The rows of before: filed when their Issue was.
UPDATE factory.loop_findings lf SET filed_at = f.at
FROM factory.issue_events f
WHERE f.issue_id = lf.issue_id AND f.kind = 'filed' AND f.version = 1;

-- The throughput ledger, one row per Issue (a finding recorded without one, a repeat of an Issue closed lately, has no row).
-- The status becomes the verdict and the ship: open and shipped have none yet, dropped is an Issue closed without a ship.
INSERT INTO factory.loop_findings
  (issue_id, loop, repo, class, key, filed_at, signal_id, figure, measured, measured_at, verdict, unit, target, direction,
   cost_minutes, shipped_at, reopens)
SELECT t.issue_id, 'throughput', t.project, t.kpi, t.kpi || ':' || t.subject, t.filed_at, t.signal_id, t.before, t.after,
  t.after_at,
  CASE WHEN t.status = 'dropped' THEN 'unmeasured' WHEN t.status IN ('moved', 'flat', 'worse', 'unmeasured') THEN t.status END,
  t.unit, t.target, t.direction, t.cost_minutes, t.shipped_at, r.issue_id
FROM factory.throughput_findings t
LEFT JOIN factory.throughput_findings r ON r.id = t.reopens
WHERE t.issue_id IS NOT NULL
ON CONFLICT (issue_id) DO NOTHING;

-- The self-watch memory, one row per subject: kept on the newest Issue of the subject the old row's signal reached.
INSERT INTO factory.loop_findings
  (issue_id, loop, repo, class, key, filed_at, signal_id, evidence_hash, first_seen_at, last_seen_at, cleared_at)
SELECT DISTINCT ON (s.issue_id) s.issue_id, 'selfwatch', i.repo, w.kind, w.subject_key, w.last_filed_at, w.signal_id,
  w.evidence_hash, w.first_seen_at, w.last_seen_at, w.cleared_at
FROM factory.selfwatch_findings w
JOIN factory.intake_signals s ON s.id = w.signal_id
JOIN factory.issues i ON i.id = s.issue_id
WHERE s.issue_id IS NOT NULL
ORDER BY s.issue_id, w.first_seen_at
ON CONFLICT (issue_id) DO NOTHING;

CREATE INDEX loop_findings_by_key ON factory.loop_findings (loop, key, filed_at DESC);
