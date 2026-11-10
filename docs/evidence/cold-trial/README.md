# Cold-session trial: an agent works with the factory from its CLI alone (Issue 650)

**The trial.** A fresh session with no context but one sentence: *in the git repo `<scratch>`, plan and file a 10-row plan
with dependencies with the software factory, follow it, and change one edge.* It may use `factory` (a wrapper that runs
the worktree's CLI under the owner path of a plain host session) and nothing else: no docs, no skills, no `AGENTS.md`, no
source. Each run got a new scratch repo (its own `.git`, a local bare `origin`, `leads: 1`) whose queue was set to
`drain`, so the Issues it filed stay queued and no lead spends anything. Each run is a Haiku subagent, the cheapest and
least forgiving reader; the sentence and harness notes are the whole brief. The scratch repos and their Issues were
cancelled and deleted afterwards.

What a stumble is here: a call that failed, or a guess the answer corrected, because of a rule `--help`, `factory issue
schema` or `factory plan schema` did not state.

## Run 1: 3 stumbles

Transcript of the factory calls (every answer trimmed; `<scratch>` stands for the repo):

| Call | Answer |
|-|-|
| `factory --help` | the command list |
| `factory plan schema` | the plan format page |
| `factory project list --format plain` | one 70 KB line |
| `factory project show <scratch> --format plain` | `no plan` (before the push) |
| `factory project sync --help` | `--fetch <text>` and nothing about its values |
| `factory issue schema` | the filing contract |
| `factory plan check docs/plan.yaml` | `ok: docs/plan.yaml, 10 rows` |
| `factory project sync --fetch true --format plain` | **before the fix: `server unreachable ... The operation timed out` after 10 s**, with the server up; after: `synced 28` |
| `factory project show <scratch> --format plain` | rows, three `open` with their Issue, seven `waiting after ...` |
| `factory planning after --help` | usage |
| `factory planning after --issue issue_702 --after issue_700` | `edges 1` |
| `factory issue show issue_702 --format plain` | no edge anywhere in the answer |
| `factory read chain --format plain` | 115 KB; `blocking.issue_702 ["issue_700"]` is the only place the edge shows |

Stumbles and what was done:

1. A fetching `project sync` reads every project's remote and takes 20 s or more; the CLI's 10 s transport default
   reported it as an unreachable server. `project.sync` and `planning.pass` now wait as long as `issue.ship` does
   (`apps/cli/src/operation.ts`).
2. `--fetch <text>` named no values, and `project.sync --help` said nothing of when it is needed. The command's help now
   says `--fetch true` reads a plan just pushed (`apps/cli/src/filing.ts`).
3. `issue show` carries no `after` edge and nothing said where to look. `issue show --help` and `docs/plan.md` now point to
   `factory read chain`. The plan page also gained "Changing an edge": a row with no Issue is changed in the file; a row
   whose Issue exists is changed with `planning after` / `planning unafter`, and editing the row then does nothing.

## Run 2: 1 stumble

Same calls up to the plan, then `plan schema --help` and `plan check --help` and the edge change through
`planning after --issue 705 --after 704`:

| Call | Answer |
|-|-|
| `factory plan schema --help` | exit 2, `Unknown option '--help'` (the hint carried the usage) |
| `factory plan check --help` | exit 2, the same |
| `factory project sync --fetch true` | `{"synced":29,...}` in 20 s |
| `factory project show <scratch> --format plain` | three rows `open`, seven `waiting` |
| `factory planning after --issue 705 --after 704` | `{"issue":"issue_705","edges":1}` |
| `factory queue order --format plain` | Issue 705's reason is `waits for Issue 704 to close` (it was `drain`) |

The stumble: a hand-written verb (`plan schema`, `plan check`) rejected `--help`; every generated command accepts it.
Every hand-written verb now answers `--help` with its usage line and summary, exit 0 (`apps/cli/src/run.ts`).

## Run 3: no failed call, no wrong guess

The last run, after the fixes (worktree CLI). The session never read a doc outside the CLI's own answers.

| Call | Exit | Answer |
|-|-|-|
| `factory --help` | 0 | the command list |
| `factory plan schema` | 0 | the plan format page |
| `factory project list` | 0 | one 58 KB JSON line (not needed; see below) |
| `factory queue get` | 0 | the repo is `drain`, the others `run` |
| `factory plan check <scratch>/docs/plan.yaml` | 0 | `ok: ..., 10 rows` |
| `git commit`, `git push origin master` | 0 | the plan on the default branch |
| `factory project sync --fetch true` | 0 | `{"synced":30,"broken":[],"retired":[],"errors":[]}` |
| `factory project show <scratch> --format plain` | 0 | note-1, note-2, note-7 `open` as issue_706, 707, 708; seven `waiting after ...` |
| `factory issue list --repo <scratch> --state open --format plain` | 0 | the three Issues, `queued` |
| `factory read chain --format plain` | 0 | 119 KB for every project |
| `factory issue show 706 --format plain` | 0 | the Issue; timeline `Filed.`, `Settled and queued.` |
| edit `after` of note-4 in the plan file, `factory plan check`, `git push` | 0 | |
| `factory project sync --fetch true` | 0 | `synced 30` |
| `factory project show <scratch> --format plain` | 0 | `note-4 waiting after note-2` (it was `after note-1`) |
| `factory issue list --repo <scratch> --state open --format plain` | 0 | unchanged |

The session picked the plan-file path for the edge on its own, because the row had no Issue yet and the plan page says so.

Left over, filed through the friction route (`factory signal file --from agent:software-factory --repo software-factory`;
triage merged it into this Issue): `factory project list` and `factory read chain` answer for every project, 58 KB and
119 KB, to a session that wants one repo. No call failed. A `--repo` filter on both, like `issue list` has, is the fix.

## What the trial does not show

- The sessions are Haiku subagents in the owner path of a plain host session, not an Issue lead (which holds an agent
  token and cannot file Issues, edit edges or sync projects). A lead's verbs are in its brief and were not re-tried.
- The parent's global instructions reach a subagent; the sentence and harness notes told it to ignore docs, skills and
  `AGENTS.md`, and no run reported reading one.
- "Follow it" is reading state (`project show`, `issue list`, `issue show`, `queue order`): the queue of each scratch repo
  was drained on purpose, so no lead ran and no row was released by a closing Issue.
