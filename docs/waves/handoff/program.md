# Program lead handoff: the reset, rotation 2

Written 2026-11-05 ~01:40Z by rotation 1 of the reset (PLAN.md Wave 8, pane t12x), rotated at about 60 % context. You are
the program lead for the reset: `PLAN.md` Wave 9, track plan `docs/waves/reset.md`, starting at its **Wave 4**. The owner
reads `docs/strategy/2026-11-reset/learnings.md` and this file in the morning.

## Read first

1. `docs/decisions.md` RS1–RS9.
2. `docs/strategy/2026-11-reset/design-v3.md` (§3 the lead, §6 the health line, §13 the build order).
3. `docs/waves/reset.md` (Waves 1–3 done with their Left behind; Wave 4 `active`).
4. `docs/strategy/2026-11-reset/learnings.md`: everything below with evidence.

## Done in rotation 1 (verified live)

| Wave | What | PRs, deploy | Proof |
|-|-|-|-|
| 1 cutover | Issues 51–55 dropped, 51's pane and worktree gone | docs `3d6ac33` | no open software-factory Issue |
| 2 deps | `issue new --after`, admission respects deps, `issue prio` | #37, `272be2f` | Issue 60 `--after 59` admitted 6 s after 59 closed |
| 3 parks | `unreported` ends on the lead's turn, `lead_gone` restarts (≤ 2), send-back skips background tasks, red verify re-run once | #38, #39, deployed `a2c4293f559a` | Issue 62 (note finds the lead gone), Issue 63 (sweep finds it after 10 min) |

Every merged range `covered` true; every deploy `make verify` all passed.

## Start here: reset Wave 4

The brief is written and committed: `docs/waves/briefs/reset-w4-lead.md` (operating contract in `brief.ts` with the no-change
end, `lead` → Sonnet high in `config/roles.json` and `leadLevel`, `FACTORY_LEADS_PER_ACCOUNT` cap in spawn admission, the
`SessionStart(compact)` re-read line in the hook). Spawn it: `rd fan software-factory --role worker docs/waves/briefs/reset-w4-lead.md`,
then `factory session wait --on workers`. Its live proof needs a small real Issue end to end on Sonnet high with zero touch:
pick one from the owner's backlog (`docs/program.md`) or a docs fix; record wall time, attempts, review tier.

**After Wave 4 merges, `role get lead` is Sonnet high.** Your own next rotation then spawns with `rd wave --role deep …`
(Opus high), not `--role lead`.

## How this loop runs (what worked)

- Per wave: brief → `rd fan … --role worker` → wait → `rd read` → read the diff → `rd close <worker>` **at once** (an idle child
  makes the Stop hook send you back: `stopCheck` counts every non-dead child) → `make check` in the worktree → `/review` (prepare,
  `reviewer` subagent with the seat, submit verbatim) → fixes by `@implementer` in the worktree → round 2 → a light review of any
  later fix commit (coverage is per commit) → `agw review covered` → `rd merge` → `make deploy` → `make verify` → live proof →
  learnings → tick `reset.md`.
- The reviewer's reply arrives HTML-escaped in the task notification (`&lt;`, `-&gt;`): restore `<`/`>` when submitting.
- Live proofs use `~/SourceRoot/dispatch-scratch` scratch Issues; a Haiku lead drops a `sleep` task, so kill the lead right after
  `spawn list` shows it `started`.

## Sharp edges found tonight

- **Load from other sessions.** IuRoot `athena-a*` vitest runs (~120 workers) pushed the load to 558; the factory lost its DB lock
  and exited twice, one relaunch failed on `secrets-run` (0/2 refs), and it recovered by itself. Under load `factory spawn create`
  times out and `rd fan` falls back to hc-direct on `me` (95 % week): if `rd` prints "using hc directly", kill that worker and
  respawn once the server answers.
- **Stale wakes.** A "workers done" note for an already-closed worker can arrive while the next worker runs: check
  `factory session list` before acting on a wake, and declare the wait again.
- `hc-spaces.test.ts` "two starts at once" is a timing flake (fails ~1 in 3 alone at low load); rerun the file.
- Accounts at handoff: `iu` 11 % week, `me` 95 % (resets 2026-11-05 06:00Z), `me2` 79 %. Keep workers off `me` until its reset.
- No `xcodebuild` or simulator before 07:00.

## The asks right now (9)

The 7 of rotation 1's start (WeatherOrb iPhone, the old Wave 8 cutover, the MacBook core, Issue 49, review `rv_kmnj…`, the two
failed agw spawns) plus two IuRoot teamchat deploy-gate entries (not ours). Open Issues: 49 (homelab-private, parked
`lead_gone`, a security decision), 61 (weatherorb alert, `watching`, its own lead). Do not answer the owner's decisions.

## Running now, not yours

iris Wave 21/22 workers (idle), agent-workflows PR lanes (idle), IuRoot sessions (never touch).
