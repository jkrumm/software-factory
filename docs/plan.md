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
    after_needs: shipped
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

`version` is `1`. `rows` has at least one row. Unknown keys anywhere are refused: the file is strict. A file over 1 MiB, or with more than 100 YAML aliases, is
a broken plan.

## A row

| Key | Meaning |
|-|-|
| `key` | The row's name, unique in the file: lowercase letters, digits and dashes (`docs-sweep`). Other rows name it in `after` |
| `title` | The filed Issue's title, up to 200 characters. Required unless the row adopts an Issue |
| `facts` | What the filed Issue's lead reads, an object of the same shape as `factory issue schema` prints: `why`, `what`, `change`, `acceptance`, and any other key you add. Required unless the row adopts an Issue |
| `kind` | `feature` (the default), `bug`, `chore`, `docs` or `incident` |
| `seat` | The tier and effort the Issue's lead starts on. Default: no seat (the light rule, else the role table's `lead` row); in doubt `{role: lead, moveUp: true}`; opus only with a `why`. See Choosing the seat |
| `lane` | A resource inside the repo (`apple`): lowercase letters, digits, dashes. The target project's `project.yaml` `lanes:` caps how many leads of a lane run at once. See `docs/project.md` "Lanes" |
| `prio` | The queue priority its Issue is filed with, an integer from -1000 to 1000 (default 0): higher runs first among the queued Issues, then the lower Issue number. It is `factory issue prio` applied at filing (recorded once, actor `plan`), so rows that become filable together run by `prio`, then file order; a later `factory issue prio` on the Issue overrides it. Not allowed on an adopted row (`issue`) |
| `checkpoint` | `spec`: the row's lead writes its plan first, as a Spec (a new public surface, a data model or a migration of meaning, a dependency of weight, an architecture or look-and-feel choice later Issues build on), and nobody waits: the lead submits it and builds at once, and its ship is refused until a Spec is submitted. What in it is the owner's, the lead raises beside it as a Decision; settle what you can in the row's facts instead. `gate`: an owner gate, the one way a filer makes the owner read: the same Spec is owed, and only the owner's own verdict ends the wait (no default after 24 hours, no settle by rule), so rows `after` it wait for him |
| `repo` | The project the Issue is filed in; default: the project whose plan this is. A row may target another repo |
| `after` | Rows that must be done first, in this file (`export-paging`) or another project's plan (`other-project:schema-change`). At most 20 per row (the most `issue new --after` accepts); a plan with more is broken. Drop edges already implied through other rows (a transitive reduction): if `c` waits for `b` and `b` for `a`, `c` needs no `after: [a]` |
| `after_needs` | `closed` (the default: an `after` row releases the row when its Issue closes in any outcome) or `shipped`: every `after` row must have closed `done` or `healed`. An `after` row that closed `dropped` or `cancelled` then **holds** the row: it stays `waiting` with the reason `held: <row> (<Issue> closed <outcome>); …` and the planning pass files a Replan for the project (see Replan). Needs `after`; one value for all the row's `after` rows. For a chain whose next row needs what the previous one shipped |
| `not_before` | A date (`2026-12-01`, midnight UTC) or a datetime (`2026-12-01T09:00:00Z`; with no offset it is UTC). The row is not filed before then |
| `after_days` | Whole days, 1 to 365; needs `after`. The row also waits until that many days after the **latest close** among its `after` rows (any outcome, like `after`), so "delete v1 a week after the cutover" needs no date written in advance. The wait reason names the close and the end of the window; it combines with `not_before` (both must be past) |
| `issue` | Adopts an Issue you filed by hand: its number (`149`). See below |
| `stable_days` | Retired. Read so an old file parses, flagged as a warning, never evaluated. Do not write it |

## When a row is filed

A row is in one of four states, derived on every read and never stored:

| State | Meaning |
|-|-|
| `waiting` | An `after` row is not done (or, with `after_needs: shipped`, closed without shipping: the reason starts `held:`), its `after_days` window has not run out, its `not_before` has not come, its `repo` is not a project the factory knows, or it is in a cycle. The reason says which |
| `filable` | No Issue yet, every `after` row done, its `after_days` window run out, its time come. The next planning pass files it |
| `open` | It has an Issue that is not closed |
| `done` | Its Issue is closed, whatever the outcome. A row whose Issue was dropped or cancelled still releases the rows that wait for it, unless such a row says `after_needs: shipped` |

The planning loop runs on its own; `factory planning pass` runs one now. The Issue is filed with the row's `title`,
`facts`, `kind` and `repo`, and the lead sees `Plan row <key>.` before the facts. A row is filed once: its Issue is
remembered by project and key.

## Pruning

The file holds open rows only. Once a row is `done`, delete it: the filed Issue is remembered in the server's
`planning_filed_rows` by project and key, and a row that is not in the file is no row, so removing it files nothing and
cancels nothing (a key written again later is the same filed row, done, not a new Issue). The one exception is a done row
that an open or waiting row still names in `after`: a ref to a key that is not in the file is `(no such row)` and waits
for good, so keep that row as a stub (`key` and `issue: <its Issue>`, which adopts the Issue it was filed as) until
the row that waits for it is done too.

## Choosing the seat

A row with no `seat` starts on the seat the light rule (`apps/server/src/domains/leads/light.ts`) names, else on the `lead` row
of `config/roles.json` (sonnet, high). The rule names the `light` row (haiku, high) for a hygiene finding, kind `docs`, an
unrouted monitor alert, or triage's size `small` with no `checkpoint` and none of the words that keep it off (migration,
security, a public surface), while the light gate is met (NL38, NL45). A plan row is sized like any other Issue: its `after`
edges are stated and final, and triage is asked for its size and kind only (NL51), so a mechanical row reaches the light seat
by the same rule. A row whose Issue moved up from the light seat never starts light again. `factory issue show` reports the seat
before a lead starts (`leadSeat`, `planned: true`, with the rule's name, or `sizeKnown: false` while triage has not sized it).

Three choices, in this order. Most rows need none.

1. **No `seat`** (the default). The light rule or the `lead` row runs the row, and the lead's own judgment moves it up from the light row. File this unless you know better.
2. **`seat: {role: lead, moveUp: true}`** when you doubt the lead row is enough. The row starts on the `lead` row; if its lead struggles by one of four signs (a second stall, a second refused ship, a regression of its first watch, or `issue block --out-of-depth`) a new lead takes over on the `strong` row (opus, high). The leaving lead writes a handover (what the Issue needs, what it tried, what failed and why, the state of its branch, what it would do next): an out-of-depth block's `--reason` is it; for the other signs the factory asks the lead once, and a lead that is gone or does not answer leaves its last words. The step is taken once. The same keys on `{role: light, moveUp: true}` give the light step (to the `lead` row, with the lead's last words, no second step).
3. **`seat: {tier: opus, effort: high, why: "<one sentence>"}`** when the work needs the strongest lead from the first minute: novel hard logic, a design that must hold. `why` is one sentence of at most 300 characters; `factory issue new` and `factory issue seat` refuse a tier above the lead row's without it (422, `seat.why`, naming choice 2). A plan row is not refused (a refused row would hold its whole plan at the last valid version): `factory plan check` warns, naming the row, and the row files. The answer of `issue new` and `issue seat` carries `seatCost`, one line with what Issues on that tier cost per Issue and in median working minutes over the last 7 days, beside the lead row's; `factory issue show` prints the `why`.

A filed seat otherwise always wins and is never moved up. Two forms, never mixed: `{tier, effort}` (tier `haiku|sonnet|opus`, effort
`low|medium|high|xhigh|max`; never a model id) or `{role}`, a row of the role table; `moveUp` and `why` are the keys either may add.
A role is looked up when the Issue is filed and the result is kept, so a later table change does not move a filed Issue. A tier
or effort outside the lists fails the plan's parse and the last valid plan stays; a role the table lacks at filing time files
nothing, and the planning pass reports `<project>:<row>: seat.role: ...` until it is fixed. `factory issue new --seat '{"role":"lead","moveUp":true}'`
sets the same on a hand-filed Issue (422 naming the field when refused). `factory issue show` reports the asked-for `seat`
(null for the default, with its `why` and `moveUp`) and `ranOn`, the tier and effort the latest lead started on.

## Lanes and check tiers

A row's `lane` names a resource that its project caps, and `checks:` and `budgets:` split and bound the gate. Both are
`project.yaml` keys: `docs/project.md` "Lanes" and "Check tiers".

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
  heavy rows (Apple builds) from running together while cheap rows run alongside, give them a `lane` (`docs/project.md` "Lanes").
- Write the gate in the row: the row's `acceptance` states the check that proves it done (a command, a test, an
  observable fact), because the lead ships by stating each line met or not met. A lead cannot file an Issue (`POST /issues`
  is the owner's, so `factory issue new` is 403 for a lead's token): an acceptance line never asks the lead to file one. A
  proof that needs a filed Issue names who files it, an Errand for the owner's hands or a row of its own, or states a check
  the lead can run (a scenario test, a read of the deployed read model).
- A lead splits its own work into ordered follow-ups here, not by signal: a signal carries no `after`. It commits rows to
  its repo's plan (a row's `repo` may target another project) and lands them with its change; the server files them. To
  order them after an existing Issue, adopt it as a stub row (`key` and `issue`) and name that key in `after`.
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

```
factory project plan <name> [--format plain]
```

is the same rows for a lead: every caller of the read class (a lead's token too) may call it, where `project show` is the
owner's. A row carries its `state` (`open`: its Issue exists and is not closed; `done`: it closed, whatever the outcome;
`filable`; `waiting` with its `reason`), its `title`, `kind`, `after` keys and `what` (`facts.what`), so a lead can tell whether
an open row owns a gap without reading the plan from git. The read token gets a 404 for a work project and `private` for a
row target that is one.

A project is a repo with its own `.git` directory directly under a repo root. A linked worktree (`.git` is a file) is
never one, and a stored project whose directory is gone, or is a worktree, is retired on the next sync (`retired` in the
answer): its row is removed and nothing is filed for it; the rows it filed stay recorded.

The server reads the default branch: a plan on a feature branch, or not yet pushed, is not seen. `factory project sync
--fetch true` reads the remote now instead of waiting for the next pass. A plan (or `project.yaml`) that does not parse
is listed under `broken` in the answer on every sync until it is fixed, and named on stderr (`broken: <project> <file>:
<message>`); an empty `broken` means every file parsed.

## Rebasing and replans

Rebasing a plan file with the `plan` merge driver: `docs/operations.md` "Rebasing a plan file". A Replan, the lead's
proposal of changes to the plan: `docs/architecture.md` "Replan".

## What the server does not read

A prose plan file (a `PLAN.md` in any directory, in any repo) is not read by the server and files nothing. Only
`docs/plan.yaml` is a plan. Work described only in prose is not queued: put it in rows, or file the Issue
(`factory issue new`) and adopt it.
