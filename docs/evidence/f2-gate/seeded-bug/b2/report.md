# Seeded bug, run b2: ABORTED (fixture defect)

The scratch repo committed the production config through git with core.autocrlf=input, which strips the CR that arms the seed. A lead had started (it reported one phase) and was stopped by hand within seconds; no ship, no hold (see the issue events). Counts as one of the three runs. Not a result about the machine.

```
05:19:31|created|created:36
05:19:33|classified|classified:36
05:19:36|admitted|admit:36:1
05:19:54|phase|36:1:phase:ea591553-cdf9-45ef-8106-e81771426ff5
05:19:59|stop|stop:36:gd-b2
05:20:02|worktree_kept|worktree_kept:36:1
05:20:02|issue_finalized|issue_finalized:36:1
```
