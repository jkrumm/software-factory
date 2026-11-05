# Program lead handoff: the reset, rotation 3

Written 2026-11-05 ~03:15Z by rotation 2 of the reset (PLAN.md Wave 9, pane t13c), rotated at about 60 % context. You are the
program lead for the reset: `PLAN.md` Wave 10, track plan `docs/waves/reset.md`, starting at its **Wave 6**. The owner reads
`docs/strategy/2026-11-reset/learnings.md` and this file in the morning.

## Read first

1. `docs/decisions.md` RS1–RS9.
2. `docs/strategy/2026-11-reset/design-v3.md` (§8 Herdr layout, §11 telemetry, §13 the build order).
3. `docs/waves/reset.md` (Waves 1–5 done with their Left behind; Wave 6 `active`).
4. `docs/strategy/2026-11-reset/learnings.md`: the Wave 4 and Wave 5 entries.

## Done in rotation 2 (verified live)

| Wave | What | Landed, deploy | Proof |
|-|-|-|-|
| 4 the lead | operating contract in `brief.ts`, `lead` → Sonnet high, `FACTORY_LEADS_PER_ACCOUNT`, compaction re-read line | #40, `4a93d6b3da21` | Issue 64: a real race in `HcRunner.start` found and fixed by a Sonnet-high lead (PR #41), shipped in 16 min, 0 touches |
| 5 health line | asks = decisions; parks and machine failures on `health`; silent / over-budget / regressions lines; `/health` heartbeat; `make rollback` | #42 `c7081b8615c0`, dotfiles #61, homelab #19 | `status`: 7 asks → 0 asks + 7 health; Kuma `Software Factory - Push` UP from the pusher; `DRY_RUN=1 make rollback` |

Every range `covered` true; every deploy `make verify` all passed.

## In flight (check first)

- **Issue 64** was in its second hold until about 03:29Z (the first went red on my docs push, see below). If it is not `closed`, read
  `factory issue show 64`.
- **Issue 66** "make verify: a docs-only commit on master is not an undeployed release": queued for the factory behind 64's claim (`leads: 1`).
  A Sonnet-high lead builds it. **Until it is live, push no software-factory master commit while one of its Issues is in its hold** (`watching`):
  `make verify` demands deployed == `origin/master` and a hold reads that as a regression.
- My last docs commit (this handoff, PLAN.md Wave 10, `reset.md` Wave 5 close-out, Wave 6 briefs, learnings) was pushed after 64's hold ended.

## Start here: reset Wave 6 (spaces)

Both briefs are written and committed: `docs/waves/briefs/reset-w6-spaces.md` (software-factory) and `docs/waves/briefs/reset-w6-dotfiles.md`
(dotfiles). Disjoint repos, spawn both: `rd fan software-factory --role worker docs/waves/briefs/reset-w6-spaces.md` and
`rd fan dotfiles --role worker docs/waves/briefs/reset-w6-dotfiles.md`, then `factory session wait --on workers`. **Before spawning the
software-factory one, check no Issue of this repo is mid-merge** (Issue 66): its branch would race yours at merge; wait for 66 to ship.
Decided: the sidebar order is dotfiles `groups.json`'s, the factory never reorders the app doc (learnings, Wave 5 entry).
Then Wave 7 (`issue_facts`): no brief yet; write it from design v3 §11 and the Explore map of `issues`, `issue_events`, `evidence`,
`decisions`, `sessions`.

## How this loop runs (what worked tonight)

- Per wave: brief → `rd fan … --role worker` → `factory session wait --on workers` → `rd read` → `rd close <worker>` at once → read the diff →
  **rebase the branch onto `origin/master` before the review if master moved** (`git -C <worktree> rebase origin/master && git push
  --force-with-lease`) → `make check` in the worktree → `/review --branch` (prepare, `reviewer` subagent with the seat, submit verbatim,
  restore `&lt;`/`&gt;` to `<`/`>`) → fixes by `@implementer` in the worktree → round 2 → `agw review covered --range origin/master..<branch>`
  → **land as a fast-forward** (`git -C <worktree> push origin HEAD:master`; GitHub marks the PR merged) → `make deploy` → `make verify` →
  proof. `rd merge` re-runs `make check` and rebases; skip it when the branch already sits on `origin/master` and the check ran.
- `agw review submit` takes no `--cwd`. Dispose every finding (`fixed|wrong|intentional|irrelevant --reason`).
- dotfiles `make check` is red on `architecture-check` from other work (launchd labels `com.jkrumm.home-nacht`, `com.iu.athena-repo-sync`,
  `com.jkrumm.soloist-speaker`); run `make -k check` and judge the rest.
- A worker on a repo whose sync pulls master (homelab `make uk-sync`) merges before review; review it after and record it.

## Sharp edges found tonight

- **The shared Postgres can die with the Colima VM** (about 02:40Z): factory and agw down, nothing paged. Diagnose with `cd ~/SourceRoot/vps &&
  make dev-pg-health` (and `make ps`); a dead VM (`colima status`: "empty value", docker socket gone) comes back with
  `cd ~/SourceRoot/dotfiles && make colima-restart` (50 s), and launchd relaunches the factory by itself. Never `make down` in vps.
- Load flakes in `make check`: `evidence.test.ts` "a note reaches the lead while the check runs" (once, 3/3 alone). The hc-spaces flake is fixed (Issue 64).
- Accounts at 03:15Z: `iu` 12 % week, `me` 95 % (resets 06:00Z), `me2` 78 %. Keep workers off `me` until its reset.
- No `xcodebuild` or simulator before 07:00.

## The asks right now

`/fleet` asks: the 5 human-queue entries (WeatherOrb iPhone, the old Wave 8 cutover, the MacBook core, two IuRoot teamchat deploy-gate
entries) and 1 digest `reply` from rotation 1's last message. Health: Issue 49 parked (homelab-private, `lead_gone`, a security decision),
the two failed agw spawns of 2026-11-02, review `rv_kmnj…` needing a human. Do not answer the owner's decisions. The 02:15Z
`vps-pg-backup` failed (`pg_dump`: shared memory "No space left on device"): the owner's, recorded in learnings.

## Running now, not yours

iris Wave 21/22 workers (idle), agent-workflows PR lanes (idle), IuRoot sessions (never touch), `software-factory-w8` (rotation 1's tab, idle).
