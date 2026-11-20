-- One Issue may carry several findings (issue 2635): a hygiene pass of one repo files its findings as keyed sections of one
-- Issue, each section its own row in `loop_findings` with its own class, figure and verdict, so each still heals, reopens and
-- is judged by itself. The primary key widens from the Issue to the Issue and the key; every row that exists keeps a unique
-- pair. (The runner holds the migration advisory lock around this file.)

ALTER TABLE factory.loop_findings DROP CONSTRAINT loop_findings_pkey;
ALTER TABLE factory.loop_findings ADD PRIMARY KEY (issue_id, key);
