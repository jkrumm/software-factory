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
- **The Stop send-back fired for a background subagent.** With the fan worker idle and only the in-session `reviewer`
  subagent running, the Stop hook answered "1 worker still running". Evidence for row 4's `background_tasks` step; until it
  lands, a lead declares `wait --on workers` before ending a turn on a background review.
- **The task notification showed the reviewer's reply HTML-escaped** (`&lt;id&gt;`, `->&gt;`). Submitting "verbatim" meant
  restoring `<`/`>`; agw accepted it. Candidate for `/review`: run the reviewer in the foreground so the reply is raw.
