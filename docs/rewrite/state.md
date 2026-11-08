# Rewrite state

**The orchestrator's ledger: one row per package of `docs/rewrite.md`.** Read with `docs/rewrite.md` after every start or
compaction, before acting. Updated on every start, integration and send-back.

- Branch `rewrite`, made from master at `a3065ce` on 2026-11-07. Master's checkout and the running factory stay untouched.
- Worker worktrees: `../rw-<n>-<slug>` beside this one (under the main checkout's `.claude/worktrees/`), branch
  `rw/<n>-<slug>` off `rewrite`. Briefs: `docs/rewrite/briefs/<n>-<slug>.md`. Reports: `docs/rewrite/reports/<n>-<slug>.md`.
- Watching: a background `hc wait <terminal>` per running worker (wakes on any turn end) plus a session cron at :17 and
  :47 that reads every running worker's screen and steers. Both die with the session: re-arm them after a restart.
- Start a worker with the account dir checked, never a bare `eval`:
  `DIR=$(claude-account pick --lane lead | sed -n "s/^export CLAUDE_CONFIG_DIR='\(.*\)'$/\1/p"); test -d "$DIR"`, then
  `hc run ... -- env CLAUDE_CONFIG_DIR="$DIR" claude ...`. `unset CLAUDE_CONFIG_DIR` is the picker spilling to the work
  account (`--why` says `picked=iu reason=spill`): never start on it; re-pick, and if only spill comes back, wait.
- Status words: `pending`, `running`, `sent back`, `integrated`.

| # | Package | After | Status | Terminal | Branch | Last commit | Evidence |
|-|-|-|-|-|-|-|-|
| 0 | Skeleton | | integrated | t1f1 (removed) | `rw/0-skeleton` (merged, deleted) | 7e6163b (merge), d36d1d5 | `reports/0-skeleton.md`; `make check` on `rewrite` after merge: 83 unit, 6 scenarios pass; rd dry run via the new CLI (worker's evidence) |
| 1 | Kernel and work | 0 | integrated | t1f4 (removed) | `rw/1-kernel-work` (merged, deleted) | fc5a8ac (merge), 9534b98 | `reports/1-kernel-work.md`; `make check` on `rewrite` after merge: 124 unit, 10 scenarios |
| 2 | Intake | 1 | integrated | t1f7 (removed) | `rw/2-intake` (merged, deleted) | df0862a (merge), 8dfda67 | `reports/2-intake.md`; `make check` on `rewrite`: 559 unit, 49 scenarios |
| 3 | Planning and capacity | 1 | integrated | t1f5 (removed) | `rw/3-planning-capacity` (merged, deleted) | 1e84834 (merge), 441c93c | `reports/3-planning-capacity.md`; `make check` on `rewrite`: 721 unit, 85 scenarios |
| 4 | Leads | 1 | integrated | t1f8 (removed) | `rw/4-leads` (merged, deleted) | 3478091 (merge), 650be3a | `reports/4-leads.md`; `make check` on `rewrite`: 336 unit, 37 scenarios; five shared-file conflicts resolved as unions |
| 5 | Quality | 1 | integrated | t1f9 (removed) | `rw/5-quality` (merged, deleted) | e1390ff (merge), bb10eef | `reports/5-quality.md`; `make check` on `rewrite`: 624 unit, 62 scenarios; one outbox runner, real checkout |
| 6 | Checkpoints | 1 | integrated | t1f6 (removed) | `rw/6-checkpoints` (merged, deleted) | 1e5b694 (merge), 4ab823f | `reports/6-checkpoints.md`; `make check` on `rewrite`: 183 unit, 20 scenarios |
| 7 | Loops and agw | 2, 6 | integrated | t1fc (removed) | `rw/7-loops-agw` (merged, deleted) | f637cef (merge), b49162b; agent-workflows 97dac43 deployed | `reports/7-loops-agw.md`; `make check` on `rewrite`: 759 unit, 98 scenarios; six live agw calls in the report; `agw factory-{steward,triage,ask}` answer on the mini |
| 8 | API, read models, CLI parity | 2 to 7 | integrated | t1ff (removed) | `rw/8-api-parity` (merged, deleted) | bc3f37c (merge) | `reports/8-api-parity.md` (parity table, client changes for 9); `make check` on `rewrite`: 941 unit, 195 scenarios |
| 9 | Cutover | 8 | window 1 held and closed; fixes before window 2 | t1fh (removed) | `rw/9a-cutover-tools` (merged, deleted) | 691e781 (merge 9a) | `reports/9a-cutover-tools.md`, `cutover-runbook.md`; worker's rehearsal: 255 Issues, 212 match, 43 explained, 0 unexplained; way back boots the old core; `make check` on `rewrite`: 969 unit, 195 scenarios (8 cutover skip without the copy) |

## Log

- 2026-11-07: ledger opened.
- 2026-11-07: package 0 started in t1f1, worktree `../rw-0-skeleton`.
- 2026-11-07: package 0 integrated at 7e6163b; `make check` green on `rewrite`; worker removed.
- 2026-11-07: package 1 started; first start (t1f3) had an empty CLAUDE_CONFIG_DIR, killed; restarted as t1f4.
- 2026-11-07: package 1 reported (121 unit, 10 scenarios); sent back for numbered Issue ids and the .begin rule.
- 2026-11-07: package 1 integrated at fc5a8ac; packages 2 to 6 started in parallel (t1f7, t1f5, t1f8, t1f9, t1f6).
- 2026-11-07: package 6 integrated at 1e5b694; workers 2 to 5 told to use `--thread rw-<package>` for reviews.
- 2026-11-07: package 4 integrated at 3478091.
- 2026-11-07: package 5 reported; sent back for the integration with package 4.
- 2026-11-07: package 2 integrated at df0862a; package 3 sent back for its wiring into 2, 4 and 6.
- 2026-11-07: package 5 integrated; package 3 still wiring; package 7 briefed, starts after 3.
- 2026-11-07: package 3 integrated at 1e84834; packages 0 to 6 done.
- 2026-11-07: package 7 started in t1fc.
- 2026-11-07: package 7 integrated at f637cef; agent-workflows' red master test filed as factory Issue 292 (old core).
- 2026-11-07: package 8 started in t1ff.
- 2026-11-07: owner: the cutover runs in watched windows, then a burn-in with reports on day 3 and day 7 (NL24).
- 2026-11-07: package 8 integrated at bc3f37c; packages 0 to 8 done; package 9 (cutover in windows, NL24) next.
- 2026-11-07: package 9a (the cutover's tools, live read-only) started in t1fh.
- 2026-11-07: FACTORY_AGENT_TOKEN and FACTORY_DOOR_TOKEN created and seeded (owner at the MacBook).
- 2026-11-07: package 9a integrated at 691e781; next: the orchestrator's own rehearsal, then window 1.
- 2026-11-07: orchestrator's rehearsal (P1) held: 256 Issues, 213 match, 43 explained, 0 unexplained; 1760 mapped events applied, 0 refused; the old core booted on the way back.
- 2026-11-07 17:4x **WINDOW 1 LIVE**: old queue drained (W1), no leads (W2), old server stopped (W3), schemas swapped as
  admin (W4: `factory_legacy` = old, 256 Issues), new core deployed 75573dd (W5, previous-sha 089b35c = old core),
  new queue drained (W7), import 256 Issues / 1760 events applied / 0 refused, idempotent, compare 0 unexplained (W8).
  Way back if this session dies: runbook "The way back" B1 to B8.
- 2026-11-07: window 1: W9 to W12 done (restart hang worked around by killing the stuck PID); W13 scratch drill running; shutdown fix worker t1fm on `rw/9b-shutdown`.
- 2026-11-07: window 1: W13 drill done in fact (Issue 298, lead on me, pushed, closed done); real Issue 299 filed on agent-workflows as an owner signal.
- 2026-11-07 17:50: **window 1 closed by the way back**; old core live (089b35c, queue run, software-factory drained); new core's data kept in `factory_rewrite`. Next: merge `rw/9b-shutdown`, runbook stop fallback, drill fix, Issue 297, then window 2.
- 2026-11-07: 9b (shutdown) merged; 9c (before window 2: signal caller, drill, runbook stops, door after rollback) running in t1fq; FACTORY_SIGNAL_TOKEN dialog pending in the human queue.
- 2026-11-07 18:50 **WINDOW 2 LIVE** (overnight): new core b2367ff (after two fix deploys), queue `run` for every own repo, software-factory and
  the work repos drained; old core's release pinned in `data/keep-releases`. Way back: B1 to B8, and **before B6 write
  089b35c50d5fc5160bc32072d38260b79b882b83 into `data/previous-sha`** (a redeploy moves it to the last new-core release).
  The CLI and the import need the optional signal ref left out until the token is seeded (`/tmp/rw-fx.env.tpl`; import.sh
  does it itself now).
- 2026-11-07 19:00: window 2 verified live (`make verify` all checks passed); window watch cron at :07 and :37 (session-only; re-arm after a restart).
- 2026-11-07 19:31: window 2: kill drill green (Issue 300: kill -9 between admit and lead, one lead, closed done).
- 2026-11-07 19:33: window 2: kill-during-lead drill green (Issue 301).
- 2026-11-07 23:15: window 2: client patches applied (dotfiles e21e19f, Iris 81dd1ad); FACTORY_SIGNAL_TOKEN made and seeded, core restarted with it; Hermes patch next.
- 2026-11-07 23:20: **handed over to the planning session.** Done: window 2 live on b2367ff (queue `run` for own repos; software-factory and work repos drained; old core 089b35c pinned in `data/keep-releases`); kill drills green (Issues 300, 301); client patches applied and pushed (dotfiles `e21e19f`, Iris `81dd1ad`, check-server green); FACTORY_SIGNAL_TOKEN made, seeded, core restarted with it (signal caller answers 403 on a read). Half-done: Hermes patch (`docs/rewrite/client-patches/hermes-agent.patch`) not applied; no real filing through `rd issue` tried yet (the window's first check per the new rule); Issue 297 still queued in drained software-factory, undecided; the "server-only refs in their own template" design fix not built. Uncommitted: nothing (rewrite, dotfiles, Iris clean). Crons d16cb7a9 and c255ca06 deleted; no workers running; `/tmp/rw-fx.env.tpl` is a leftover CLI template copy, now unneeded (the real template resolves).
- 2026-11-08 00:05: **the new core is master.** The planning session took over at 23:20. First real filing through `rd issue` worked (Issue 302, Hermes' signal caller, lead started within a minute). master's Beszel refs merged into `rewrite`; the rd scenarios stub `secrets-run` (exit 127 since dotfiles e21e19f); `make check` 996 unit, 201 scenarios. `rewrite` merged into master (dc9986d), `make deploy` from master and `make verify` green. The rows after the cutover are in `docs/plan.yaml` (Issues 304 to 308 filed, the Console chain waiting on `cutover-close`), `leads: 2` here, and **every repo on `run`**, the work repos included as on the old core. Old core 089b35c stays pinned for the way back until the day-7 burn-in report. Night watch: a session cron at :07 and :37.
- 2026-11-08 00:20: row `cutover-close` done (Issue 304, 8b331a4 deployed by its lead): `legacy/` is gone; the chain filed 310 to 313 at once and the lead filed 309 itself. Watch: health ok, no loop errors, three leads (297, 305, 312), memory 54% free, me2 at 96% weekly. The launcher's 'signal token does not resolve' and 'beszel intake is off' lines do not describe the live server: its process (on 7793) carries all three Beszel settings and the signal token answers 403 on a read. Where the lines come from is not yet traced.
- 2026-11-08 00:47: rows `parallel-leads` (297, fail-closed deploy locks 58bf7d7), `server-only-refs` (305, .env.server.tpl 25a69e1) and `queue-workflow` (312, agent-workflows) done; 307 watching its ship; `queue-loop` filed (315). Issue 314 (verify sourced the removed optional-refs.sh) looks stale: master's verify passes; noted for its lead to confirm and close. Health ok, memory 56% free.
- 2026-11-08 01:16: rows `triage-kind` (306), `queue-summary` (307), `readme` (308) and `docs-new-core` (310) done, plus 309 (REVIEW.md); the chain filed `hermes-factory-skill` (318); leads on 311 (Console shell), 313 (friction loop), 318. Leads filed two findings of their own: 316 (CI red on the runner: two ship-gate scenarios) and 317 (`issue ship` times out on the client while the server finishes); both set above the Console (prio 6 and 8). 314 cancelled as stale. Health ok, memory 54% free.
- 2026-11-08 01:50: rows `friction-loop` (313) and `hermes-factory-skill` (318) done; the chain filed `hygiene-loop` (325). The friction loop's first pass filed five Issues (320 to 324) from 280 mostly imported Issues at raw-count thresholds: 320 to 322 cancelled as noise (322 is the review gate NL23 removed), 323 and 324 kept below the Console; recalibration filed as 326 (new-core events only, rates, amend the open friction Issue). 319 cancelled as a duplicate of 316 by a lead (triage did not merge it). My own slip: 327, a second filing of 326, cancelled: `issue new` skips amend-or-new by design.
- 2026-11-08 02:20: 317 (`issue ship` client timeout) done. Console shell (311) built, live on master (ef09c39..f77e117, 13 Playwright specs, screenshots in docs/evidence/console-shell/) and waits on an Errand: every tailnet node is tagged, so no request carries Tailscale-User-Login and the listener stays off until the owner joins a device under his own login and the login is in ~/.config/factory/env; the Console rows after it wait on this. Not in effect yet (0 user-owned peers, no login set). Leads filed 328 (quality scenarios race under load) and an infrastructure incident opened 329 (the mini's disk, 80% used, 181 GiB free; a dotfiles lead on it). Memory 40% free.
- 2026-11-08 02:47: rows `queue-loop` (315) done; 316 done and CI is green on master again (ba4691e, d1b35ad); incident 329 closed as a false alarm (an 8 GB/h extrapolation over 20 minutes of a transient swing). Working: 325 (hygiene loop), 326 (friction recalibration). Console shell (311) still waits on the owner's tailnet login (none set, 0 user-owned peers). Memory 56% free.
- 2026-11-08 03:16: 326 (friction recalibration) and 328 (scenario race, already fixed by #103) done. Working: 325 (hygiene loop, lead active), 330. Console shell (311) still waits on the owner's tailnet login. Memory 53% free.
- 2026-11-08 03:50: the hygiene loop (325) is live (#107, #109) and its first pass swept thirteen projects at the 10 s tick (now 15 min), filing 30 signals. Two findings, both fixed: agw allows reads below a directory by its canonical name and the macOS temp dir is a link, so `factory-hygiene` answered nothing until the checkout moved under `realpath(tmpdir())`; and the co-change probe at 6 together and 0.7 filed coupling by design (an API client with its types, a manifest with package.json, a Makefile with its script), so it is now 15 together at 0.85, one finding a pass, and manifests are ignored. The cochange signals already filed in other repos are noise to close when their Issues start.
- 2026-11-08 04:25: the hygiene pass's Issues ran out overnight: 13 done across nine repos (two red default-branch checks in dotfiles and Iris, five stale or slop documents, three dependency sets), 323 dropped as old-core history; the seven co-change Issues were cancelled at 03:50 (probe recalibrated in 325). Rows `hygiene-loop` (325) done. Finding: lead 325 worked in the shared main checkout (a branch there) instead of its worktree; noted, and the checkout is back on master. The Console was held on the owner's tailnet login: the orchestrator split publishing into Issue 359 (it carries the Errand) and let 311 ship with the listener off; `console-shell` done, and the chain filed 360 (Needs you), 361 (artifact page), 362 (Herdr glance).
- 2026-11-08 04:55: two findings from Issue 350 (free-planning-poker deps, merged green, watch red): (1) the watch reads only the Makefile (main.ts wires makefileProjects; project.yaml's deploy mode, hold and verify never reach quality), so a repo with CI deploys and a no-op deploy target is asked for make version - Issue 370, prio 9; (2) the lead raised three Decisions with recommendation, checked, consequence and worthAsking null and the Judge never ran, so they reached Needs you - Issue 371, prio 7. 350 answered by the orchestrator: close on make verify, no repo change. Hygiene now sweeps linewatch (366 to 369). Console: 360 and 361 building; 359 holds the owner's tailnet Errand.
- 2026-11-08 05:17: `console-needs-you` done (360). 350 closed done (PR #301, 26 checks green). A second case of the watch bug (Issue 366, linewatch: project.yaml deploy mode none, a print-only deploy target, make version demanded): answered by the orchestrator, added to 370 as a scenario; 370 building. Memory 44% free.
