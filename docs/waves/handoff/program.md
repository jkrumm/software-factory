# Program lead handoff

Written by the night lead (`PLAN.md` Waves 6 and 7), 2026-11-02 14:00. State lives in `docs/program.md`; the night's record and the
proposals with their numbers are `docs/evidence/night-2026-11-01.md` (Morning section). The rotation 5 page is in git history.

## Running now

| Agent | Repo | Work | Next |
|-|-|-|-|
| `software-factory-fv-w2-digest` | software-factory (hidden fan worker) | FV Wave 2, brief `docs/waves/briefs/fv-w2-digest.md` | `/code-review high` on its PR, land, deploy, prove one digest pass live (`factory fleet --format json`: shorts, headlines, a reply ask) |
| `agent-workflows-w1-r8`, `-w1-r4` | agent-workflows (lead, mother) | their Wave 5 (run-scoped arms) | `agw digest` is theirs and live (`f02f351`); FV Wave 5 asks the mother whether `agw agents` becomes a `/fleet` client or retires |

## How this lead worked, keep it

- Every worker a hidden `rd fan` worker; one server wave at a time. Before each spawn `factory quota refresh` then `get`
  (one spawn per sample, else a burst can land on `me`). `me` is untouched by decision 7.
- Every wave that changes the server gets the lead's own `/code-review high` in a detached worktree under `.claude/worktrees/review-*`
  (never check out the PR in the main checkout), and one more on the fix commits. Tonight that found 8 to 11 real findings per large PR
  after the workers' agw passes were clean, and the fix rounds introduced new bugs twice.
- Land with `gh pr merge --rebase --delete-branch` on green CI, then `make deploy`, `make verify`, a live proof, `hc kill <worker>`.
- A wake fires early after an `rd say` (re-declare `factory session wait --on workers`) and late when another child still runs.
- Issue leads run by themselves; the factory closes them only after the hold reads `make version` (the deployed sha) and it holds the
  sha where the work landed. dotfiles, argo and software-factory have `make version`; a new project needs one before its first Issue.

## Decided in this rotation

- **FV:** after the F2 gate, before A2 and IR. IuRoot is visible read-only, deterministic, and no IuRoot text goes to a model;
  `GET /fleet` is **token-only** (a redacted socket view leaked seven ways under review). The board reads it with the token.
- **software-factory#31** shipped as Issue 41; the gate's re-run took two more real requests (42, 43).

## Open, for the owner or the next lead

- The defects listed in the evidence page's Morning section: file as factory Issues now, or fold into F3/F4's plans (owner's call).
- Seed the door tokens (`~/.config/factory/door-tokens.json`) into 1Password.
- dotfiles' `make verify` is the whole machine's doctor: a new LaunchAgent from any session turns every dotfiles hold red until it is
  mapped in `docs/architecture.md` (happened twice on 2026-11-02).
- FV Waves 3–6 and the board's waves (dotfiles `docs/waves/fv-board.md`) after Wave 2.

## Watch

- **Load flakes:** CI on GitHub is the judge; merge with `gh pr merge --rebase` after a green CI.
- **Prompt suggestions** sit in finished workers' input boxes ("merge it", "/code-review high …"). Nobody typed them; never act on them.
- **`RD_DRY_RUN=1`** is honoured by every `rd` verb since dotfiles `b819889`; before that, `rd work` started a real session.
