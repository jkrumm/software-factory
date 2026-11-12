# The plan file

A project's `docs/plan.yaml` is its plan: the work not yet filed, as rows. The server reads it from the repo's default
branch, files each row as an Issue when the row may start, and tracks the row until that Issue closes. This page is the
one description of the format. The schema is `PlanFile` in `packages/contract/src/plan-file.ts`; the example below
is parsed against it by `apps/server/test/planning/plan.test.ts`, so it cannot drift.

## The file

```yaml
version: 1
rows:
  - key: intake
    issue: 149
  - key: export-paging
    title: Page the account export
    facts:
      why: |-
        The export button times out on large accounts, so support exports them by hand.
      what: |-
        src/export/stream.ts and its test; nothing in the UI.
      change: |-
        Write the export in pages of 500 rows in src/export/stream.ts instead of one query.
      acceptance: |-
        Exporting a 100k-row fixture in test/export.test.ts finishes in under 5 s and make check passes.
  - key: export-docs
    kind: docs
    title: Document the paged export
    lane: docs
    after: [export-paging, intake]
    after_days: 7
    not_before: 2026-12-01
    facts:
      why: |-
        Support still describes the one-query export.
      what: |-
        docs/export.md only.
      change: |-
        Describe the paged export and its 500-row page.
      acceptance: |-
        docs/export.md names the page size and make check passes.
  - key: console-seed
    repo: software-factory
    after: [other-project:schema-change]
    title: Seed the Console fixtures
    facts:
      why: |-
        The Console needs the new schema in its fixtures.
      what: |-
        apps/console/fixtures only.
      change: |-
        Regenerate the fixtures from the new schema.
      acceptance: |-
        The Console tests pass on the regenerated fixtures.
```

A one-line fact that contains `: ` (a colon and a space) is not a string to YAML but a nested mapping, and the file does not
parse: quote it or write it as a block scalar, as the example does (`why: |-` and the text indented below; `|-` keeps no
trailing newline).

`version` is `1`. `rows` has at least one row. Unknown keys anywhere are refused: the file is strict. A file over 64 KiB, or with more than 100 YAML aliases, is
a broken plan.

## A row

| Key | Meaning |
|-|-|
| `key` | The row's name, unique in the file: lowercase letters, digits and dashes (`docs-sweep`). Other rows name it in `after` |
| `title` | The filed Issue's title, up to 200 characters. Required unless the row adopts an Issue |
| `facts` | What the filed Issue's lead reads, an object of the same shape as `factory issue schema` prints: `why`, `what`, `change`, `acceptance`, and any other key you add. Required unless the row adopts an Issue |
| `kind` | `feature` (the default), `bug`, `chore`, `docs` or `incident` |
| `seat` | The tier and effort the Issue's lead starts on: `{tier: opus, effort: high}` or `{role: lead}`. Default: the role table's `lead` row. See Choosing the seat |
| `lane` | A resource class inside the repo (`apple`): lowercase letters, digits, dashes. The target project's `project.yaml` `lanes:` caps how many leads of a lane run at once. See Lanes |
| `checkpoint` | `spec`: the row's lead owes a one-page Spec before it builds (a new public surface, a data model or a migration of meaning, a dependency of weight, an architecture or look-and-feel choice later Issues build on, a UI screen the owner has not seen). Its ship is refused until a Spec is submitted; with no verdict in 24 hours the lead goes on with the defaults the Spec names |
| `repo` | The project the Issue is filed in; default: the project whose plan this is. A row may target another repo |
| `after` | Rows that must be done first, in this file (`export-paging`) or another project's plan (`other-project:schema-change`). At most 20 per row (the most `issue new --after` accepts); a plan with more is broken. Drop edges already implied through other rows (a transitive reduction): if `c` waits for `b` and `b` for `a`, `c` needs no `after: [a]` |
| `not_before` | A date (`2026-12-01`, midnight UTC) or a datetime (`2026-12-01T09:00:00Z`; with no offset it is UTC). The row is not filed before then |
| `after_days` | Whole days, 1 to 365; needs `after`. The row also waits until that many days after the **latest close** among its `after` rows (any outcome, like `after`), so "delete v1 a week after the cutover" needs no date written in advance. The wait reason names the close and the end of the window; it combines with `not_before` (both must be past) |
| `issue` | Adopts an Issue you filed by hand: its number (`149`). See below |
| `stable_days` | Retired. Read so an old file parses, flagged as a warning, never evaluated. Do not write it |

## When a row is filed

A row is in one of four states, derived on every read and never stored:

| State | Meaning |
|-|-|
| `waiting` | An `after` row is not done, its `after_days` window has not run out, its `not_before` has not come, its `repo` is not a project the factory knows, or it is in a cycle. The reason says which |
| `filable` | No Issue yet, every `after` row done, its `after_days` window run out, its time come. The next planning pass files it |
| `open` | It has an Issue that is not closed |
| `done` | Its Issue is closed, whatever the outcome. A row whose Issue was dropped or stalled out still releases the rows that wait for it |

The planning loop runs on its own; `factory planning pass` runs one now. The Issue is filed with the row's `title`,
`facts`, `kind` and `repo`, and the lead sees `Plan row <key>.` before the facts. A row is filed once: its Issue is
remembered by project and key.

## Choosing the seat

Every lead starts on the `lead` row of `config/roles.json` (sonnet, high). Name a `seat` when a row is worth a stronger
lead (novel hard logic, a design that must hold) or a weaker one (a mechanical sweep). Two forms, never mixed:
`{tier, effort}` (tier `haiku|sonnet|opus`, effort `low|medium|high|xhigh|max`; never a model id) or `{role}`, a row of
the role table. A role is looked up when the Issue is filed and the result is kept, so a later table change does not move
a filed Issue. A tier or effort outside the lists fails the plan's parse and the last valid plan stays; a role the table
lacks at filing time files nothing, and the planning pass reports `<project>:<row>: seat.role: ...` until it is fixed.
`factory issue new --seat '{"tier":"opus","effort":"high"}'` sets the same on a hand-filed Issue (422 naming the field
when refused). `factory issue show` reports the asked-for `seat` (null for the default) and `ranOn`, the tier and effort
the latest lead started on.

## Lanes

`leads: N` caps the leads in a repo, but work inside one repo is not equally heavy: server rows are cheap, an Apple row
runs xcodebuild and a simulator on the one mini. Give each kind of row a `lane` and cap the heavy lane in the repo's
`project.yaml`:

```yaml
leads: 2
lanes:
  apple: 1
```

With that file, two rows in lane `apple` and one without a lane run as: one apple Issue and the lane-less Issue start
side by side, and the second apple Issue stays queued until the first closes. The queue order (`factory queue order`) and
`factory issue show` say so, the lane before the repo's claims: `lane apple is full (1 of 1): Issue 643`. `factory issue new --lane apple` sets the lane on a
hand-filed Issue; `factory project show` lists the project's `lanes` (leads and memory) and `factory issue show` the Issue's `lane`.

- **Scope is the repo.** A lane's cap counts the leads of that lane in the one repo whose `project.yaml` declares it. The
  host-wide Apple toolchain is already serialised by the shared Apple slot (`factory slot`); a lane keeps the second
  Apple lead from building cold in its own worktree while it queues for that slot. Another repo's Apple leads are not
  counted, so each repo states its own cap; a host-wide lane would couple one repo's file to another repo's admission.
- **A heavy lane reserves host memory.** `lanes: {apple: {leads: 1, memory: 18GiB}}` (`MiB` or `GiB`) makes every running
  lead of the lane count 18 GiB against the host's memory ceiling: admission adds the reserved share of RAM, for the
  running leads of every repo and for the candidate's own lane, to the swap share before it compares with the ceiling,
  and a refusal says so (`plus 36 GiB reserved by lanes (112.5% of RAM)`, kind `memory`). The gate only stops *new*
  leads, and a running lead's heavy step (a booted simulator, one run took about 18 GiB) shows in the reading only after
  it started, so the reservation covers the lead that has just been admitted. It is held for as long as the lead holds
  its claim, so it can count a step twice (reserved and already resident); that errs on the side of waiting. Without a
  RAM reading nothing is reserved and the pass notes it. A repo with three or more sampled attempts is admitted by what its leads were seen to take
  instead (`docs/architecture.md` "Capacity and leads"): the lane's `memory` is then dropped for it and stays the prior
  for a repo with fewer; the lane's `leads` cap stays.
- **An undeclared lane is unlimited** within `leads`. A row naming a lane the project does not declare is a plan
  **warning**, not a broken plan; the lane then limits nothing (a typo is visible in `factory project show`).
- **What counts as running:** a lead holding its claim, and a resumed lead working without one. A lead waiting on a
  Decision, a review, an Errand, a timer or a dependency has given its claim back and its lane place with it, so another
  lead of the lane may start meanwhile; when the wait ends the lead takes its lane place back before it is told, and
  waits (like for a repo claim) while the lane is full.
- **A fix is never held by a lane** (an `incident` Issue has its own place beyond `leads`; production is red).
- A lane is a cap, not an order: it never replaces `after`, and a row that needs what another shipped still says `after`.
- The lane is fixed when the Issue is filed. An adopted row (`issue`) has no `lane`.

## Check tiers

The mini is the bottleneck for parallel leads and most of its load is checks: every lead ran the whole `make check`
locally, then `merge-guard` demanded the same suite green in CI on the exact head. `checks:` in `project.yaml` splits the
gate:

```yaml
checks: { fast: make check-fast, full: make check, ci: true }
```

- **`fast`** (required): what a lead runs locally before each push and after each change it authors (format, lint,
  types, scans, the unit tests of what the branch changed). **`full`** (default `make check`): the complete gate.
  **`ci: true`**: CI runs `full` on the pull request head, so the lead relies on that run; hosted runners for a public
  repo, `runs-on: [self-hosted, vps]` for a private one (never the self-hosted runner for a public repo), sharded with a
  matrix where the suite allows. Both commands are `make <target>`: the brief quotes them as data.
- **The brief** (`domains/leads/brief.ts`) gets a `## Checks in this repo` section for such a project: run `fast`
  where the standing orders say `make check`; with `ci: true` leave the full gate to CI (`merge-guard` still demands
  its green run on the exact head); rerun one heavy suite locally only to reproduce a CI failure, inside a slot. A
  project without `checks:` gets no section and keeps one `make check`.
- **Slots.** The slot name is the step (`software-factory check-fast` beside `software-factory check`), so the ledger
  learns the fast tier's peak apart from the whole gate's.
- `factory project show` prints `checks` (`null` for none). Another project's `checks:` is its own repo's to adopt: the
  Makefile target and the CI workflow it names are that repo's.

## Adopting an Issue

A row with `issue: <n>` adopts an Issue you filed by hand (`factory issue new`). Nothing is filed for it; the
row is done when that Issue closes, so other rows can wait for it with `after`. An adopted row is `key` and `issue` and
nothing else: `after`, `after_days`, `not_before`, `stable_days`, `repo`, `kind`, `seat` and `lane` are refused on it. Put the order on the Issue
(`--after`), or on the rows that wait for it.

`factory planning unafter --issue <id> --after <id>` (`--after` repeats) removes stored `after` edges (set by `planning after`,
`issue new --after` or a settle) from an open Issue, the mirror of `planning after`. It refuses an edge the Issue does
not have (or one already satisfied), naming it, and then removes none of the set. Removing the last edge lets the next
planning pass start a queued Issue. The removal is recorded as a note on the Issue. A lead's own `deferred --after`
wait is its event, not an edge: it is not removed here, and a waiting Issue stays waiting until it ends.

## Changing an edge

Which command depends on whether the row has an Issue yet (`factory project show <name> --format plain` prints each row's
state):

| Row state | Change the edge by |
|-|-|
| `waiting` or `filable` (no Issue yet) | editing the row's `after` in `docs/plan.yaml`, `factory plan check`, push, `factory project sync --fetch true` |
| `open` (its Issue exists) | `factory planning after --issue <id> --after <id>` / `factory planning unafter --issue <id> --after <id>` on the Issue; editing the row's `after` changes nothing now |

The Issue's edges are not in `factory issue show`; `factory read chain --format plain` lists what blocks each Issue
(`blocking.issue_<n>`).

## Splitting a plan into rows

- One row is one change that ships alone: its own lead, review, deploy and verify. If two halves could not be reverted
  or deployed apart, they are one row.
- Rows that are independent carry no `after`. Add `after` only where the second row needs what the first one shipped,
  never to put independent rows in a line: the server runs them side by side when the repo's `leads` allow it. To keep
  heavy rows (Apple builds) from running together while cheap rows run alongside, give them a `lane` (see Lanes).
- Write the gate in the row: the row's `acceptance` states the check that proves it done (a command, a test, an
  observable fact), because the lead ships by stating each line met or not met.
- The `facts` carry everything the lead needs. It cannot see this plan or the session that wrote it: exact paths, scope
  limits and any research already verified go in.
- A row that asks the owner for a verdict on how something looks waits until enough is built to judge: place it `after`
  the last row that makes the thing whole.

## Checking a plan

Before pushing:

```
factory plan check docs/plan.yaml
```

reads the file offline (no server, no token) and prints every problem with its line and column
(`docs/plan.yaml:12:5: ...`), exit 2 when there is one; `-` reads stdin, `--format json` prints the problems as data. It
applies the same schema the server does, plus a warning for a lane the repo's `project.yaml` does not declare.
`factory plan schema` prints this page. After pushing, `factory project sync --fetch true` reads the remote now and
`factory project show <name> --format plain` prints one line per row (`factory issue list --repo <name> --state open
--format plain` lists the open Issues of the repo).

```
factory project show <name>
```

prints the project's `project.yaml` in force and every plan row with its state, its Issue and, for a waiting row, why:
`after a, b` lists every `after` row not yet done, in `after` order, and a name that is no row reads
`ghost (no such row)` (`after a, ghost (no such row)`). A
plan that does not parse shows `planError` with the file's message and its position in the plan (`rows.3.after.0: ...`), and keeps the last valid plan in force; fix the file
and the next read replaces it. `warnings` lists what is read but retired.

A project is a repo with its own `.git` directory directly under a repo root. A linked worktree (`.git` is a file) is
never one, and a stored project whose directory is gone, or is a worktree, is retired on the next sync (`retired` in the
answer): its row is removed and nothing is filed for it; the rows it filed stay recorded.

The server reads the default branch: a plan on a feature branch, or not yet pushed, is not seen. `factory project sync
--fetch true` reads the remote now instead of waiting for the next pass. A plan (or `project.yaml`) that does not parse
is listed under `broken` in the answer on every sync until it is fixed, and named on stderr (`broken: <project> <file>:
<message>`); an empty `broken` means every file parsed.

## Replan

A Replan is an Issue (`Replan: <project>`) whose lead rereads the plan against the open and recently closed Issues and
proposes changes as a Spec: new, changed or dropped rows, `after` edges to add or remove, Issues to cancel or re-file.
Every non-obvious choice is a Decision raised before the Spec is submitted. The owner files it with
`factory planning replan <project> [--ask "..."]`; the planning pass files one when a timed wait of
`FACTORY_LONG_WAIT_MS` or more has Issues behind it. One is open per project at a time; asking again while it is open
adds the words to it as a note. On a verdict of Looks good or With notes the lead edits `docs/plan.yaml` through the
project's ship path and applies edge changes and cancellations with `factory issue replan <id> --attempt <n> --body '<json>'`. The server gates
that verb: the Issue must be a Replan its lead works on (current attempt), its latest Spec revision must carry a Looks
good or With notes verdict, and every Issue it re-edges or cancels must be an Issue of the Replan's own project (a
blocker may be any open Issue). The whole call is refused otherwise, nothing applied; each op then answers for itself, and
a repeated `call` changes nothing more. The owner-only edge and cancel routes stay shut to a lead: the verb is what an
approved Spec buys. It acts as the orchestrator, so the owner-touch counts stay the owner's alone.

## What the server does not read

A prose plan file (a `PLAN.md` in any directory, in any repo) is not read by the server and files nothing. Only
`docs/plan.yaml` is a plan. Work described only in prose is not queued: put it in rows, or file the Issue
(`factory issue new`) and adopt it.
