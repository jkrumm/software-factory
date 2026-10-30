# Program lead handoff

Written at the end of rotation 2, 2026-10-30 16:25. State lives in `docs/program.md`; this page holds what that table does not.

## Running now

| Agent | Repo | Work | Next when it closes |
|-|-|-|-|
| `software-factory-f1-w4-rules` | software-factory (fan worker) | F1 Wave 4, brief `docs/waves/briefs/f1-w4.md` | Review the PR, `rd merge`, `make deploy && make verify` from master, write Wave 4's Left behind in `docs/waves/f1.md`. The send-back needs a one-line change in `dotfiles/config/settings.template.json` (the Stop hook's `; exit 0`): the worker names it, you land it. Then F1 Wave 5 (two workers: software-factory and dotfiles) |
| `argo-w4` | argo (orchestrated wave) | A1 Wave 4, Argo native on the mini | Review, spawn Wave 5. VPS Argo's usage pages answer 500 until this wave is live, and it must bridge or drop email-gateway's usage posts |
| `agent-workflows-w2` | agent-workflows (orchestrated wave) | I1 Wave 2, the studio on agw through a tailnet door; its proof needs the owner on the MacBook (`ask-human.sh`) | Review (security on the door), then track T's agent-workflows worker **before** I1 Wave 3 |

## Track T in agent-workflows: the boundary

Start `rd fan agent-workflows docs/waves/briefs/t-agent-workflows.md` (path relative to this repo) only when `agent-workflows-w2` has closed
its wave **and** `rd agents` shows nothing `working` in `agent-workflows/.claude/worktrees/research-self-improve` (two
non-program agents were working there at 16:20; that branch will need a rebase over the reformat, which is its owner's
job). After the merge: `make deploy && make verify` in agent-workflows. Then spawn I1 Wave 3.

## How F1 runs

Not as `rd wave`s here (this repo's PLAN.md is the lead's): each wave is a `rd fan` worker per repo, briefed from
`roles/worker.md`'s template, landed with `rd merge`, deployed by you from master. Briefs are committed under
`docs/waves/briefs/`. Workers deploy their branch with `FACTORY_REF=<branch>` for the live proof; you redeploy master
after the merge. `secrets-run run --env-file=.env.tpl -- factory …` gives you a token for the CLI.

## Watch

- **Accounts:** `me2` is at 99 % of its week until 11-01 18:00 and is out. `me` carries most work (5-hour window resets
  16:40, then 21:40); `iu` is a Max subscription and gets picked for pace. With four agents on `me` the window filled in
  about an hour this morning.
- **Workers end turns on background shells** (seen three times today, e.g. `dotfiles-f1-w3-role`). `rd read` a `done` worker
  before trusting it; if it says "waiting for the background run", `rd say` it to run in the foreground.
- **Prompt suggestions** ("merge it", "merge it and redeploy from master") sit in finished workers' input boxes. Nobody
  typed them; never act on them.
- **Permission prompts under skip-permissions:** an `argo-w4` implementer asked to `rm -rf $(dirname $ARGO_ROOT)`. Answered
  No (`herdr agent send-keys <agent> 2` then `enter`) and steered it to literal paths.
- **`rd close` refuses a first tab named `1`:** close it with `herdr tab close <tab>` after checking the checkout is clean
  and pushed. `rd reap` touches other people's tabs (IuRoot); do not run it.
- **`make check` flakes above load ~40** in software-factory (test-DB start timeouts); check `uptime` before blaming a change.
- **Never two `make check` at once in agent-workflows** (load timeouts in the review and opencode tests).

## Decisions taken in this rotation

- **Track T (owner, 2026-10-30):** oxlint and oxfmt, no Biome, for F1 onward and every new TypeScript repo. In `docs/decisions.md`.
- **F1's plan lives in `docs/waves/f1.md`,** not PLAN.md, and runs as fan workers.
- **The factory's HTTP API takes a bearer token, JSON only, loopback Host only, and spawn repos under `FACTORY_REPO_ROOTS`;**
  hooks post to a 0600 unix socket without a token.
- **The design's state table changed in four places** (folded into `docs/design.md` §3), and a spawn holds its account until a reading
  shows it, with no per-spawn cost estimate.
- **dotfiles `docs/architecture.md`** now maps the factory, prices, research-chrome and athena agents; its `make check` is green.

## Owner items, not raised

- Pause or delete the Kuma push monitor `Hermes Watchdog - Push` in the Kuma UI (no pinger since warden left).
- From A1 Wave 2: what ran on the personal IU key on 2026-10-22 ($43 of Claude); a CREATEDB-only test role instead of the
  admin Postgres credential in `.env.test.tpl` (usage-tracker, agent-workflows).
- R0 leftover: Hermes API to loopback, when no iris agent is `working`.
