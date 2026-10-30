# software-factory: the program lead's rotations

**Goal:** every track in `docs/program.md` is done and verified, and the docs everywhere describe the
strategy in `docs/decisions.md`, nothing older.
**Gate:** per track, the gate its own plan names; for each rotation, `docs/program.md` updated, committed and
pushed, and the handoff written.

## Wave 1 — Program lead, rotation 1            <!-- status: done -->
Opus/high. Read `AGENTS.md`, `docs/decisions.md`, `docs/program.md` first. This wave spawns other repos'
waves in orchestrated mode; it spawns its own next rotation in chain mode.

- [x] Take over R0 and R1: watch `dotfiles-w1` and `argo-w1`, review each close-out, spawn R0 Wave 2.
- [x] F0 step 1: `docs/design.md`.
- [x] F0 step 2 and 3: the Effect skill, then the spike with its pre-written rule; record the verdict.
- [x] Author and start what can run in parallel now: A1's plan in argo once R1 closed (the price-catalog
  research first), I1's plan in agent-workflows.
- [x] Keep `docs/program.md` current at every track change; rotate at about 60 % context.

**Left behind:** R1 done; R0 Wave 2, A1 Wave 1 and I1 Wave 1 running; F0 steps 1–3 done, plain TypeScript won the spike
(`docs/spikes/2026-10-30-effect/verdict.md`). `docs/design.md` carries the spike's lessons. No code on master yet, so no
`make check` exists; the gate here was the review of every close-out and `/code-review high` on both arms.
Handoff: `docs/waves/handoff/program.md`.

## Wave 2 — Program lead, rotation 2            <!-- status: active -->
Opus/high. Read `AGENTS.md`, `docs/decisions.md`, `docs/program.md`, `docs/waves/handoff/program.md` first.

- [ ] Take over the three running waves from the handoff; review each close-out and spawn the next.
- [x] F0 step 4: the skeleton as one `rd fan` worker, based on `spike/plain` with its review findings fixed; land it with
  `rd merge`.
- [x] Author F1's plan in this repo from `docs/design.md` §3 and start it once the skeleton is on master and `shared` exists.
- [x] Start track D once R0 is closed.
- [ ] Keep `docs/program.md` current at every track change; rotate at about 60 % context, or at 94 % of the account's week.

**Left behind:** stopped: `me`'s 5-hour window hit 100 % (reset 12:40), so this rotation could not spawn its successor.
R0 and D done and reviewed; F0 done (skeleton merged, PR #1); F1 plan written, Wave 1 waits for `shared` from A1 Wave 1.
Still running: `argo-w1`; `agent-workflows-w1` walled mid-close-out. Step 1 stays open for those two. Handoff updated.

## Wave 3 — Program lead, rotation 3            <!-- status: pending -->
