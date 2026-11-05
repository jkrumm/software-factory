Branch: f2-deployed
Title: fix(issues): shipped means deployed, the check runs on what landed
Owned files: `packages/server/src/issues/{evidence,brief,hold,origin}.ts` (whichever hold these rules), `packages/contract/src/**` (an evidence kind), `packages/server/test/**`, `docs/design.md` §5 and §4's evidence gate, `AGENTS.md` (a pointer line if one lies). Never: `follow.ts`, `lead.ts`, `packages/cli/src/run.ts` (F2 Wave 5 is open on them), `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, migrations unless you must (then `021_*`).

# Brief: shipped means deployed (found by the F2 gate, 2026-11-02)

Read `docs/design.md` §5 ("Done means evidence"), §13 (the KPI "shipped changes whose deployed version lacked the merged commit at close: 0"), `packages/server/src/issues/evidence.ts`, `hold.ts` and the brief's standing orders first.

**The defect, live:** Issue 29 (repo `dotfiles`, `deploy.mode: make`) closed `done`, `verified`, with a commit on origin/master and **no deploy**: the lead's last line was "I haven't deployed anything". Nothing asked for it. The hold's `make verify` ran in the repo's main checkout, which stood at the older commit, so it proved nothing about the change. Issue 1 deployed only because that lead chose to; software-factory's `make verify` happens to compare the deployed sha, dotfiles' does not. A `make deploy` from a lead's worktree is also wrong for a repo whose `make setup` links its own `pwd`: it must run in the main checkout.

Fix, the simplest rules that close it, the factory still checks existence and freshness and never judges:

1. **The evidence gate:** a project with `deploy.mode: make` whose commits touch deployable paths requires a `deploy` evidence item at `ship`, on top of what the paths ask for: `--evidence kind=deploy,…` naming the merged head. `ship` refuses without it, with a line that says what to do.
2. **The brief's standing orders,** mode `make`: after landing, in the repo's **main checkout** (name the path): `git pull --ff-only`, `make deploy`, `make verify`, then `ship`. Never `make deploy` from the worktree. Identical in every brief of that mode.
3. **The hold's check runs on what landed.** Before `make verify`, the factory verifies the main checkout contains the shipped commits. It fast-forwards to `origin/<default>` when that is a clean fast-forward; a dirty or diverged checkout, or commits still missing, is a red check with that reason (a regression to the lead), never a green `make verify` on old code. Off-tick, as the check is.
4. Tests through the public surface: a make-mode ship without `deploy` refused, with it accepted; mode `none` and `auto` unchanged; a stale main checkout fast-forwarded and verified; a dirty one red with its reason. Update `docs/design.md` and the table in "Done means evidence".

**Gate:** `make check` green, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or deploy. End with a report: done / deferred, one line each.
