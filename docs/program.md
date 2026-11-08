# The program: what is open, and who runs it

**TLDR.** The program runs as factory Issues (RS11), on the rewritten core that went live on 2026-11-08. The plan of record
is `docs/plan.yaml`: the `planning` loop files each row as an Issue when the rows it waits for have closed
(`docs/architecture.md`, "Loops and agw"), and the Issue's lead builds, reviews, ships and verifies it. A stalled Issue is the
steward's to act on and every Decision passes the Judge (`factory-ask`) first (RS12); only taste and big decisions reach the
owner. Program-lead rotations and wave plans are gone; the old ones are in `docs/waves/archive/`.

## How the program runs

- **State** is the factory (`factory issue list`, `factory issue show <n>`, `factory read overview`), `docs/plan.yaml` for rows
  not yet filed, `docs/waves/reset.md` for the reset's rows and `docs/rewrite/state.md` for the rewrite's log. This file holds
  no row state of its own.
- **A row is an Issue** with `why`, `what`, `change`, `acceptance` facts, chained with `after`; `factory issue prio` orders a
  project's queue. A project runs `leads: N` leads at once (software-factory: 2), each in its own worktree.
- **Owner contact:** a lead raises a Decision (`factory issue ask`) only for product direction, spend, irreversible data loss,
  other people or security policy; everything else is settled by the factory. Own-repo pushes, merges and deploys are routine.
- **Stale docs are part of done.** A row that leaves an outdated plan, doc or diagram behind has not closed.

## Open work

The reset (RS1–RS15) and the rewrite (NL11–NL24) are built and live; their logs are `docs/waves/reset.md` and
`docs/rewrite/state.md`. What is left, as of 2026-11-08:

- **After the cutover** (`docs/plan.yaml`): the Console chain (shell, Needs you, artifact page, then the owner's first look,
  Flow, Issue page, Chain, Improve), the queue and hygiene loops, the surfaces (Herdr glance, Hermes' factory skill,
  Argo's factory pages out), and the burn-in reports on day 3 and day 7 after the cutover. The old core's release stays pinned
  in `data/keep-releases` for the way back (`make rollback`) until the day-7 report.
- **Time-gated, track U:** judge the cost program's Wave 6 on the W46 report (2026-11-16); W45 is a trend.
- **Open after R0 and A1** (below), each the owner's or a security call.

## Tracks

| # | Track | Repo(s) | Status |
|-|-|-|-|
| U | Claude Code cost program on usage v2 | usage-tracker, dotfiles, hermes-agent, email-gateway | Waves 1–5 done and reviewed (plan `usage-tracker/docs/waves/PLAN.md`); Wave 6 time-gated, see Open work |
| A2 | Argo pages: Fleet and Factory, agw insight, Infra (Beszel), Usage v2 | argo | not tracked here (Argo's own Issues); the factory side is `/v1` (`docs/architecture.md`, "API, client, CLI"); the factory's own pages leave for the Console (NL3) |
| IR | iris: fleet, waves and quota screens | iris | iris reads `/v1` and pushes decision cards (Issue 171, done); the rest is iris's own plan |
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
The Fleet and Factory pages read the factory's read API (`/v1`, `docs/architecture.md`) through a server-side call with the read-only token; Argo builds no
collector of its own for sessions, plans or asks. Usage v2, agw insight and Infra (Beszel) stay Argo's.

### IR: iris
iris reads the factory through `/v1`, not herdr or Argo directly.
APNs and TestFlight wait on the Apple developer enrolment. Apple changes are verified on the mini (RS7, Issue 151).
