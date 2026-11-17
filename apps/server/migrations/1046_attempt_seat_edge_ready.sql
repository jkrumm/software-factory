-- Two facts the KPIs need and no table held. Expand only; each column is null where nothing recorded it.
--
-- 1. The seat an attempt's lead ran on, kept on the attempt's row (`lead_started` carried it in its payload, which no
--    join by attempt could split cost or first passes by). Set when the lead starts, in the transaction that records
--    `lead_started`. Attempts started before this column are filled from their applied `lead_started` event; one whose
--    event carried no seat stays null.
ALTER TABLE factory.lead_attempts
  ADD COLUMN tier text CHECK (tier IN ('haiku', 'sonnet', 'opus')),
  ADD COLUMN effort text CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));

UPDATE factory.lead_attempts a
SET tier = e.payload #>> '{seat,tier}', effort = e.payload #>> '{seat,effort}'
FROM factory.issue_events e
WHERE e.issue_id = a.issue_id AND e.kind = 'lead_started' AND e.result = 'applied'
  AND (e.payload ->> 'attempt')::integer = a.attempt
  AND e.payload #>> '{seat,tier}' IN ('haiku', 'sonnet', 'opus')
  AND e.payload #>> '{seat,effort}' IN ('low', 'medium', 'high', 'xhigh', 'max');

-- 2. Since when an Issue held by this edge would have been admitted without its `after` edges: the first look of an
--    unbroken run of looks in which nothing else kept it out (no Spec verdict pending, no finalizing lead, no stopped
--    line) and every admission rule (accounts, load, memory, lanes) passed for it. Each admission look sets it on the
--    Issue's unsatisfied edges and clears it on a look that finds the Issue refused for another reason; satisfying an
--    edge freezes it. Null: no look saw the Issue ready behind this edge, so its wait was no longer than what else held it.
--    An edge is `needed` over [created_at, satisfied_at] to the extent that interval is not ready: with `ready_since` set
--    the Issue sat ready behind this edge from `ready_since` until `satisfied_at`; the edge's `inferred_by` says who added it.
ALTER TABLE factory.planning_edges ADD COLUMN ready_since timestamptz;
