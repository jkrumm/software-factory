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

## Wave 3 — Program lead, rotation 3            <!-- status: done -->
Opus/high. Read `AGENTS.md`, `docs/decisions.md`, `docs/program.md`, `docs/waves/handoff/program.md` first.

- [x] Take over the three running agents from the handoff; review each close-out and land or spawn the next.
- [x] Track T in agent-workflows at its boundary (brief `docs/waves/briefs/t-agent-workflows.md`), then agw `make deploy` + `make verify`; then I1 Wave 3.
- [x] F1 Waves 4–5 landed and deployed; start Wave 6's overnight gate run.
- [x] A1 Waves 4–6 to the cutover.
- [x] Keep `docs/program.md` current at every track change; rotate at about 60 % context, or at 94 % of the account's week.

**Left behind:** A1 and T done; F1 Waves 4–5 merged and live (PRs #6–#7, dotfiles #51, `5be93f9`, `728df90`), Wave 6's gate
run running as `software-factory-f1-w6-gate`; I1 Wave 3 stopped at its gate after step 1, waiting for the owner's
click-through. Gate: every close-out reviewed against its diff, an extra review pass on each worker's fix commits (they
found real blocking bugs in argo Wave 4, PR #6 and argo Wave 5's fixes); `make check` and CI green on every merge; agw,
factory and Argo `make verify` green after each deploy; F1 Wave 5 proven live by the lead. Master CI in agent-workflows
was red after I1 Wave 2 (BSD `stat`), fixed in `9803d88`. Handoff: `docs/waves/handoff/program.md`.

## Wave 4 — Program lead, rotation 4            <!-- status: done -->
Opus/high (`rd wave --role lead`). Read `AGENTS.md`, `docs/decisions.md`, `docs/program.md`, `docs/waves/handoff/program.md` first.

- [x] Take over the two agents from the handoff; review each close-out and land or spawn the next.
- [x] F1 Wave 6: review the gate run's evidence; on a pass, the retirement (FL8) as workers, then F1 done.
- [x] I1 Wave 3 once the owner's click-through is in.
- [x] Author and start track U's plan; author F2's once F1 is done.
- [x] Keep `docs/program.md` current at every track change; rotate at about 60 % context, or at 94 % of the account's week.

**Left behind:** written by rotation 5 from git, the rotation ended without a close-out. Landed: the gate (#8, #10), the wake
rule (#9) and the wake that ends its wait (#13), the opening fix (#11), the retirement, U's and F2's plans; the herdr-core runner
(`437a4ea`, FL9, by dotfiles Wave 2). Open: the gamedays PR #12 (built before the herdr-core runner) and the deps PR #15.

## Wave 5 — Program lead, rotation 5            <!-- status: done -->
Opus/high. Started 2026-11-01 by the owner as a review of the whole estate.

- [x] Review the factory, agw, the herdr-core port and their wiring against each other (findings: `docs/waves/handoff/program.md`).
- [x] F1 fixes from that review (brief `docs/waves/briefs/f1-fixes-2026-11-01.md`, PR #16, dotfiles `f526f15`): spent keys, the
  core-restart resume, resumed finished waves, a missed dead terminal. Deployed `e0f227ba573e`, `make verify` green; spent keys and
  the dead terminal proven live, the two restart paths only by tests (proof needs a core restart: dotfiles Wave 9's window).
- [x] agw review rework planned (`agent-workflows/docs/review-v2.md`, `15a44fb`); waits for the owner's three decisions there.
- [x] A new space is seeded in the app's document with the main checkout's name and folder (owner-reported; brief
  `docs/waves/briefs/f1-seed-space-2026-11-01.md`, PR #17, deployed `a2a18a26e686`). `rd`'s direct-to-hc path has the same gap.
- [x] Owner decision on the order after F1: F2 in full tonight with the intake door pulled forward; all eleven answers in
  `docs/waves/night-2026-11-01.md` (2026-11-01 19:30).
- [x] The night planned: `docs/waves/night-2026-11-01.md`, briefs `docs/waves/briefs/night-*.md`, Wave 6 below.
- [x] Keep `docs/program.md` current at every track change.

**Left behind:** PR #12 (gamedays, built before the herdr-core runner) and #15 (deps) open, both green; moved to Wave 6. The
restart paths of PR #16 are proven by tests only. agw runs its own
night under its mother (gateway Wave 2, then review v2); the dotfiles chain closed Wave 10 (the herdr-core migration is done).
Handoff: `docs/waves/handoff/program.md`.

## Wave 6 — The night of 2026-11-01            <!-- status: active -->
Opus/high (`rd wave --role lead`). Read `AGENTS.md`, `docs/waves/night-2026-11-01.md` (the plan, the owner's answers, models,
learning), `docs/waves/f2.md`, `docs/waves/handoff/program.md` first. Briefs: `docs/waves/briefs/night-*.md`; write the
missing ones from `f2.md` and `docs/design.md` in the same shape (header lines, the foreground-wait line, the gate) and
commit each before its spawn. Workers are hidden fan workers: `rd fan software-factory [--role deep] <brief>`.

- [x] Notes first: agw's mother (decisions 8–10 and "keep API spend low, iterate on Max first") and iris' mother (decision
  11). Sent by rotation 5 (prompt ids `night-2026-11-01-review`, `-pause`); check both were delivered.
- [x] C0 (`night-c0-cleanup.md`, `worker`), landed and deployed; PR #15 (deps) merged after a local `make check`; PR #12
  rebased onto the herdr-core runner or closed with the reason (its gamedays feed F2 W6).
- [x] F2 Wave 1 (`night-f2-w1-issues.md`, `deep`) with D beside it (`night-d-hidden-waves.md`, `worker`; it overlaps W1
  only in route registration: land W1 first, D rebases).
- [ ] I: `factory-door` once W1 is live (brief to write: `packages/door`, its own LaunchAgent on the tailnet interface,
  POST only, per-source tokens in a 0600 file until the owner seeds them into 1Password in the morning, the monitor → repo
  registry in the database, not in git; the lead wires Kuma and HyperDX to it and proves one real alert becomes one Issue).
- [ ] F2 Waves 2–5 in order (W4 `deep`, the rest `worker`; W3 adds an agw classify worker on disjoint files and tells agw's
  mother first). Issue leads start for `alert` Issues only once W4 is live.
- [ ] N once W3 is live: the notifier (`ask`, parked, failed through Hermes to Slack, the 07:30 digest).
- [ ] F2 Wave 6, the gate: the gamedays and three real requests from the factory's own backlog (`rd`'s direct-to-hc path seeds no
  space entry; `hc-resume` resumes without `--model/--effort`; `docs/remote-dev.md` says every structured create error falls back).
- [ ] Per wave a retro entry in `docs/evidence/night-2026-11-01.md` (the fields in the plan's §Learning on the way); setup
  defects there or, once W1 is live, as Issues. The morning section proposes changes with their numbers.
- [ ] Budget marks: `me2` 60 % of its week, `iu` 90 %, `me` untouched (`factory quota get` before every spawn). At a mark,
  finish what runs, start nothing.
- [ ] Keep `docs/program.md` current at every track change; rotate at about 60 % context, or at 94 % of the account's week.

**Left behind:**
