# Learnings of the reset

One entry per wave and per surprise: what happened, where it fell apart, what the plan changed. Newest last. Facts with
evidence (a sha, a log line, a number); no narrative.

## 2026-11-04 night, before the loop

- **Machine load is the first bottleneck.** Load average 100–385 on 12 cores while two `agw check` runs, a factory
  `make check` and an iOS simulator (`xcodebuild`, ~180 processes) ran at once; tests timed out at 30–60 s in a different
  set each run and passed alone (agw `eval-mine.test.ts` 40/40). Change: one check at a time; the reset plan runs one wave
  at a time; `xcodebuild` needs the test slot (not yet enforced: `slot run` is fail-open and `agw check` does not take one).
- **The router, not the reviewer, made review expensive.** Docs-only HTML routed deep with a 3-vote. Fixed in agw
  `6cb7961`; deep is still 32 % of recent commits, almost all from REVIEW.md sensitive paths (`review-poc.md`).
- **Deep review pays.** It found the only real bug in six POC reviews (migration 029 edited after it was applied) and two
  real bugs in Step 0 (an expired ask returning after a restart; an Enter-only retry losing a note).
- **Per-commit coverage costs a review per nit fix.** A 2-line fix after round 2 needed its own light review before
  `covered` was true. Candidate change: coverage per ship range at the range's tier.
- **`/review --scope HEAD` reviews nothing.** A bare `HEAD` is a ref, so `merge-base(HEAD, HEAD)..HEAD` is empty and
  prepare says "no content change". Only lowercase `head` means the last commit.
- **A reviewer can misbehave at light.** One spawned two "noop" Explore agents and replied in prose after its JSON.
  Change: the Agent tool is for `review-verifier` at tier deep only (dotfiles `d991ef0`).
- **Pausing an agent creates an ask.** The iris lead declared `wait --on owner` for the simulator pause, which put it
  in the asks. Change for the health line: a wait with a known end time is not an ask.
- **The adversarial review caught three blockers in design v3** (dependencies not respected by admission, parks that only
  end by drop, a build order that broke `rd`). Change: rows 3 and 4 come first; roles go after dotfiles.
- **The wave gate failed closed on history.** `rd wave` refused the program lead because Wave 7's FV commits were reviewed
  under the old process (`/code-review high`), not agw v4, so `agw review covered` lists them. That code is deleted in the
  reset; reviewing it again would only spend quota. The lead was spawned through the factory directly
  (`factory spawn create software-factory-w8 --role lead`, pane t12x), the path `rd wave` itself takes. Change for row 7:
  the gate checks coverage of the wave's own commits only when they are still on the code path, or goes with `wave-gate.py`.

## Wave 1, cutover (row 0), 2026-11-05 00:05

- **The cutover took five calls and lost nothing.** `factory issue stop 51` (reason "superseded by the reset (RS8)") and
  `stop 52`..`55` ("dropped in the reset (RS8)") closed all five as `dropped`; finalize closed 51's pane `t8h` and removed
  its worktree `factory-51-1`, whose branch had no commit beyond master and a clean tree. After: no open Issue of
  software-factory; one open Issue in the estate (49, homelab-private, parked `lead_gone`); asks 7 (the handoff counted 9:
  the WeatherOrb iPhone, the Wave 8 cutover, the MacBook core, Issue 49, review `rv_kmnj…`, the two failed agw spawns).
- **Row 0's `queue set drain` was left out on purpose.** The reset loop itself spawns its workers through the queue; a drain
  would stop it. Change: `reset.md` Wave 1 never had the drain, design v3 §13 row 0 now says the drain is for a cutover
  that runs no loop of its own.
- **`issue show` does not say what an attempt holds.** The JSON has no worktree, branch or pane; finding out whether 51 had
  unlanded work took `spawn list` (pane), `git worktree list` and `git log master..factory/51-1`. Candidate for row 12:
  `issue_facts` carries the attempt's branch and its commits beyond the base.
- **Two of the seven remaining asks are machine failures** (the agw spawns failed 2026-11-02, `hand_off`). Step 0 stops
  new ones; these two expire by 2026-11-09. Row 6 moves such lines to the health line.

## Wave 2, dependencies (row 3), 2026-11-05 00:30

- **Built as one Sonnet worker in 6 min; deep review clean.** PR #37 (`7e616c0`, docs fix `272be2f`): `issue new --after`,
  admission skips an Issue with a `issue_deps` row and picks a project's first by the latest `prio` event then id, `issue prio`.
  `make check` 1703 pass in 348 s at load 6–10. Review routed deep (sensitive `http.ts`), Sonnet high, 105 s, 89k tokens,
  1 nit (stale "oldest" in design.md §4), fixed in a docs-only commit that routes none; `covered` true at once. `rd merge
  --no-check`: the only delta after the green check was that docs line. Deployed `272be2fb1429`, `make verify` all passed.
- **Live proof held.** Issue 59 (A) admitted 10 s after create; Issue 60 (B, `--after 59`) stayed `queued` while A was open
  and was admitted at 23:27:48.8Z, 6 s after `issue stop 59` at 23:27:42.5Z. `--after 58` (closed) was exit 2, `Issue 58 is
  closed already`, nothing stored.
- **A lead cannot end a no-change Issue.** Both scratch leads printed `ok` and then hit `close`: refused, "commit 5ca6423 is
  older than this attempt" and "commit e498857 is not on origin/master". A's lead turned that into a `decision` ask ("How should
  a no-change Issue be reported?"), B's lead made a commit only to have one. Change: `reset.md` Wave 4 step 1 — the brief's
  operating contract names the no-change end (`factory issue drop <id> --reason`), so it is neither an ask nor a fake commit.
- **The Stop send-back fired for a finished worker.** With the fan worker idle and the in-session `reviewer` subagent
  running, the Stop hook answered "1 worker still running". The cause is the workers rule, not the subagent: `stopCheck`
  (`rules.ts`) counts every child that is not `dead`, so an idle fan worker counts until `rd close`, while the `/wave` skill
  says a finished child counts as done. Change: the lead closes a worker (`rd close`) as soon as its diff is read, before
  ending a turn; the skill/rule mismatch goes to row 7 (dotfiles `/wave`). Row 4's `background_tasks` step stays (it is
  about the Issue send-back, `issueStop`).
- **The task notification showed the reviewer's reply HTML-escaped** (`&lt;id&gt;`, `->&gt;`). Submitting "verbatim" meant
  restoring `<`/`>`; agw accepted it. Candidate for `/review`: run the reviewer in the foreground so the reply is raw.

## Wave 3, parks end (row 4), 2026-11-05 00:30 — the spawn

- **Under load the spawn fell back to hc-direct on the wrong account.** At load 68–124 (an IuRoot `athena-l2` vitest run,
  not the reset's), `factory spawn create` timed out ("server unreachable … The operation timed out") and `rd fan` went
  hc-direct: pane t131 on `me`, at 95 % of its week (`picked=me reason=home`), outside the factory's wake. Killed after 26 s
  with no work, worktree removed, respawned through the factory on `iu` (t132). Change for row 7: `rd` retries the factory
  once before the fallback, and the fallback's picker honours the 94 % week mark. Machine discipline cannot hold the load
  down while other sessions run their own checks: the 40-load rule only gates this loop's checks.
- **A stale wake arrived while the next worker ran.** At 23:32Z the lead got "workers done: software-factory-reset-w2-deps
  idle", after that worker was `rd close`d and while `reset-w3-parks` (t132) was `working`: the note queued for Wave 2's
  wait was typed once the session was at its prompt. This is dropped Issue 53 ("a queued note makes an early wake"); it
  costs one turn and a re-declared wait. Change: none in the reset rows yet; row 7's lead playbook says to check
  `factory session list` on every wake before acting on it.

## Wave 3, parks end (row 4), 2026-11-05 02:00 — the build and the proof

- **Built by one Sonnet worker in 20 min; review took three passes.** PR #38 (`3c9b5c0`, fixes `407df59`, `c0b91c8`, docs
  `c868256`): deep round 1 found 2 important (a restart still told the owner "failed for good"; a gone lead's regression or
  answer was lost on restart) and 2 nits, round 2 confirmed the fixes and left 2 nits, a light pass covered the nit fixes.
  `covered` true; `rd merge` ran `make check` (1721 pass, 439 s). Deployed `14c4c7197ca0`, `make verify` all passed. The
  worker went outside its owned files three times (notify rule and text, the stop-check schema), each needed; it said so
  instead of stopping as the brief asked.
- **`make check` had one flake in an untouched file:** `hc-spaces.test.ts` "two starts at once" failed once in the full run
  and once in three runs alone at load ~10; it is a timing race, not load alone.
- **The restart works; the trigger had a gap.** Issue 62's lead pane t135 was `hc kill`ed at 00:30:44Z. `spawn list` read
  `lead-62-1 ended`, but the Issue stayed `working` for 29 min: `parkGoneLeads` sweeps only failed spawns ("a spawn that ended
  is found only by a note, for now"). An owner note at 00:59:19Z found it: `lead_gone` 01:00:00 (`working → queued`), finalized
  01:00:06, attempt 2 admitted 01:00:15 (t136), its brief carried the note once under "Notes from the owner", and the lead
  ended it with `drop` ("no change"). Change: a follow-up worker in this wave (`briefs/reset-w3b-ended-lead.md`): the sweep files
  `lead_gone` for an ended lead spawn after a 10-minute grace, never within 10 minutes of a `runner_restarted`.
- **An IuRoot test storm took the factory down twice.** ~120 vitest workers across `athena-a1..a7` worktrees drove the load to
  558 on 12 cores (00:35–00:58Z). The server lost its database lock ("the lock connection did not answer within 5000 ms;
  exiting"), and the launchd relaunch failed once on `secrets-run` ("only 0/2 refs of .env.tpl resolved; refusing to start");
  the next relaunch came up, its first tick ran 577 s (limit 240 s; `git did not answer in time` for 33 projects), then ticks
  succeeded from 00:57:42Z. It recovered without a hand. Change for row 10/RS7 and the machine: one test slot for every repo,
  IuRoot included (today `slot run` is fail-open and other sessions do not take it); until then the reset cannot keep the
  mini under 40 by its own discipline alone.
- **A Haiku lead cannot wait in the foreground.** The proof asked attempt 2 to `sleep 300`; the harness guard blocked a bare
  sleep and the lead dropped the Issue instead. Proofs that need a live lead use a long real command, not a sleep.
- **The follow-up closed the gap.** PR #39 (`afa38a9`, grace fix from its standard review's one nit: the fallback read
  `claimed_at`, which a start clears; now `assigned_at`), `make check` green, deployed `a2c4293f559a`, verify green. Live:
  Issue 63's lead t138 killed at 01:23:28Z with no note; `lead_gone` "spawn lead-63-1 ended" at 01:33:29Z (`working → queued`),
  finalized 01:33:30, attempt 2 admitted 01:33:39. Wave 3 cost: one worker run, one fix subagent, one follow-up worker and
  five reviews (deep ×2, standard, light ×2).

## Rotation 1 close-out, 2026-11-05 01:50Z

- **`rd merge` rebases, and coverage is by sha.** The chain gate refused rotation 2: three fix commits reviewed clean on their
  branches (`c0b91c8`, `c868256`, the grace fix) landed on master as `6695e5f`, `14c4c71`, `a2c4293` because master had moved
  (the lead's own docs commits) and `rd merge` rebased them; `agw review covered` counted them uncovered. Two light re-reviews
  (27 s, 33 k tokens together) made the range `5f1e361..HEAD` covered. Change for row 7: coverage matches by patch-id across a
  rebase, or `rd merge` keeps branch shas (merge commit); until then the lead pushes no master commit while a worker's branch
  is under review.
- **The chain gate's keyword stop refuses every reset rotation.** Wave 9's first step names `rd merge` and `make deploy`, so
  `rd wave` stopped it as outward-facing, though the plan authorizes both for this repo. Rotation 2 was spawned the way Wave 8
  was: `factory spawn create software-factory-w9 --role lead` with no parent (pane t13c, `iu`). Change for row 7: the gate reads
  an explicit `**Outward:** authorized` line on the wave, or goes with `wave-gate.py`.

## Wave 4, the lead (row 5), 2026-11-05 02:50 — the build and the proof

- **Built by one Sonnet worker in 12 min; review clean in one deep round.** PR #40 (`29530e2`, REVIEW.md fix `4a93d6b`): deep
  round 1 found 0 important and 3 nits (`docs/program.md` still said the program lead spawns with `--role lead`, REVIEW.md's hook
  rule missed the new stdout line, the lead's first admission uses the default cap), a light pass covered the REVIEW.md fix. Landed
  as a fast-forward push of the branch (it already sat on `origin/master`), so the reviewed shas are master's; `covered` true.
  Deployed `4a93d6b3da21`, `make verify` all passed, `factory role get lead` = sonnet/high.
- **Two deviations, both kept.** "Asking again replaces the question" is not what the code does (each `ask` inserts a new decision),
  so the brief does not say it. The lead cap waits (a timed 30 s recheck) instead of a `lead_cap` hold reason: the hold reasons are a
  CHECK constraint (migration 029), and a migration for a reason only a status line shows is not worth it before row 9 rewrites it.
- **`rd merge` failed on an untouched file:** `evidence.test.ts` "a note reaches the lead while the check runs" failed once in the
  merge train's full run (load ~17) and passed 3 of 3 alone. A load flake, recorded; the merge went as a fast-forward push.
- **The proof: a real bug, zero touch, 16 minutes.** Issue 64 "Fix the hc-spaces 'two starts at once' timing flake" (filed
  02:12:35Z, Classify `bug`, size `l`, `routine`, asked a different level: `clamped=true`), admitted 9 s later, lead `lead-64-1` on
  `iu` at **Sonnet high**. The lead found a real race, not a test bug: `HcRunner.start` took its start lock in the order the account
  registry reads finished, not in call order (3 of 10 runs failed before, 25 of 25 green after). PR #41, review **deep** (the runner
  is a sensitive path, `covered` true), merged, `make deploy` and `make verify` by the lead from the main checkout, shipped 02:28:31Z.
  One ship refusal (no `service` evidence after the merge), which the lead answered itself in 9 s. Attempts 1, owner touches 0.
  Window points: not attributable yet (`usage-tracker window --by issue` shows no Issue row; `iu` reports no 5 h reading).
- **The shared Postgres went down under the run, and nothing paged.** At about 02:40Z the default Colima VM died (its SSH refused,
  `docker` gone, `colima status`: "empty value"), taking the shared Postgres on :5432 with it; the factory exited on its lock
  ("terminating connection due to administrator command") and agw answered 500 to every `review` call. 25 min earlier the 02:15Z
  `vps-pg-backup` had failed in `pg_dump` with "could not resize shared memory segment … No space left on device". `colima-start.sh`'s
  supervisor did not restart a VM whose `colima start -f` process stayed alive; `make colima-restart` (dotfiles) brought it back in
  50 s and launchd relaunched the factory. Change: none in this plan (the VM is dotfiles' and vps's); for the owner: the supervisor
  watches the process, not `docker info`, and the container's shm is 64 MB under `max_locks_per_transaction=1024`.
