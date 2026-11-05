# Program lead handoff: the reset, stopped for the owner

Written 2026-11-05 ~04:55Z by rotation 3 of the reset (PLAN.md Wave 10, pane t13p). Reset Waves 1–7 of `docs/waves/reset.md` are
done and live; the loop stops here, at `reset.md`'s "Stop for the owner". The owner reads `docs/strategy/2026-11-reset/learnings.md` and
this file first.

## Read first

1. `docs/decisions.md` RS1–RS9.
2. `docs/strategy/2026-11-reset/design-v3.md` (§12 What goes, §13 the build order: rows 7–9 are next).
3. `docs/waves/reset.md` (every wave with its Left behind).
4. `docs/strategy/2026-11-reset/learnings.md`: the Wave 6 and Wave 7 entries.

## Done in rotation 3 (verified live)

| Wave | What | Landed, deploy | Proof |
|-|-|-|-|
| 6 spaces | `spaces.json` from `groups.json`; the reconcile (start, every 10 min) with a `plan:<repo>` login shell per entry; `close` refuses a `plan:` key; hc-reap keeps plan tabs and keyless terminals | #44 `ed175476713c`, dotfiles #62 | 40 plan shells `t13t`..`t153`; the second pass changed nothing |
| 7 `issue_facts` | the view (one row per attempt), `factory issue facts [--since]`, the KPI line from one query | #45 `b7d749a7ed2c` | 39 rows for 37 Issues; `asks/issue 0.05 (2/37)  zero-touch 94 % (15/16)  first-hold 81 % (13/16)  window -` |

Also: Issue 64 closed `done` (second hold green); Issue 66 (verify accepts a docs-only drift) shipped by a Sonnet-high lead 9 min after
admission, closed `done` on its first hold at 04:08Z. The "no master push during a hold" rule is retired with it. Every range `covered` true, every
deploy `make verify` all passed.

## The owner's (not asks; nothing waits on them)

- **Two doubled spaces.** The app's `agent-workflows` and `epos-ai-teamchat-athena` spaces have folder `~/IuRoot` in the app doc, so the
  reconcile (keyed by real path) seeded correct ones beside them. Close the old ones in the app when convenient (their terminals: `t11p`,
  `t11q` with its review children; `t126`, `t133`). The factory does not edit your spaces.
- **IuRoot spaces have plan tabs too.** `FACTORY_REPO_ROOTS` covers both workspaces; the plan shells there read and send nothing. If you
  want none there, set `FACTORY_REPO_ROOTS` or drop the IuRoot members from what `factory-spaces.py` renders.
- **The sidebar is not seen yet:** the app was not connected at the proof. In a space that already had tabs, the plan tab sits last.
- **Next rows** (7: dotfiles `rd` thin client, `/wave` → the lead's playbook, hc-reap trimmed, `wave-gate.py` gone; 8–9: the deletions)
  change the machinery this loop runs on. They start after your read of the learnings; a new program lead wave of `PLAN.md` runs them.

## State at the stop

- Open Issues: only 49 (homelab-private, parked `lead_gone` 44 h, a security decision; yours).
- `factory status`: 0 asks, 7 health lines (2 expired notes to an IuRoot wave, 2 failed agw spawns of 2026-11-02, Issue 49, Issue 36's kept
  gameday worktree, review `rv_kmnj…` needing a human). The 5 human-queue entries on `/fleet` are unchanged from rotation 2.
- Accounts at 04:50Z: `iu` 13 % week, `me` 95 % (resets 06:00Z), `me2` 79 %.
- Worktrees `reset-w7-issue-facts` (software-factory) and `reset-w6-dotfiles` (dotfiles) are merged and kept as "fresh" by `rd fan --clean`;
  the next clean removes them.
- dotfiles `make verify`: 2 red, neither the reset's (`tcc`: an IuRoot LaunchAgent's versioned python; `architecture map`: the known
  unmapped launchd labels).

## How this loop ran (unchanged, it held)

Per wave: brief → `rd fan … --role worker` → `factory session wait --on workers` → `rd read` → `rd close` → rebase onto `origin/master` if
master moved → `/review --branch` (prepare, `reviewer` with the seat, submit verbatim with `<`/`>` restored, dispose) → fixes by
`@implementer` → round 2 → `agw review covered` → `make check` in the worktree → fast-forward to master → `make deploy` → `make verify` →
proof → learnings, `reset.md`. Workers may run while another wave lands; `make check` runs stay one at a time.
