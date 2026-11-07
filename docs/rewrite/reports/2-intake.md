# Package 2: Intake, report

**Done: every input is one signal envelope and goes through `intake.receive`, which answers filed, amended, incident,
held or dropped; every source of the running core is ported onto it, the door posts signals over loopback, and a work
repo hears the owner only.** Branch `rw/2-intake`, on `fc5a8ac`, ten commits before this report. `make check` is green.

## What changed

- **`packages/contract/src/intake.ts`**: `Signal` (the architecture's object, plus `madeBy`), `SignalAck`
  (`outcome` and a `detail` word), `SignalRequest` (`POST /signals`, the owner's, an agent's, an app's entry),
  `AlertRequest` (the door's, strict: no `repo` key can exist), `StoredSignal`, `SignalList`, `PromoteRequest`, the
  door's `DoorRoute*` and `DoorReport`, and `cleanText` / `storable` ported from the old contract. No transforms in a
  request schema (they have no JSON Schema); the use case cleans.
- **`apps/server/migrations/0200_intake.sql`**: `intake_signals` (held and filed, a source's event key unique),
  `intake_subjects` (an episode per `(Issue, source, subject)`, or a fingerprint), `intake_incidents`, `intake_seen`,
  `intake_pending` (a `down` waiting out its grace), `intake_writebacks`, `intake_door_routes`,
  `intake_door_unrouted`, `intake_door_sources`. No foreign key into `factory.issues`: an Issue is named by its id.
- **`domains/intake/`** (pure): `model.ts`, `rules.ts` (origin and kind of a source, the gate that keeps a work repo
  and an unlisted source out, title overlap and `matchOpen`, fingerprint, `groupOf` for correlation), `ports.ts`,
  `health.ts` (the door's health lines), and `beszel-rules.ts` / `infra.ts` ported as they were.
- **`app/intake.ts`**: `createIntake` with `receive`, `file`, `alert` (the door), `promote`, `list`, `doorReport`,
  `routes` / `setRoute` / `removeRoute`, `settle` (the heal pass and the unrouted monitors), `healthLines`, and the
  `sink` the pollers use.
- **`adapters/intake/`**: `store.ts` (Postgres), `github.ts` (label, author, held strangers, red checks, write-back),
  `beszel.ts`, `launchd.ts`, `runbook.ts` (`make restart`, probed first), `projects.ts`, `topology.ts`, `triage.ts`,
  `settings.ts`, `schedule.ts`, `process.ts`. `read/open-issues.ts` is the cross-domain read for amend-or-new.
- **`api/intake.ts`**, one `.use()` in `api/app.ts` (optional: absent, every route answers 503, so the OpenAPI document
  needs no database). Operations: `signal.file`, `signal.alert`, `signal.list`, `signal.promote`, `door.routes`,
  `door.route-set`, `door.route-remove`, `door.report`. `factory signal file --body '{...}'` is the owner's, Hermes' and
  agents' entry. `apps/cli/src/generated/operations.ts` is regenerated.
- **`apps/door/`** (`git mv` from `legacy/door`): the same Bun server, one route `POST /alert/<source>`, now posting an
  `AlertRequest` to `${FACTORY_URL}/signals/alerts` and `DoorReport` to `/door/reports` over loopback. No token, no
  database credential, no `repo`. `legacy/door` is gone (the rename is in the first commit).
- **`compose-intake.ts`** composes the ports (so `main.ts` gains five lines) and `main.ts` adds the intake store to the
  unit of work, starts the pollers and the settle pass on `selfPaced` schedules and stops them on shutdown.
- **`scripts/boundaries.ts`**: one rule (two messages, three fixture pairs): an intake source file
  (`adapters/intake/{github,beszel,launchd}.ts`) reaches the server only through the sink: no `app/`, `read/`, store,
  other domain or `bun` import.
- **`adapters/postgres/locks.ts`**: one line, `intake: 7_093_200`, the namespace of intake's per-name advisory locks.
- **Tests**: units for the rules, the receive use case on a private Postgres (31, incl. concurrent alerts), the pollers
  (61), the door (68), adapters; scenarios in `tests/scenarios/intake/` (`vps-outage`, `signals`, `heal`, `pollers`)
  against the real server, door and CLI with fakes of the Beszel hub, GitHub, and `launchctl`.

## `make check`

```
==> install (bun install --frozen-lockfile)
Checked 45 installs across 101 packages (no changes) [7.00ms]
==> format (oxfmt --check)
All matched files use the correct format.
Finished in 18ms on 136 files using 12 threads.
==> lint (oxlint --type-aware)
==> shellcheck
==> typecheck (tsc --noEmit)
==> boundaries (scripts/boundaries.ts)
boundaries hold
==> retired words (scripts/retired-words.ts)
no retired words
==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)
==> generated CLI is current (apps/cli/scripts/generate.ts --check)
==> unit tests (bun test apps packages scripts)
 347 pass
 0 fail
 3787 expect() calls
Ran 347 tests across 26 files. [6.23s]
==> scenarios (bun test tests)
 22 pass
 0 fail
 104 expect() calls
Ran 22 tests across 6 files. [27.13s]
==> check passed
```

## Acceptance

- **A VPS outage's three alerts make one incident Issue** (`vps-outage.test.ts`): Beszel from a polled fake hub files
  `issue_1`; HyperDX and Kuma through the real door process answer `incident / joined` on the same Issue; its version
  after the three is 3 (`filed` and two `noted`); the `up`s of Kuma and HyperDX are `amended`, the hub recovering closes
  it as `healed` through the machine. Every stored signal points at the one Issue. Concurrent alerts are a unit test.
- **An owner signal that matches an open Issue amends it** (`signals.test.ts`, through `factory signal file`): one
  `noted`, version 2, no second Issue.
- **A replayed signal is one effect** (door alert twice, version unchanged; unit tests for every key), **an outside
  GitHub issue is held until promoted** (`pollers`: held with trust `outside`; `signals`: `signal promote`),
  **a heal runbook that fixes the symptom files nothing** (`heal`: the runbook's file appears, the `up` comes, nothing
  is filed), **a work repo drops an automatic signal** (`signals`, with the reason; the GitHub fake sees no request for
  the work repo), **the door refuses a payload's repo** (`signals`: the server answers 422 to a body with `repo`; a Kuma
  payload carrying `repo` files in the route's repo).
- The pollers run against fakes of GitHub, Beszel and `launchctl`; no network anywhere.

## The ports I declared and the stub `main.ts` uses

| Port | In | `main.ts` gets |
|-|-|-|
| `ProjectSignals` (which repos are projects, work or not, what each hears, its heal rules) | `domains/intake/ports.ts` | `stubProjectSignals` (no project: every automatic signal is dropped `no_project`), unless `FACTORY_INTAKE_PROJECTS_FILE` names a JSON file, then `fileProjectSignals`. **The real one reads `project.yaml`: the orchestrator wires it.** A repo is its directory name under `FACTORY_SOURCE_ROOT` |
| `IntakeTopology` (which host a repo's alerts sit on) | same | `infraTopology(config/infra.json)`: real, from the file; a project's own host in `project.yaml` would add to it |
| `OpenIssues` (open Issues of a repo, to match a request against) | same | `postgresOpenIssues` in `read/`: real |
| `TriageWorkflow` (agw: amend or new when unsure) | same | `stubTriageWorkflow`: "unreachable", read as: file anew. **Package 7 brings `factory-triage`** |
| `Runbook` (`make restart`) | same | `makeRestartRunbook`: real |
| `IntakeSink` (what a poller may call: `receive`, `subjects`, `pendingWritebacks`, `wroteBack`) | same | `intake.sink` |

Settings (all optional, none on `scripts/env-file.sh`'s allow-list, which package 9 owns): `FACTORY_SOURCE_ROOT`,
`FACTORY_INTAKE_PROJECTS_FILE`, `FACTORY_INFRA_FILE`, `FACTORY_HOME_REPO`, `FACTORY_INCIDENT_WINDOW_MIN` (30),
`FACTORY_FINGERPRINT_WINDOW_MIN` (1440), `FACTORY_GITHUB_TOKEN` / `_API_URL` / `_POLL` (5m), `FACTORY_BESZEL_URL` /
`_EMAIL` / `_PASSWORD` / `_POLL` (1m), `FACTORY_LAUNCHD_POLL` (5m), `FACTORY_SETTLE_POLL` (10s). A poll of `off`
switches a source off; a source without its secrets is off with one log line.

## The events I record on Issues, and from which use case

| Event | Actor | From | When |
|-|-|-|-|
| `filed` | factory (owner for a promote or an owner signal) | `receive` (`fileNew`), `promote`, the settle pass | a new Issue; the key is `filed:signal:…`, deterministic from the source's event, the subject, or the signal id |
| `noted` | factory (owner for an owner signal) | `receive`: a `down` on an open episode, a join into an incident, an `up` that closes nothing, a repeated or matched request | the lead hears it as a note; the key names the event or the words and the Issue |
| `regressed` | factory | `receive`, a `down` while the Issue is `watching` | `watch` is the Issue's own watch |
| `closed` (`healed`, no attempt) | factory | `receive`, the last `up` of an Issue no lead has started | the machine refuses it once a lead works, then a `noted` is recorded instead |

`settled` and admission are not mine (package 3): intake files, planning settles.

## Review outcome

`/review` deep, scope `fc5a8ac..HEAD`, job `rv_rfxhpjsghxhhf7cuil7o`, thread `rw-2-intake`, round 1. The first job (on
the base's thread) was abandoned by a parallel worker's prepare, and the second submission was refused for a file list
that skipped the renames, tests and `bun.lock`; the reviewer answered again with the full list. Outcome **actionable, 2
important, 2 nits**; no round 2, as the brief asks.

| Finding | Disposition |
|-|-|
| Incident correlation read and inserted per host while receive locked per subject: two alerts of one outage at once opened two incidents, and two concurrent `up`s could both miss each other | Fixed: both take a `group:<host>` advisory lock after the subject lock (the same order in the settle pass). Two unit tests fire the alerts and the ups at once, and fail without the lock (tried) |
| The note for a repeated request had no Issue id in its key, so a repeat after the first Issue closed hit `key_taken` (a 409) | Fixed: the Issue id is in the key; a test covers it |
| Intake kept its advisory namespace outside `locks.ts` | Fixed (before the review's result): `LOCKS.intake` |
| The loop-guard marker has no writer in this repo | Intentional: the marker `<!-- factory-loop:<name> -->` is this package's envelope contract; the loops that write it come with package 7, and carrying `madeBy` for checks from a branch marker needs them |

The reviewer's first round also found, and I fixed in `fix(intake): register the lock namespace…`, a note key that
ignored the request's text (the same title with new text recorded no note while the ack said `amended`), the lock-order
inversion between `receive` and the settle claim (`FOR UPDATE` row, then advisory lock: a deadlock window), and the
door's hint to a command that does not exist (`factory door token new`).

## Open points

1. **The envelope gained `madeBy`** (the loop guard, "mark it in the envelope"). The architecture's `Signal` object is
   otherwise exact. The source's detail (`subject`, `event`, `status`, `facts`) rides beside it in `Received`, and the
   facts are stored with the signal in `intake_signals`, linked by `issue_id`. **The `filed` event carries only repo,
   title, kind and origin, so package 4's brief must read an Issue's signals from `intake_signals`** (a `read/` query).
2. **New words**, for `docs/language.md`: the triage `detail` words (`new`, `matched`, `replayed`, `repeat`, `joined`,
   `regression`, `settling`, `healed`, `quiet`, `unrouted`, `quarantined`, `promoted`, plus the drops `work_repo`,
   `no_project`, `not_listened`, `loop_guard`, `no_repo`); **promote** (a held signal becomes work); **door route**
   (the registry that says which repo a monitor files in); **settling** is also the word of a `down` waiting out its
   grace (`outcome: held, detail: settling`), which is not the quarantine's "held": I used `held` for both because the
   five outcomes are the brief's. The old "hold" is gone from the code; the grace of a heal rule is `graceMs`.
3. **Kind of an Issue**, my default: a monitoring alert (`kuma`, `hyperdx`, `beszel`) files an `incident`, a failing
   check or job a `bug`, a request or feedback a `feature`, a remark a `chore`. Triage (package 7) refines.
4. **Behaviour that differs from the running core**: strangers' unlabelled GitHub issues are now read and held (the old
   core never requested them); the owner's own issues from before `since` are neither filed nor held; the unrouted
   monitor's home is the repo of a route of the same source for `<name> - Push|Door`, else `FACTORY_HOME_REPO` (the
   old rule that also named a project after the monitor is not ported); an outcome is HTTP 200 whatever it is (the old
   201/202), the door passes only 200; an up before any lead closes **every** stateful episode as `healed`, not only an
   incident; the door's `facts` over 24 KiB are cut by the door as before.
5. **No auth yet.** `POST /signals` takes its trust from the `from` the caller claims (`owner*`, `agent:<repo>`,
   `feedback:<app>`); package 8's token should decide it. `POST /signals/alerts`, `/door/*` bind loopback with no check.
6. **Shared files I changed**: `apps/cli/test/generate.test.ts` and `tests/scenarios/boot.test.ts` pinned the exact
   operation list and migration list and would fail for every parallel package (now `toContain` /
   `arrayContaining`); `main.ts` (five lines); `api/app.ts` (one `.use()` and an optional `intake`); `locks.ts` (one
   line); `bun.lock` (the `apps/door` workspace, no external package). **No new dependency.**
7. **Not wired, and where it belongs**: `healthLines` (door sources refused or silent, an unrouted monitor down) is a
   use case and a test, but `/health` has no place for it yet; the CLI verb for `newToken` (`factory door token new`)
   is package 8's and the door's error text now says to write the file; `scripts/launch-door.sh` and the deploy script
   still name `packages/door` (package 9); the new settings join `scripts/env-file.sh` there too.
8. **Doc contradictions for the orchestrator**: `AGENTS.md` and `docs/design.md` §11 describe the door posting to a
   unix socket (`POST /intake`) with `door_routes` in the old schema; both change in package 9. The contract comment
   for `DoorReport` is right (`/door/reports`).
9. **Not a choice I could make alone**: a repo is its directory name under `FACTORY_SOURCE_ROOT` everywhere in intake
   (the old core used the absolute path). If packages 3 to 6 name a repo otherwise, `RepoSignals.repo` and
   `Issue.repo` must agree at integration.
10. **Commit hygiene**: the `git mv legacy/door apps/door` landed in the first commit (contract and migration) because
    it was staged when that commit was made; it is a pure rename.
