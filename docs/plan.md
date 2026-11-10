# The plan file

A project's `docs/plan.yaml` is its plan: the work not yet filed, as rows. The server reads it from the repo's default
branch, files each row as an Issue when the row may start, and tracks the row until that Issue closes. This page is the
one description of the format. The schema is `PlanFile` in `apps/server/src/domains/planning/plan.ts`; the example below
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
      why: The export button times out on large accounts, so support exports them by hand.
      what: src/export/stream.ts and its test; nothing in the UI.
      change: Write the export in pages of 500 rows in src/export/stream.ts instead of one query.
      acceptance: Exporting a 100k-row fixture in test/export.test.ts finishes in under 5 s and make check passes.
  - key: export-docs
    kind: docs
    title: Document the paged export
    after: [export-paging, intake]
    not_before: 2026-12-01
    facts:
      why: Support still describes the one-query export.
      what: docs/export.md only.
      change: Describe the paged export and its 500-row page.
      acceptance: docs/export.md names the page size and make check passes.
  - key: console-seed
    repo: software-factory
    after: [other-project:schema-change]
    title: Seed the Console fixtures
    facts:
      why: The Console needs the new schema in its fixtures.
      what: apps/console/fixtures only.
      change: Regenerate the fixtures from the new schema.
      acceptance: The Console tests pass on the regenerated fixtures.
```

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
| `repo` | The project the Issue is filed in; default: the project whose plan this is. A row may target another repo |
| `after` | Rows that must be done first, in this file (`export-paging`) or another project's plan (`other-project:schema-change`) |
| `not_before` | A date (`2026-12-01`, midnight UTC) or a datetime (`2026-12-01T09:00:00Z`; with no offset it is UTC). The row is not filed before then |
| `issue` | Adopts an Issue you filed by hand: its number (`149`). See below |
| `stable_days` | Retired. Read so an old file parses, flagged as a warning, never evaluated. Do not write it |

## When a row is filed

A row is in one of four states, derived on every read and never stored:

| State | Meaning |
|-|-|
| `waiting` | An `after` row is not done, its `not_before` has not come, its `repo` is not a project the factory knows, or it is in a cycle. The reason says which |
| `filable` | No Issue yet, every `after` row done, its time come. The next planning pass files it |
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

## Adopting an Issue

A row with `issue: <n>` adopts an Issue you filed by hand (`factory issue new`, `rd issue`). Nothing is filed for it; the
row is done when that Issue closes, so other rows can wait for it with `after`. An adopted row is `key` and `issue` and
nothing else: `after`, `not_before`, `stable_days`, `repo`, `kind` and `seat` are refused on it. Put the order on the Issue
(`--after`), or on the rows that wait for it.

`factory planning unafter --issue <id> --after <id>` (`--after` repeats) removes stored `after` edges (set by `planning after`,
`issue new --after` or a settle) from an open Issue, the mirror of `planning after`. It refuses an edge the Issue does
not have (or one already satisfied), naming it, and then removes none of the set. Removing the last edge lets the next
planning pass start a queued Issue. The removal is recorded as a note on the Issue. A lead's own `deferred --after`
wait is its event, not an edge: it is not removed here, and a waiting Issue stays waiting until it ends.

## Splitting a plan into rows

- One row is one change that ships alone: its own lead, review, deploy and verify. If two halves could not be reverted
  or deployed apart, they are one row.
- Rows that are independent carry no `after`. Add `after` only where the second row needs what the first one shipped,
  never to put independent rows in a line: the server runs them side by side when the repo's `leads` allow it.
- Write the gate in the row: the row's `acceptance` states the check that proves it done (a command, a test, an
  observable fact), because the lead ships by stating each line met or not met.
- The `facts` carry everything the lead needs. It cannot see this plan or the session that wrote it: exact paths, scope
  limits and any research already verified go in.
- A row that asks the owner for a verdict on how something looks waits until enough is built to judge: place it `after`
  the last row that makes the thing whole.

## Checking a plan

```
factory project show <name>
```

prints the project's `project.yaml` in force and every plan row with its state, its Issue and, for a waiting row, why. A
plan that does not parse shows `planError` with the file's message and keeps the last valid plan in force; fix the file
and the next read replaces it. `warnings` lists what is read but retired.

The server reads the default branch: a plan on a feature branch, or not yet pushed, is not seen. `factory project sync
--fetch true` reads the remote now instead of waiting for the next pass.

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
