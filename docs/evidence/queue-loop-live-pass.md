# The queue loop: one live pass

Issue 315, plan row `queue-loop`. Deployed 2026-11-08 as `15c54ef`; the first pass ran on the live core within a minute of
the health check.

**What it saw.** Repo `software-factory`: five queued Issues (323, 324, 325, 326, 328), four of them waiting for nothing.
Two or more candidates, no cycle, a shape never asked: the loop claimed round 1 in `factory.queue_asks` and called
`factory-queue` once (6 s).

**What `factory-queue` said.** One edge, no order change. The reason it gave for the order: "The factory order already
follows priority, and no queued pair has a tie that the age or size rules would change."

| Edge | Reason (the workflow's words) | Outcome |
|-|-|-|
| `issue_328` after `issue_316` | Both fix path leakage in the tests/scenarios/quality scenario git repo, so a parallel change would collide on the same support code. | applied through `addAfter` |

**What the loop did next.** `read chain` lists `issue_328 -> issue_316` and `blocking: { issue_328: [issue_316] }`. The
passes after it (the interval is 10 s) asked nothing: the queue's shape after the edge is stored as `after_shape` on the
ask, so the loop's own edge is not a new shape, and `loop list` shows `droppedKicks: 1` for the kick it did not send
itself. `lastSummary` on a later pass: "looked at 2 repo(s); asked 0, applied 0 edge(s), refused 0, skipped for budget 0".

Read with `factory read chain`, `factory loop list` and the `queue_asks` row (`pg` of the cutover runbook).
