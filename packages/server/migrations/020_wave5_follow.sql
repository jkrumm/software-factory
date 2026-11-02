-- F2 Wave 5: what `factory status` and `factory issue show` look up per Issue (docs/design.md §4 "Following an Issue"). Additive indexes:
-- a rollback to the previous release ignores them.

-- The last `ship` or `close` of an Issue, for the evidence still missing.
CREATE INDEX issue_inbox_ship ON factory.issue_inbox (issue_id, id) WHERE kind IN ('ship', 'close');

-- The lead's last `phase` report.
CREATE INDEX issue_events_phase ON factory.issue_events (issue_id, id) WHERE kind = 'phase';
