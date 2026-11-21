-- A stalled Replan (Issue 2752) remembers the head it was filed for and what waited behind it then: the head's Needs you
-- card lists what went ahead without the owner's answer (behind it then, no longer now). Expand only: older rows keep NULL.
ALTER TABLE factory.replans
  ADD COLUMN head_issue text,
  ADD COLUMN held jsonb;
CREATE INDEX replans_head_issue_idx ON factory.replans (head_issue) WHERE head_issue IS NOT NULL;
