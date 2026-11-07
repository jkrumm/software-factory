# The program: what is open, and who runs it

**TLDR.** The program runs as factory Issues (RS11): the owner's session files each row with `factory issue new --after …`
(or `rd issue`), and the Issue's lead builds, reviews, ships and verifies it. The plan of record is `docs/plan.yaml`; the
server files its rows when their dependencies close (design §4 "The plan files its next Issue"). A stalled Issue is the
steward's to act on and every ask passes `agw factory-ask` first (RS12, design §4 "The ask judge"); only taste and big decisions
reach the owner. Program-lead rotations and wave plans are gone; the old ones are in `docs/waves/archive/`.

## How the program runs

- **State** is the factory (`factory issue list`, `factory issue show <n>`, `factory status`), `docs/plan.yaml` for rows not yet
  filed, and `docs/waves/reset.md` for the reset's rows and their Issues. This file holds no row state of its own.
- **A row is an Issue** with `why`, `what`, `change`, `acceptance` facts, chained with `--after`; `factory issue prio` orders a
  project's queue. One lead per repo at a time (parallel leads: RS5).
- **Owner contact:** a lead asks only for the four business classes and security policy (`factory issue ask`); everything else is a
  health line. Own-repo pushes, merges and deploys are routine.
- **Stale docs are part of done.** A row that leaves an outdated plan, doc or diagram behind has not closed.

## Open work

The reset (design v3, RS1–RS15) is built; its row log is `docs/waves/reset.md`. What is left, as of 2026-11-07:

- **Slack leaves the stack** (reset row 15 remainder): Issue 177 (argo, the Slack proxy; waiting) then Issue 178 (dotfiles-private, the Slack refs in the mini's secrets cache; queued).
- **Docs sweep** (`docs-sweep` in `docs/plan.yaml`): Issue 179, working.
- **Parallel leads in one repo** (`parallel-leads` in `docs/plan.yaml`, RS5): filed by the server after a stable week.
- **Time-gated, track U:** judge the cost program's Wave 6 on the W46 report (2026-11-16); W45 is a trend.
- **Open after R0 and A1** (below), each the owner's or a security call.

## Tracks

| # | Track | Repo(s) | Status |
|-|-|-|-|
| U | Claude Code cost program on usage v2 | usage-tracker, dotfiles, hermes-agent, email-gateway | Waves 1–5 done and reviewed (plan `usage-tracker/docs/waves/PLAN.md`); Wave 6 time-gated, see Open work |
| A2 | Argo pages: Fleet and Factory, agw insight, Infra (Beszel), Usage v2 | argo | not tracked here (Argo's own Issues); the factory side is `/v1` (design §11 "The read API") |
| IR | iris: fleet, waves and quota screens | iris | iris reads `/v1` and pushes decision cards (Issue 171, done); the rest is iris's own plan |
| F4 | Capacity classes and the orchestrator; initiatives as child Issues | software-factory | pending, not filed (design §6, §7) |
| L | Later, owner-timed: finances on the mini behind Touch ID; calendar and mail via email-gateway | finances (MacBook), argo, email-gateway | not started |

**Done tracks** (history in `docs/waves/archive/`, `docs/evidence/`, `docs/strategy/`; do not re-plan): R0 clean setup and R1 Hermes leaves Argo (2026-10-30); F0 design, spike, skeleton (PR #1; spike verdict `docs/spikes/2026-10-30-effect/verdict.md`, SF6); F1 fleet layer (plan `docs/waves/archive/f1.md`, gate `docs/evidence/f1-gate-run/README.md`; its wave-era babysitting is retired by RS1 and RS4); F2 Issue machine (gate `docs/evidence/f2-gate/`); F3 intake (Issue 149); A1 shared database and Argo on the mini; I1 `icon` into `agw image`; D archive of the TDD v2.4 material (`docs/evidence/` keeps the golden set and KPIs; the archive itself is now only in dotfiles git history, commit `85ee5e5`); T oxlint and oxfmt replace Biome (software-factory and agent-workflows; rule for every new TypeScript repo); FV fleet view (superseded in part by RS4: the triage, presence and reaper went, `GET /fleet` and the digest stayed, then the read API `/v1` per RS13).

## Track notes (open items each track inherits)

### R0, R1
Plans (archived where done): `dotfiles/docs/waves/PLAN.md`, `argo/docs/waves/PLAN.md`. dotfiles `drift-check` (collie pin, tailscale daemon) is red
and outside `make check`. Open: the Hermes API to loopback (`hermes-agent/.env.tpl` `API_SERVER_HOST` and `iris/.env.local.tpl`
`HERMES_HOST` together, then `verify.sh`, the `hermes-validate` probe, restarts, a memo routed to Hermes) waits until
no iris agent is `working`; the Kuma push monitor `Hermes Watchdog - Push` has no pinger and is the owner's to pause
in the UI. Full list of kept sweep hits: `dotfiles/docs/waves/archive/2026-10-clean-setup-PLAN.md`. Dead Argo code to delete: the `/ai/v1/*` HTTP
routes (no caller; `aiComplete` stays), `startChatTurn` in the dashboard's telemetry, the 50 MB body limit.

### A1: shared database, Argo on the mini, usage v2
Done 2026-10-30 (`make verify` PASS). Open: the VPS half of `/docker/*` and `/summary` (Hermes' briefing uses them) needs a tailnet path to the VPS
socket-proxy, acceptable and built when a surface needs it (RS11 f); dropping the stopped VPS schema is the owner's call (recommendation: wait two weeks).
Docs: `argo/docs/usage-reconciliation.md`, `argo/docs/design/usage-tracking.md`, `usage-tracker/docs/collectors.md`.

### U: Claude Code cost program
Plan `usage-tracker/docs/waves/PLAN.md` (attribution, window share, cost signals, the weekly report, findings into changes, the effect a week later).
Every Claude Code session carries lane, factory role, effort, subagent type and parent; `usage.session_window_share` and `usage-tracker window`
give the 5 h and 7 d share; `usage-tracker report weekly` (LaunchAgent Mondays 07:00); findings carry the change that answers them
(`usage-tracker/docs/finding-changes.json`). The FL4 measurement by role waits for a week of factory runs
(`usage-tracker/docs/reports/2026-10-30-role-window-share.md`).

### A2: Argo pages
The Fleet and Factory pages read the factory's read API (`/v1`, design §11) through a server-side call with the read-only token; Argo builds no
collector of its own for sessions, plans or asks. Usage v2, agw insight and Infra (Beszel) stay Argo's.

### IR: iris
iris reads the factory through `/v1`, not herdr or Argo directly.
APNs and TestFlight wait on the Apple developer enrolment. Apple changes are verified on the mini (RS7, Issue 151).
