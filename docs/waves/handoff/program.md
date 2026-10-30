# Program lead handoff

Written at the end of rotation 3, 2026-10-30 19:10. State lives in `docs/program.md`; this page holds what that table does not.

## Running now

| Agent | Repo | Work | Next when it closes |
|-|-|-|-|
| `software-factory-f1-w6-gate` | software-factory (fan worker, `iu`) | F1 Wave 6's gate run, brief `docs/waves/briefs/f1-w6-gate.md`: two scratch chains (`factory-gate-a|b`), an injected wall, one `drain`, zero owner input. Runs for hours; it observes and must not type into gate panes | Review the evidence and any code fix (`/review`), `rd merge`, `make deploy && make verify` if code changed. Pass → brief the retirement (FL8: `wave-watch.sh` polling, `fleet-keepalive.sh`, the Hermes babysitter cron; the `/wave` skill and `docs/program.md` describe the factory path) as a dotfiles worker, plus hermes-agent for the cron. Fail → fix forward, rerun |
| `agent-workflows-w3` | agent-workflows (orchestrated wave, idle) | I1 Wave 3 stopped at its gate after step 1 (`imgcli icon` runs `agw image-icon`) | Owner's ImageGen click-through: `ask-human.sh status 20261030T163835-8260`. `done` → `rd close agent-workflows-w3`, then respawn Wave 3 (still `active`, step 1 ticked; its gate line says what to do). Its input box holds an unsent German line ("Klick-through ist durch…") that nobody submitted: not acted on |

## Next tracks

- **U** (needs A1, done): author its plan. Repos usage-tracker, argo, dotfiles; `docs/decisions.md` U1–U6. Its inputs: the role-table seeds to measure (FL4), email-gateway's model spend missing from `usage` (`argo/docs/usage-reconciliation.md`), `SPAWN_COST` in `capacity.ts` unmeasured.
- **F2, A2, IR** wait for F1 (Wave 6). Author F2's plan in this repo once the gate passes.

## How things run now

- **`rd` is a factory client** (dotfiles #51): with the factory answering, `rd wave|fan` create a spawn (`queued: <reason>` instead of dying on no room or `drain`), `rd say` is a held `factory session note`, `rd close` finds the tab through the session. `RD_WAVE_MODEL|EFFORT` do **not** reach a factory spawn: pick the model with `--role`. The rotation spawn is `rd wave --role lead software-factory '…(Wave <n>)…'` (Opus/high).
- **Send-back is live** (dotfiles `5be93f9`): a session whose factory-known workers still run gets its Stop sent back once per turn. A lead that is truly waiting runs `factory session wait --on workers`. Orchestrated waves and fan workers carry their spawner as parent; chain waves carry none (`728df90`). `f1-w6-gate`'s parent is rotation 3, which has ended: harmless.
- **`make check` here runs tests through `factory slot run`** (two host-wide slots). Load still reached 100–140 this afternoon.
- **Sessions started before 2026-10-30 18:40 have no tab in the factory**; `rd close` falls back to the tab-name rule for them ("no session" in its message means "no tab"). Close those with `herdr tab close` after checking clean and pushed.

## Watch

- **Accounts:** `me2` is at 100 % of its week until 11-01 18:00. `me` and `iu` carry the work; `iu` takes most fan workers.
- **Workers end turns on background shells** (once more today: `dotfiles-f1-w5-rd`). `rd read` a `done` worker before trusting it.
- **Prompt suggestions** sit in finished workers' input boxes. Nobody typed them; never act on them.
- **Workers skip the last review pass.** Every worker this rotation reported "did not re-run review after the fixes"; each extra pass found real blocking bugs (PR #6 needed five). Run one on the fix commits before `rd merge`.
- **Parallel halves drift from their contract.** F1 Wave 5's two workers disagreed on three JSON keys; check both sides at landing.
- **agent-workflows CI runs on Ubuntu:** BSD-only tools in scripts its tests run (`stat -f`) break CI only.
- **`make check` flakes above load ~40** in software-factory; never two `make check` at once in agent-workflows.

## Decisions taken in this rotation

- **SF11 (lead):** the hook socket is a same-user boundary, not a per-session one. In `docs/decisions.md`.
- **Panes are clients:** `factory spawn create|get`, `session get`, `queue get` work over the socket without a token; the parent comes from `FACTORY_SESSION`.
- **A chain wave's successor is not its worker** (no parent); orchestrated waves are the orchestrator's.
- **email-gateway's usage posts removed:** its model spend is outside `usage` until it routes through agw (track U).
- **I1 Wave 3's gateway removal waits for the owner's click-through,** written into its plan as a gate.

## Owner items, not raised

- I1: the ImageGen click-through (pending in the queue since 16:38).
- A1: a tailnet path to the VPS socket-proxy for `/docker/vps/*` and `/summary` (Hermes' morning briefing uses them): a security call. Dropping the stopped VPS Argo schema, role and containers: asked by `argo-w6`, its recommendation is to wait two weeks.
- From before: pause or delete the Kuma push monitor `Hermes Watchdog - Push`; what ran on the personal IU key on 2026-10-22 ($43); a CREATEDB-only test role instead of the admin Postgres credential in `.env.test.tpl` (usage-tracker, agent-workflows); R0's Hermes API to loopback, when no iris agent is `working`.
