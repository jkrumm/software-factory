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
