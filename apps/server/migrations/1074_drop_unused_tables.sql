-- Contract step of the tables the cycle stopped using. Each was last read or written by the commit named here (all on
-- 2026-11-20, three days before this migration), and `rg` finds no reference to any of them under apps/, packages/, scripts/
-- or tests/ outside the migrations that made them:
--   import_issues, import_events  (0900)  7ef7bb6f  the friction read cuts at the counting epoch; the importer is deleted
--   admission_shadow              (1024)  11b065d4  the shadow modes leave; nothing records a shadow decision
--   selfwatch_findings (0998), throughput_findings (1027)  0cc0b339  copied into loop_findings by 1061
--   queue_asks                    (0960)  0a9d4ff9  copied into loop_calls by 1062
-- The data the cycle keeps lives in loop_findings and loop_calls. Not dropped: host_samples.memory_used_pct, which rows from
-- before 2026-11-16 still need until the 14-day prune has passed them (2026-11-30).
-- (The runner holds the migration advisory lock around this file.)

DROP TABLE factory.import_events;
DROP TABLE factory.import_issues;
DROP TABLE factory.admission_shadow;
DROP TABLE factory.selfwatch_findings;
DROP TABLE factory.throughput_findings;
DROP TABLE factory.queue_asks;
