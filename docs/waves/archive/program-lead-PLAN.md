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

## Wave 6 — The night of 2026-11-01            <!-- status: done -->
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
- [x] I: `factory-door` once W1 is live (brief to write: `packages/door`, its own LaunchAgent on the tailnet interface,
  POST only, per-source tokens in a 0600 file until the owner seeds them into 1Password in the morning, the monitor → repo
  registry in the database, not in git; the lead wires Kuma and HyperDX to it and proves one real alert becomes one Issue).
- [x] F2 gate re-run once PR #30 is live and dotfiles' doctor is green: one fresh real request through it, software-factory#31
  (`rd work` drops its prompt, owner feedback 2026-11-02) filed as a factory Issue against dotfiles.
- [x] FV (owner approval 2026-11-02, after the F2 gate; carried on as Wave 7): plan `docs/waves/fv.md`, agw `docs/waves/fv-digest.md`, dotfiles
  `docs/waves/fv-board.md`. Start FV Wave 1 and dotfiles' `ask-human.sh list --json` once the gate passed; agw digest after its
  lead answers.
- [x] (W2 live) F2 Waves 2–5 in order (W4 `deep`, the rest `worker`; W3 adds an agw classify worker on disjoint files and tells agw's
  mother first). Issue leads start for `alert` Issues only once W4 is live.
- [x] N once W3 is live: the notifier (`ask`, parked, failed through Hermes to Slack, the 07:30 digest).
- [x] F2 Wave 6, the gate: the gamedays and three real requests from the factory's own backlog (`rd close` on a merged worker, swapped in for the seed item, fixed in dotfiles `d432c25`; was: `rd`'s path seeds no
  space entry; `hc-resume` resumes without `--model/--effort`; `docs/remote-dev.md` says every structured create error falls back).
- [x] Per wave a retro entry in `docs/evidence/night-2026-11-01.md` (the fields in the plan's §Learning on the way); setup
  defects there or, once W1 is live, as Issues. The morning section proposes changes with their numbers.
- [x] Budget marks: `me2` 60 % of its week, `iu` 90 %, `me` untouched (`factory quota get` before every spawn). At a mark,
  finish what runs, start nothing.
- [x] Keep `docs/program.md` current at every track change; rotate at about 60 % context, or at 94 % of the account's week.

**Left behind:** F2 done, the gate passed on its re-run (`docs/evidence/f2-gate/`); C0, D, I, N, agw classify and shipped-means-deployed
live; every wave reviewed by the lead's `/code-review high` and retro'd in `docs/evidence/night-2026-11-01.md`, whose Morning section
holds the proposals with numbers. Budget marks held (`me2` 31 %, `iu` 79 %). Open: the defects listed there wait for the owner's call
(Issues now, or F3/F4); the door tokens go into 1Password (owner); FV started under this lead (Wave 7).

## Wave 7 — FV, the fleet view            <!-- status: done -->
The same lead, continuing. Plan `docs/waves/fv.md`; agw `docs/waves/fv-digest.md` (merged by agw's lead), dotfiles `docs/waves/fv-board.md`.

- [x] dotfiles `ask-human.sh list --json` (`370ed24`..`94c0b98`).
- [x] agw digest: agw PR #103 `f02f351`, live (a real call: "Shall I merge it now?" → asks, permission; Haiku on the iu credit pool, $0.00022).
- [x] FV Wave 1 (PR #32, `b7813fd`): 2 h 51 wall, `worker` Sonnet on `me2` (context 70 %); the lead's two `/code-review high` found 11 + 9, the second round 7
  IuRoot leaks through a redacted socket view, so `/fleet` became token-only. Live: 23 repos (2 IuRoot, visible), 19 asks (16 queue,
  14 older than 24 h), 0 errors; the socket answers `fleet needs FACTORY_TOKEN`.
- [x] FV Wave 2 (PR #33, `077bca9`): 3 h 14 wall, `worker` Sonnet on `me2` (context 68 %); the lead's three `/code-review high` found 10 + 8 + 8,
  most in the call's lifecycle (a paid run repeated every pass, a dead run blocking a day), simplified in the third round. Live: first
  pass 2 calls, 128 items, $0.0043; 133 wave shorts; no IuRoot item in the cache (IuRoot shorts are the headings cut at 8 words).
- [x] FV Wave 3 (PR #34, `6b98d06`) with dotfiles `ask-human.sh resolve`: 3 h 23 wall, `worker` Sonnet on `me2` (context 80 %); the lead's
  `/code-review high` found 9 + 5 (worst: a business-class request offered a one-click resolve; free text judged "done"; the IuRoot
  spawn guard on a snapshot flag). Live: 26 asks tiered (21 yours, 3 hand_off, 2 one_click), a stale IuRoot plan marked by the
  automatic tier, one `later` act recorded and the ask hidden. `launch.sh` reads `~/.config/factory/env` (allowlisted keys).
- [x] Board Wave 1 (dotfiles PR #60, `753af8b`): `worker` Sonnet on `iu`, 32 min; its three `/review` passes found one load blocker (a constant read before
  its declaration). Landed `--no-check`: the one red target is herdr-core's live version drift between the machines (0.1.15 vs 0.1.16). Live: reloaded on the
  MacBook, 25 asks on top, plans and session tree from `/fleet`; a factory ask shows its path instead of the repo's name (board Wave 2).
- [x] FV Wave 4 (PR #35, `88886e5`): 4 h 30 wall, `worker` Sonnet on `me2` (context 85 %); the lead's four `/code-review high` found 8 + 10 + 9 + 8, the
  fix rounds twice built new bugs (a cursor pin on the oldest git read froze the cursor), so the fourth round was a simplification the lead read
  himself. Live: `/fleet` carries presence (away, no act yet), `fleet since` over 24 h: 5 needs you, 266 shipped, 1 recovered, 6 handled, 27 running,
  spend per account; the headline paragraph ready in one pass with IuRoot as a count only ("87 items in a read-only area were counted only").
- [x] FV Wave 5, `agw agents`: agw's mother decided 2026-11-02: a client of `/fleet` (`factory fleet --format json` under secrets-run), keeping only its
  recommendations and Max quota for Hermes, brain and Argo; its collectors go, agw's and dotfiles' `AGENTS.md` name the factory as the one producer in the
  same change (agw PLAN Wave 8, after its Wave 17). A2 and IR read `/fleet` (`docs/program.md` track notes, `100c286`).
  Landed 2026-11-03: agw `02c0cbe` (live, `make verify` PASS) reads `factory fleet --format json`, its own collectors deleted; dotfiles `7e08890`.
- [x] FV Wave 5, the reaper (PR #36, `a84152d`): 1 h 55 wall, `worker` Sonnet on `me2` (context ~60 %); the lead's three `/code-review high` found
  10 + 10 + 10 (worst: a reset onto a merged commit would have reaped unpushed work; `dry` still removed terminals; a reused pane address);
  the third round's ten keep more or are cosmetic, deferred in the PR's comment. Live in `dry` (default): 0 would close, 1 kept
  (agent-workflows `shop-amazon-2`, 3 unmerged commits); `on` waits for a would-close entry checked by hand (handoff).
- [x] (superseded by the reset, RS4; not built) FV Wave 5 left: Hermes "what needs me?" from `/fleet` asks (hermes-agent). Stopped 2026-11-03 01:30 on budget (`me2` 56 %, `iu` 87 %):
  the next rotation starts after `iu`'s reset 2026-11-04 16:00.
- [x] (superseded by the reset, RS4; not built) FV Waves 5–6 in order, the board's waves after the factory's they read.
- [x] (superseded by the reset, RS4; not built) Keep `docs/program.md` current; rotate at about 60 % context with the handoff.

**Left behind:** FV stops here, superseded by the reset (`docs/decisions.md` RS1–RS9, 2026-11-05): FV Wave 5's Hermes step, board
Waves 2–3 and FV Wave 6 are not built; the fleet-view modules are deleted in the reset's later rows. Issue 51 and 52–55 are closed
by the reset's cutover.

## Wave 8 — Program lead: the reset            <!-- status: done -->
Opus/high (`rd wave --role lead`). Read `AGENTS.md`, `docs/decisions.md` (RS1–RS9), `docs/waves/handoff/program.md`,
`docs/strategy/2026-11-reset/design-v3.md` and `docs/waves/reset.md` first.

- [x] (Waves 1–3; 4–7 move to Wave 9) Run `docs/waves/reset.md` wave by wave: Wave 1 yourself, Waves 2–7 each as one `rd fan` worker, sequentially. Review each
  diff yourself, land with `rd merge`, `make deploy`, `make verify`, the wave's live proof, a learnings entry, tick it in `reset.md`.
- [x] Review with the new flow (`/review`: the router's tier, the `reviewer` subagent with the seat, at most 2 rounds, then your
  disposition); `agw review covered` over each merged range.
- [x] Machine discipline: one wave, one check at a time; no `xcodebuild` or simulator before 07:00; if load stays above 40,
  wait before starting the next check.
- [x] Learnings: every place the plan falls apart goes to `docs/strategy/2026-11-reset/learnings.md` with evidence, and the plan
  (`reset.md`, design v3) is adjusted in the same commit.
- [x] Rotate at about 60 % context: write `docs/waves/handoff/program.md`, commit, push, spawn the next rotation as a new wave
  of this PLAN.md (chain mode, a tab).
- [x] (moves to Wave 9) Stop after `reset.md` Wave 7 (its "Stop for the owner"), with the state in the handoff.

**Left behind:** reset Waves 1–3 done and live (PRs #37, #38, #39; deployed `a2c4293f559a`, `make verify` green, every range
`covered`), each with its proof and learnings entry. Rotated at about 60 % context before Wave 4: its brief
`docs/waves/briefs/reset-w4-lead.md` is committed and not yet spawned. Handoff: `docs/waves/handoff/program.md`. Rotation 2 spawned 2026-11-05 ~01:55Z as `software-factory-w9` (t13c, `iu`) through `factory spawn create`: `rd wave`'s keyword gate refused it (learnings).

## Wave 9 — Program lead: the reset, rotation 2            <!-- status: done -->
Opus/high. Read `AGENTS.md`, `docs/decisions.md` (RS1–RS9), `docs/waves/handoff/program.md`,
`docs/strategy/2026-11-reset/design-v3.md` and `docs/waves/reset.md` first.

- [x] (Waves 4–5; 6–7 move to Wave 10) Run `docs/waves/reset.md` Waves 4–7 as in Wave 8: one `rd fan` worker each, sequentially; review each diff, land with
  `rd merge`, `make deploy`, `make verify`, the wave's live proof, a learnings entry, tick it in `reset.md`.
- [x] Review with the new flow (`/review`, at most 2 rounds, then your disposition); `agw review covered` over each merged range.
- [x] Machine discipline: one check at a time; no `xcodebuild` or simulator before 07:00; if load stays above 40, wait.
- [x] Learnings with evidence in `docs/strategy/2026-11-reset/learnings.md`; the plan adjusted in the same commit.
- [x] Rotate at about 60 % context (handoff, commit, push, a new wave of this PLAN.md; after Wave 4 merges, spawn with
  `--role deep`: `lead` is Sonnet then).
- [x] (moves to Wave 10) Stop after `reset.md` Wave 7 (its "Stop for the owner"), with the state in the handoff.

**Left behind:** reset Waves 4–5 done and live (PRs #40, #42; dotfiles #61; homelab #19; Issue 64 shipped by a Sonnet-high lead with zero touch), each with its proof and learnings entry. Wave 6 is `active` in `reset.md` with both briefs written (`briefs/reset-w6-spaces.md`, `briefs/reset-w6-dotfiles.md`), not spawned. Issue 66 (verify vs docs-only commits) is queued for the factory. Rotated at about 60 % context; handoff `docs/waves/handoff/program.md`. Rotation 3 spawned at 03:33Z as `factory spawn create software-factory-w10 --role deep --placement tab` with no parent (pane t13p, `me2`): `rd wave` refused it on the keyword gate again ("deploy" in Wave 10's first step; learnings, rotation 1 close-out).

## Wave 10 — Program lead: the reset, rotation 3            <!-- status: done -->
Opus/high (spawned with `--role deep`: `lead` is Sonnet high since reset Wave 4). Read `AGENTS.md`, `docs/decisions.md` (RS1–RS9),
`docs/waves/handoff/program.md`, `docs/strategy/2026-11-reset/design-v3.md` and `docs/waves/reset.md` first.

- [x] Run `docs/waves/reset.md` Waves 6–7 as before: `rd fan` workers from the written briefs (Wave 6: software-factory and dotfiles, in
  parallel, disjoint repos), review each diff, land, `make deploy`, `make verify`, the wave's live proof, a learnings entry, tick `reset.md`.
- [x] Follow Issue 66 (and Issue 64 if it is not `closed`) to the end; no master push of this repo while one of its Issues is in its hold
  until Issue 66 is live.
- [x] Review with the new flow (`/review`, at most 2 rounds, then your disposition); `agw review covered` over each merged range.
- [x] Machine discipline: one check at a time; no `xcodebuild` or simulator before 07:00; if load stays above 40, wait.
- [x] Learnings with evidence in `docs/strategy/2026-11-reset/learnings.md`; the plan adjusted in the same commit.
- [x] Stop after `reset.md` Wave 7 (its "Stop for the owner"), with the state in the handoff; rotate earlier at about 60 % context.

**Left behind:** reset Waves 6–7 done and live: software-factory #44 (spaces, `ed175476713c`) and #45 (`issue_facts`, `b7d749a7ed2c`), dotfiles #62; every range `covered`, every `make verify` green. Issue 64 and Issue 66 closed `done` (66 on its first hold), so the no-push-during-a-hold rule is retired. First KPI line: asks/issue 0.05, zero-touch 94 %, first-hold 81 %. **Stopped: `reset.md`'s "Stop for the owner"** — rows 7–9 (dotfiles `rd`, `/wave`, `wave-gate.py`, then the deletions) change the machinery this loop runs on and wait for the owner's read of the learnings; no next wave is spawned and none is `active`. Handoff `docs/waves/handoff/program.md` (incl. the two doubled spaces and the IuRoot plan tabs, the owner's).
