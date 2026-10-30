Branch: f1-w6-gate-rerun
Title: docs(evidence): the F1 gate rerun, a mid-turn wall and a drain through rd wave
Owned files: `docs/evidence/f1-gate-run/**`, `scripts/gate-run/**`, and any fix the run forces in `packages/**` (each its own commit with a test; stop and report instead if a fix is larger than a small change). Never: `docs/decisions.md`, `docs/program.md`, `docs/design.md`, `docs/waves/**`.
Task:
F1 Wave 6's gate, second run. Read `AGENTS.md`, `docs/waves/briefs/f1-w6-gate.md` (the first run's brief: the claim, the observe-only rules, the evidence shape) and `docs/evidence/f1-gate-run/README.md` (the first run's result) first. `scripts/gate-run/` holds the first run's scripts; reuse them.

Since the first run: PR #8 is merged and deployed (a finished chain wave no longer holds its repo; `inject-wall.sh` calls `curl` inside `secrets-run`). dotfiles #52 landed: `wave-gate.py` no longer refuses under `drain`, the factory holds the spawn (`queued: drain`) and starts it when the drain lifts, and `rd wave` exits 0 so a chain wave counts it as its successor spawned (decision FL1 in `docs/decisions.md`, amended). The first run's two open points are what this run proves:

1. **A wall mid-turn.** One chain whose Wave 2 is long enough (lengthen that template's steps) that the wall is injected while the wave is clearly working, at least 2 minutes before it would end its turn. The proof: the session goes `walled`, the resume watchdog types one `continue` after the (test-row) reset, the wave finishes its unfinished work, and the chain runs to its end. Say in the evidence how far the wave was when the wall hit.
2. **A drain through `rd wave`, the chain-E way.** One chain: `factory queue set drain --project <its repo>` while its Wave 2 works; that wave's `rd wave` for Wave 3 prints `queued: drain` and exits 0, the wave ends its turn; after at least 10 minutes `factory queue set run`, Wave 3 starts by itself and the chain runs to its end.

Fresh repo and chain names (the factory keeps one spawn row per agent name), e.g. `factory-gate-w` and `factory-gate-x`. Observe without touching (the first brief's step 5), the 15-minute evidence lines, zero owner input.
Evidence: a "Rerun" section in `docs/evidence/f1-gate-run/README.md`, verdict first, with keys and timestamps, counts, what broke and what was fixed; raw logs beside the first run's under a `rerun/` folder, nothing secret, no hostnames, no IPs. Then rewrite the README's top verdict line to the overall result of both runs against the claim.
Cleanup: both chains' tabs closed with `rd close`, the scratch repos and bare remotes removed after the evidence is written (keep the scripts).
Validation: `make check` (foreground; check `uptime`, it flakes above load ~40) for any code change.
Finish: commit per logical concern, push `f1-w6-gate-rerun`, open a ready PR, `/review` on any code or script change and fix its blocking findings, then one more review pass on the fix commits, wait for CI in the foreground with `timeout`. No background shell left running when you end your turn. Report the PR URL, the verdict, the counts and anything the owner had to do (should be nothing). Do not merge.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
