Branch: f1-w6-drain-gate
Title: fix(wave-gate): a drain is held by the factory, not refused by the gate
Owned files: `scripts/wave-gate.py`, `scripts/wave-gate.test.py`, `scripts/remote-dev.sh` (only if the queued-spawn path needs it), `skills/wave/SKILL.md`, `AGENTS.md` (the `rd wave` row only, if it mentions the gate's drain check). Never anything else.
Task:
F1's gate run (software-factory PR #8, `docs/evidence/f1-gate-run/README.md` on that branch) failed one arm: under a project `drain`, `rd wave` runs `scripts/wave-gate.py` before it asks the factory, the gate's sixth check (`queue_state`, `wave-gate.py` around line 213) exits 1, the finishing chain wave writes "stopped" into its plan, and after `factory queue set run` nothing restarts the chain. The claim the gate proves is "a drain needs no owner continue".

Decision (program lead): the factory enforces drain, the gate does not. With the factory answering, `rd wave` creates the spawn, the factory holds it (`queued: drain`, admission in `software-factory/packages/server/src/admission.ts`), and lifting the drain starts it by itself. FL1's intent stays: nothing new starts at the boundary, nothing running is interrupted.

1. Remove the sixth check from `wave-gate.py`: `queue_state`, its call, the docstring paragraph. Nothing else in the gate changes.
2. `wave-gate.test.py`: the `FactoryQueue` class tested the refusal; replace it with one test that a `drain` answer from a stub `factory` no longer stops the gate (the "no plan file" message is the proceed signal, as the class's docstring describes), and delete the tests that only make sense for the check.
3. Check `cmd_wave` in `scripts/remote-dev.sh`: when the factory answers `queued: drain` (or any `queued: <reason>`), `rd wave` must exit 0 and say the factory starts it when the hold lifts, so a chain wave treats it as its successor spawned. If it already does, change nothing there and say so.
4. `skills/wave/SKILL.md`: one line where the close-out's two endings are named ("the next wave spawned, or stopped") that `queued: <reason>` from `rd wave` is a spawn: the factory starts it, the wave ends its turn. Drop any sentence saying the gate refuses under drain.
Validation: `make check` in dotfiles (foreground), and the wave-gate tests by themselves.
Finish: commit per logical concern, push `f1-w6-drain-gate`, open a ready PR against master, run `/review` and fix its blocking findings, then run one more review pass on the fix commits, wait for CI in the foreground with `timeout`. Report the PR URL. Do not merge.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
