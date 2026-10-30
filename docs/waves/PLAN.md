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

## Wave 2 — Program lead, rotation 2            <!-- status: done -->
Opus/high. Read `AGENTS.md`, `docs/decisions.md`, `docs/program.md`, `docs/waves/handoff/program.md` first.

- [x] Take over the three running waves from the handoff; review each close-out and spawn the next.
- [x] F0 step 4: the skeleton as one `rd fan` worker, based on `spike/plain` with its review findings fixed; land it with
  `rd merge`.
- [x] Author F1's plan in this repo from `docs/design.md` §3 and start it once the skeleton is on master and `shared` exists.
- [x] Start track D once R0 is closed.
- [x] Track T (owner decision 2026-10-30): oxlint and oxfmt replace Biome. software-factory done (PR #5); the
  agent-workflows half moves to rotation 3, at its boundary.
- [x] Keep `docs/program.md` current at every track change; rotate at about 60 % context, or at 94 % of the account's week.

**Left behind:** R0, D and F0 done and reviewed; F1 Waves 1–3 merged and live on the mini (PRs #2–#4, dotfiles #49–#50),
Wave 4 running as a fan worker; A1 Waves 1–3 done, Wave 4 running; I1 Wave 1 done, Wave 2 running; track T done in
software-factory. The first stop on `me`'s wall (11:10–12:40) is recorded in the commit history; the rotation continued
after the reset. Gate: every close-out reviewed against its diff; `make check` and CI green on every merge (`rd merge`);
`make verify` green after each deploy. Handoff: `docs/waves/handoff/program.md`.

## Wave 3 — Program lead, rotation 3            <!-- status: active -->
Opus/high. Read `AGENTS.md`, `docs/decisions.md`, `docs/program.md`, `docs/waves/handoff/program.md` first.

- [ ] Take over the three running agents from the handoff; review each close-out and land or spawn the next.
- [ ] Track T in agent-workflows at its boundary (brief `docs/waves/briefs/t-agent-workflows.md`), then agw `make deploy` + `make verify`; then I1 Wave 3.
- [ ] F1 Waves 4–5 landed and deployed; start Wave 6's overnight gate run.
- [ ] A1 Waves 4–6 to the cutover.
- [ ] Keep `docs/program.md` current at every track change; rotate at about 60 % context, or at 94 % of the account's week.

**Left behind:**

## Wave 4 — Program lead, rotation 4            <!-- status: pending -->
