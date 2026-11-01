# Program lead handoff

Written by rotation 5, 2026-11-01 18:00, after a review of the whole estate. State lives in `docs/program.md`; this page
holds what that table does not. The rotation 3 page is in git history.

## Running now

| Agent | Repo | Work | Next |
|-|-|-|-|
| `dotfiles-w8` … `-w10` | dotfiles (chain, finished) | Wave 10 closed the herdr-core migration | owner-timed leftovers only (dotfiles PLAN Wave 9) |
| `iris-mother`, `iris-w19b` | iris (mother + lead, tabs) | Wave 19 (R5 polish, Mac completion, data safety) | after Wave 19 the mother recommends a pause until the Apple enrolment |
| `agent-workflows-w1-r2`, `-w1-r3` | agent-workflows (mother + lead) | the inference gateway (Wave 2), then review v2 | its own night; the owner's review answers go to the mother as one note |

## What the 2026-11-01 review found

- **Wired and used:** the fleet layer. `rd`, the hooks, the iris fleet and the `jk-board` app mod are its consumers.
- **Not wired, no code:** Kuma, HyperDX, GitHub, TickTick and Beszel into the factory (F3; every alert goes to Slack
  only); the Issue machine (F2); any factory → owner notification (the owner sees only `factory status` and `jk-board`);
  Hermes ↔ factory; Argo's Fleet pages (A2, Argo reads `agw agents`); iris' fleet screens (IR).
- **Fixed and live (PR #16):** spent keys (134 old spawns read `ended`, a create on one is `409 key_spent`, `rd` takes
  `-r2`), resume after a core restart (the note is typed into a session `hc-resume` resumed in place, never a second copy),
  resumed finished waves no longer hold their repo, `t1n`-style addresses. The restart paths are proven by tests only.
- **Open in the factory:** a wake fires when a worker ends its turn on background shells (`idle`, but work still runs).
  The factory cannot see background shells; the worker contract must say "wait in the foreground before ending a turn"
  (`/wave` skill `roles/worker.md`, the fan brief template). Also from the fix worker: `wave_live` and `RD_WAVE_MAX` don't
  count `-rN` agents; `Spawn.pane` keeps the original pane after the witness rematches; `hc-resume` resumes without
  `--model/--effort`; a `pane_gone` spends a key even if the agent comes back; `docs/remote-dev.md` still says every
  structured create error falls back to hc.
- **Also open:** `rd`'s direct-to-hc path never seeds a new space's entry (the factory does since PR #17), so an `rd` tab in a
  repo with no space still gets a space named after its cwd. `rd close` refuses a worker whose worktree `gh pr merge
  --delete-branch` already removed ("could not read git status"); close those with `hc kill` after checking the branch is on master.
  A spawn's seed is best effort: the rest of the PR's own deferred list is in PR #17.
- **Waves are tabs by design.** Only fan workers are hidden children, and they show nowhere because the jk layout replaces
  the app's `agents` mod. If the owner wants "only the orchestrator tab", orchestrated waves become hidden children of
  the orchestrator's terminal and `jk-board` lists them (with `terminal.peek`); unused app features that fit: `tab.settle`
  for finished chain tabs, `notify` for "wave done / gate stopped", events instead of the board's 30 s polling.
- **Docs stale elsewhere:** agw `AGENTS.md` status, `concept.md` model notes, `factory-input.md` (outbox to Argo), the
  `/review` skill text; Hermes `docs/scheduled-jobs.md` lists the paused briefings as live; iris `handoff/mother.md`
  (classic `send-keys`, its own polling watcher instead of `factory session wait`); AGENTS.md here line "doc shape …
  unverified" (the live document confirms `spaces[].{id,name,folder,tabs[].{id,name,root}}`).

## Next

The owner answered (2026-11-01 19:30): F2 in full tonight, intake pulled forward, all eleven decisions as recommended, the
review eval on Max first. The night runs as `PLAN.md` Wave 6 under a fresh lead; the plan is `docs/waves/night-2026-11-01.md`.
agw is not the lead's: its mother runs the gateway, then review v2 (agw `docs/waves/PLAN.md` Waves 2–9).

## Watch

- **Load flakes:** the hc adapter tests time out at load 60+; `rd merge` then fails its local check. CI on GitHub is the
  judge; merge with `gh pr merge --rebase` after a green CI and a local green run.
- **Accounts:** `me2` back from its weekly wall 11-01 18:00; `me` at 90 % of its week; `iu` carries most work.
- **Prompt suggestions** sit in finished workers' input boxes. Nobody typed them; never act on them.
