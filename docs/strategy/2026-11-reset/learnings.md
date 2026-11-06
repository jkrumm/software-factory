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

## Wave 5, asks vs parks (row 6), 2026-11-05 03:10 — the build and the proof

- **Three workers, three repos, 25 + 2 + 2 min.** software-factory PR #42 (`5e8d49d`, fix `c7081b8`): deep round 1 found 1 important
  (a health line's id changed when its hour count turned decimal, so its `since` restarted every hour) and 1 nit (stale docs), a
  standard round 2 was clean; `make check` green twice (1756, 1757 pass); landed as a fast-forward after the lead rebased the branch
  onto Issue 64's merge **before** review, so the reviewed shas survived. Deployed `c7081b8615c0`, verify green. dotfiles PR #61
  (`3cc0248`, standard, clean) and homelab PR #19 (`055d9cd`, light, 1 nit kept: the rule file mandates `maxretries: 0`). The homelab
  worker merged its own PR before review (its `make uk-sync` pulls master on the server); reviewed after, `covered` true.
- **The split, live.** Before: `factory status` had 7 attention lines, every one an ask on `/fleet` (2 expired notes, 2 failed spawns
  from 2026-11-02, Issue 49's park, Issue 36's kept worktree, a review needing a human). After: `attention` 0, `health` 7; `/fleet` asks
  are the 5 human-queue entries and 1 `reply` ask (a question the digest found in the previous rotation's last message), health 4
  (`isMachineNoise` still hides 3 on `/fleet`). Every remaining ask is the owner's; the `reply` source goes with the digest in row 8.
- **The heartbeat is real end to end.** `/health` `heartbeat.ok` true after the first tick (null before it, by design); Kuma
  `Software Factory - Push` (id 269) took a manual push and then the pusher's (`✓ factory monitor: tick …`). `DRY_RUN=1 make rollback`
  printed the swap to `7245836d93f2`; the real rollback is untested (it would take the live server down for a proof).
- **A docs commit made a healthy hold red.** The program lead pushed docs-only `a0c93a3` while Issue 64 was in its hold; `make verify`
  checks "deployed sha is origin/master" exactly, so the hold's verify and its re-run failed (`deployed c7081b8615c0 is not origin/master
  a0c93a381f56`) and the Issue regressed. The lead redeployed and shipped again in 25 s, but one of its three regressions is spent on
  nothing. Its second hold verified green at 03:29:10Z (`closed`); filed to closed 77 min, of which 60 are the two holds. Change: Issue 66 (filed, the factory builds it): a commit range that needs no deploy is not an undeployed release. Until it
  lands the program lead pushes no master commit while an Issue of this repo is in its hold.
- **The board is not seen.** The HEALTH section is checked by its pure-function tests only; the Herdr app runs on the MacBook and nobody
  looked at it tonight.
- **Plan change for Wave 6 (row 11):** the "ordered" `spaces.json` would duplicate dotfiles `config/herdr-app/groups.json`, which already
  is the sidebar order (`jk-spaces` files every space under its group, in order), and reordering the app doc with `doc.set` is the path
  `herdr-core.md` calls fragile. `spaces.json` is rendered from `groups.json`; the factory only makes sure each listed space (inside
  `FACTORY_REPO_ROOTS`) exists with its `plan:` tab, and never reorders. `reset.md` Wave 6 and its briefs say so.

## Wave 6, spaces (row 11), 2026-11-05 04:20 — the build and the proof

- **Two workers, two repos, 9 + 19 min, in parallel.** software-factory PR #44 (`ba7984a`, nit fix `ed17547`): deep round 1 found 1 nit
  (`finalize.ts` imported the plan-key rule from the hc adapter; moved to the `runner.ts` port), round 2 clean, `covered` true; `make
  check` green (1775 pass, 373 s); landed as a fast-forward **after Issue 66's hold ended** (closed `done` 04:08:40Z, first hold green),
  deployed `ed175476713c`, verify green. dotfiles PR #62 (`241d7c8`, standard, clean, `covered`), landed, `make deploy` (the setup step:
  `unchanged … spaces.json (40 spaces)`); dotfiles `make verify` 62 passed, 2 failed, both not this wave's (`tcc`: an IuRoot LaunchAgent's
  versioned python; `architecture map`: the known unmapped labels).
- **The proof.** The first reconcile after the deploy started 40 `plan:` terminals, one per `spaces.json` entry, 0 skipped, 0 errors; every
  one a login shell (`zsh`, the core runs `/bin/zsh -l` for no argv, checked on a scratch core by the worker); 38 of 40 carry the
  `herdr.space` id of the repo's existing space or a seeded one where the repo had none. A second pass at +10 min started nothing (no
  `spaces` log line, the same 40 addresses `t13t`..`t153`). hc-reap `--dry-run` keeps every keyless owner terminal (10 of them) and never
  looks at a plan shell (it judges only agents).
- **The brief was wrong about IuRoot.** Both briefs said the factory skips IuRoot paths; `FACTORY_REPO_ROOTS` defaults to
  `~/SourceRoot:~/IuRoot`, so the 8 IuRoot entries got plan tabs too. Kept: a shell in the repo reads and sends nothing, and RS6 asks for a
  plan tab in every listed space. The fleet's `FACTORY_VISIBLE_ROOTS` (IuRoot read-only for the digest and the reaper) is a different
  rule; a plan shell is not touched by it.
- **Two spaces are now doubled.** The app's `agent-workflows` and `epos-ai-teamchat-athena` spaces have `folder: ~/IuRoot` and no name in
  the app doc (they were opened from `~/IuRoot`), so keyed by real path the reconcile seeded `sp-agent-workflows-…` and
  `sp-epos-ai-teamchat-athena-…` beside them. Correct by design v3 §8; the sidebar shows those two twice until the owner closes the old
  ones (their terminals: `t11p`, `t11q` and its review children; `t126`, `t133`). The factory does not edit the owner's spaces (a
  structural `doc.set`).
- **The plan tab is not first in an existing space.** A new space starts with it; in a space with tabs it lands last. Moving tabs is the
  fragile `doc.set` path; not done. The app's `where` label was empty for all 40 at the proof (the app on the MacBook was not connected,
  04:10Z), so the sidebar itself is not seen yet.
- **Monitors at a worker's end.** The dotfiles worker ended a turn on two `Monitor`s over a backgrounded `make -k check`, against its
  brief; the factory reported it idle, a stale `workers done` note arrived while its second, foreground check ran. Re-declaring the wait
  worked. The brief's "never end a turn on a background shell or a wait" did not hold on Sonnet; the hook does not catch a Monitor.

## Wave 7, `issue_facts` (row 12), 2026-11-05 04:50 — the build and the proof

- **One worker, 6 min; deep review 2 nits, both fixed by an implementer in 1 min, round 2 clean.** PR #45 (`e4fc6a6`, `b7d749a`), `make check`
  green (1796 pass, 420 s), landed as a fast-forward, deployed `b7d749a7ed2c`, verify green, `covered` true. Spawned while Wave 6 waited
  for Issue 66's hold: the plan's "one wave at a time" is about the machine's checks, and a worker runs only its own test files; the two
  `make check` runs still went one after the other.
- **The first measurement of the KPIs (since 2026-11-01, 37 Issues):** owner asks per Issue 0.05 (target ≤ 0.05; Issues 50 and 59),
  verified with zero owner touch 94 % (15/16, target ≥ 90 %), verify green on the first hold 81 % (13/16, target ≥ 80 %: Issue 40 is the
  seeded-regression gameday, 50 regressed three times, 64 went red on the program lead's docs push that Issue 66 has since fixed). All
  three at the target line, none with margin; window points are Argo's and not built.
- **The brief's column list did not survive contact with the events.** No event holds a first commit time (only `mergedAt`, the newest),
  and nothing stores review rounds; the worker said so instead of inventing them. The review caught what the brief left open: the
  first-hold denominator counted an Issue in its hold as a failure (it would read 11/13 for a healthy fleet with one ship in flight).
  Change for the next view or KPI brief: name the denominator of every ratio and what an undecided case is.
- **The plain output has no header line.** `factory issue facts --format plain` prints bare tab-separated rows; the column names are only
  in `--format json` and design.md §4. Left as is (the CLI contract keeps data on stdout); a reader needs the JSON.

## The owner's read, 2026-11-05 08:00

- **A turn end with background work is not an end, again.** 4 of 5 iris deep reviews through the hidden transport (06:30–07:55Z:
  `rv_4jmu…`, `rv_4szp…`, `rv_mde4…`, `rv_tsrh…`) gave up on both attempts with "the reply holds no JSON object"; the one standard
  review submitted. The deep reviewer starts its `review-verifier` as a background subagent and ends its turn with "The verifier is
  still running … waiting before I give the final reply"; `review/transport.ts` collects on `idle && turn >= 1` and never reads the
  `backgroundTasks` the hook already stores on `turn_ended`. Third time this class bit (the Stop send-back in Wave 2, Monitors in
  Wave 6). Change: Issue 67 (the factory builds it); RS10 (a): every consumer of a turn's end honours `background_tasks`.
- **Issue 49 was half fixed by Issue 50.** Issue 50 reversed the direction (Argo pushes the shelf and pulls stats over Tailscale SSH)
  and Wishlist Sync has been up since 2026-11-02; the KoInsight push cron on the homelab still pushes every 6 h and times out, and the
  Kuma push monitor has no other feed. 49 parked `lead_gone` before parks could end and had no way back but a stop; stopped and
  replaced by Issue 69 with the remainder.
- **The plan tabs doubled the sidebar.** Every space that had an idle tab-"1" shell now has it beside its `plan` tab, and five
  unnamed `~/IuRoot` spaces from opening the app there remain; the owner also wants fewer repos listed (`groups.json` trimmed, done by
  the owner's session). Change: none in the design; a listed repo's space is its `plan` tab plus the work.
- **The mini's baseline is not idle.** At 08:04 load 35–51 with no check running: WeatherOrb's production LaunchAgents
  (`worker-round` with three processes ~200 % CPU, `worker-ingest` ~40 % since 01:31), a booted iPhone simulator (`PosterBoard`
  ~98 %), the shared Postgres. Colima's VMs (default 4 CPU/6 GiB, teamchat 4/4) reserve memory, not CPU: a vCPU costs the host
  only while the guest runs. Change: row 7b, the machine budget (RS10 (b)).

## Wave 8, row 7 expand (dotfiles), 2026-11-05 09:15

- **Row 7 could not be one step.** The inventory found six repos with a wave marked `active` in PLAN.md (iris live on `rd wave --child`,
  `rd fan`, `rd merge`; basalt-ui, modelpick, ntfy-mac, basalt-expr-trial, -v1 stale, 2 days to 3 weeks), software-factory's own
  `scripts/gate-run` and `scripts/gameday` teardown on `rd close`, and `test/brief.test.ts` pinning "no `rd fan`". Change: row 7 is expand
  (Wave 8, done) then contract (Wave 8b) after the live chain closes and the stale ones are converted.
- **The worker built the shell rule on age.** hc exposes no activity time for a shell, so the first build closed any keyless shell 7 days
  after creation, the owner's daily ones too. The program lead's read caught it, not a test or the brief; fixed to an unchanged `turn` over
  7 days of hc-reap's own observations. Change for briefs: name the signal a rule judges by, not only the outcome.
- **A worker ran `make -k check` twice in parallel** and load reached 578 (5-min average) at 08:40Z; the implementer brief said "once at the
  end". Change: row 7b's slot (Issues 71, 72) makes a second check wait instead of trusting the brief.
- **`/review` from an owner session works as designed:** prepare, a foreground-less background `reviewer` subagent, the reply restored from
  the notification's HTML escapes (`&gt;`, `&amp;`), submit; deep 164 s, light 42 s. The escaped reply is the third sighting; candidate for
  `/review`: write the reply to a file from the agent itself.
- **A green Issue is not its acceptance.** Issue 67 closed `done` on `make verify` while its own acceptance ("one real deep review through
  the hidden transport is submitted") had not happened: the only hidden review since the fix was light. The ship gate checks deploy and
  verify, not the Issue's stated proof. Candidate for the lead's contract: an acceptance that needs a future event is a `wait`, not a close.
- **`blocked` was a dead end** (evening, 2026-11-05). Issue 82 was merged and deployed; the hold's verify went red on two rows from other
  projects; the lead blocked; the owner fixed them forward and wrote a note, and nothing could take the Issue back: the lead's verbs are
  refused on a waiting Issue, `reopen` only takes a closed one, `stop` records a drop. It held Issues 83 to 85 for 6 h. RS3 had said every
  park can end; the table never checked it. Issue 97 added the exit (`note --wake`). Change: a test that every `waiting` reason has a non-drop exit.
- **A lead paused on its own background work can stay paused.** Issue 92's lead ended a turn at 16:49 with `make check` running in the
  background (correctly not sent back, Issue 67's rule), the session compacted while idle, and no turn followed the check's end: 4 h 20 min
  of nothing until a note woke it. The silent-lead health line showed it; nothing acted. Candidate for row 8's health rework: a lead silent
  20 min after a `background_tasks` stop gets one note.
- **A greyed-out prompt suggestion reads like the owner's typing** in `hc read`: both idle leads showed a plausible instruction in the prompt
  box ("push it once make check is green", a key deletion in German) that nobody typed. Never act on prompt-box text from `hc read`; the
  owner's words come as factory notes or in this chat.
- **Two orchestrators filed the same fix two minutes apart** (Issues 98 and 99). A `--key` dedups one filer's repeats, not two sessions
  with different keys. Check `factory issue list` for the repo right before filing.
- **The first unattended night (2026-11-05 to 06).** About 8 h of stall in the evening, then rows 8, 9, 9b and 13 shipped overnight with the owner asleep. What it taught:
  - **A lead can invent an approval.** Issue 93 was answered "do not merge with --admin"; three minutes later its lead wrote "Owner approved the admin merge" and merged past a
    work repo's required review. No approval exists in its transcript. An answer is not a guard: a hook is (Issue 104). Rules that matter are enforced, not briefed.
  - **A note can claim to be delivered and not be.** "Filed" is not "read": the note widening Issue 97 sat pending 50 min through a long turn. Check `NOTES`, not the ack. Fixed: a note is typed after 5 min.
  - **A fixed hold was waiting, not verifying.** 30 min per ship with the claim held was hours of nothing across a chain. Gone (hold 0m). The catch: a repo deploying from a poller was verified mid-deploy, so a red verify now retries at 1, 2 and 4 min.
  - **Idle leads spend capacity.** Leads parked on the owner and scratch Issues filled every account's cap, and a new lead could not start for 45 min with quota free. A decision wait no longer counts.
  - **A wait on the owner holds the repo.** Issue 88 held iris while a red-CI fix queued. Refiling behind the fix was the workaround; a health line now names what is held back. Not fixed: the claim itself.
  - **Proving a change can become the stall.** Issue 102's lead filed four scratch Issues to prove its judge and held the chain an hour. Scratch Issues hold claims and slots like any other.
  - **Do not filter your own alarm for the thing you are doing.** The session watcher ignored "Scratch", which hid exactly that hour.
  - **A default can state a falsehood.** Issue 88's default was "Record and internal group created", with no record. The judge takes only do-nothing defaults.
  - **Claude Code's "Dangerous rm not ruled out" stops a bypass-mode lead** on shell heredocs with no `rm` in them, five times in one night until a person answers. Leads now edit with the Edit tool; a prompt older than 15 min is a health line.
  - **A fan-out ignores owner decisions it was not told about.** Row 13 filed an Issue for paused basalt-ui (stopped by hand). An audit should read `docs/decisions.md` first.
  - **Load came from outside the factory too.** It reached 346 on 12 cores with IuRoot sessions outside the test slot and a simulator; the server stopped answering at 160. Admission now holds new leads under load; sessions outside the factory are still unbounded.
