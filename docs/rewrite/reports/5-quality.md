# Package 5: Quality, report

**Done: a ship is checked against git and recorded as evidence, the watch runs verify off the tick and records `watch_passed` or `regressed`, a regression goes back to the lead twice and the third is a stall, and the owner reopens within 30 days.** Branch `rw/5-quality`, commits on `fc5a8ac` (the brief's base): four for the package, three review fixes, the report, and the integration step (two merges of `rewrite` and the wiring). `make check` is green after the second merge of `rewrite`.

## What changed

- **`apps/server/src/domains/quality/`**, pure:
  - `evidence.ts`: `CommitRead` (where the commits landed, their paths, the ranges to review), `CommitsEvidence`, `ReviewEvidence` (`status` is `covered`, `not_required`, `uncovered` or `unknown`, with the reason), `reviewOf`, `isInert`/`deploys` (docs, text, licences and tests deploy nothing; mirrors `scripts/verify.sh`).
  - `gate.ts`: `judgeShip`. No commit named, or commits git refuses or cannot read, refuse with the verb's error named. A review never refuses: its absence is evidence with a reason (NL23).
  - `watch.ts`: `Check`, `outcomeOf`, `nextCheckAt`, `stepOf`. The first check is at the end of the window; a red retries after 1, 2 and 4 retry delays and the red after the last regresses; a blocked checkout looks again later and counts as no red. All derived from the checks already made.
  - `ports.ts`: `Commits`, `Review`, `Proof`, `Projects`, `LeadCheckout`. `store.ts`: `QualityStore`.
- **`apps/server/src/app/`**: `quality-ship.ts` (`shipIssue`), `quality-watch.ts` (`startWatchPort`, `checkWatches`), `quality-reopen.ts` (`reopenIssue`, `reportRegression`), `quality-read.ts` (`showQuality`).
- **`apps/server/src/adapters/quality/`**: `git.ts` (`GitCommits`, `syncCheckout`, `deployedHolds`, ported from the old `commits.ts` and `origin.ts`), `proof.ts` (`MakeAndProbes`: `make version`, `make verify`, probes), `review.ts` (`AgwReview`: `agw review route|covered`), `projects.ts` (`makefileProjects`), `process.ts` (process runner with timeout, process group and abort), `store.ts` (Postgres), `stubs.ts` (`stubLeadCheckout`).
- **`apps/server/migrations/0500_quality.sql`**: `quality_ships` (every ship the gate looked at, refused ones too), `quality_evidence` (`commits`, `review`), `quality_watches` (one per ship; `answer` is `passed`, `regressed` or `ended`), `quality_checks` (every run of verify).
- **`apps/server/src/api/quality.ts`**, **`packages/contract/src/quality.ts`**: `POST /issues/:id/ship` (`quality.ship`), `POST /issues/:id/reopen` (`quality.reopen`), `GET /issues/:id/quality` (`quality.show`). A refusal is a 409 with the error named, exit 5 in the CLI; the CLI prints the refusal body on stdout. `apps/cli/src/generated/operations.ts` is regenerated.
- **Shared files** (additive): `main.ts` (the quality store, the use cases, a tick), `api/app.ts` (one `.use()` and an optional `quality` dep), `settings.ts` (below), `packages/contract/src/index.ts`, `tests/scenarios/fakes/agw.ts` (a three-line dispatch to the new `fakes/review.ts`), `tests/package.json` (the `git-repo` export for `tests/support/git-repo.ts`).
- **Edits to other packages' tests**, each one line: `settings.test.ts` (`toEqual` to `toMatchObject`, since every package adds a setting), `boot.test.ts` (`arrayContaining`, since every package adds a migration), `apps/cli/test/generate.test.ts` (`toContain('health get')`, since every package adds a command).

## The integration step (after the orchestrator's merge of packages 4 and 6, then 2)

`rewrite` is merged into the branch twice (conflicts in `main.ts`, `api/app.ts`, `contract/src/index.ts`, `fakes/agw.ts`, `boot.test.ts` and the generated CLI, each a union; the CLI regenerated). Quality now runs on package 4's wiring:

- **One outbox runner.** `composeLeads` takes quality's `startWatch` port as an input (`compose-leads.ts`: the input, the use in `ports`, and the removed refusing `stubStartWatch`; nothing else). My own outbox loop and `stubStartLead`, `stubNoteLead` and `stubFinalize` are gone from `main.ts`.
- **One setting.** The watch loop runs on the leads' `FACTORY_TICK_MS` (10 s default, 0 off); my duplicate is out of `settings.ts`. It stays its own loop, one pass at a time, so a `make verify` of minutes never holds the leads' tick.
- **A real lead checkout.** `stubLeadCheckout` is deleted. `app/quality-checkout.ts` (`leadCheckoutOf`) reads the lead attempt row through the leads store: the branch, the cut (`base_sha`) and the repo directory. `LeadCheckout` now answers `{ repo, branch, cut }`, and `checkoutOf` (`app/quality-ship.ts`) gives git, agw, the project reads and `make` that directory. **An Issue's `repo` is a name inside the allowed roots now, not a path**, so the directory has to come from the lead's attempt (`repo_path`); with no attempt on record the Issue's own repo is used as a path, as before.
- **The "older than this attempt" gate now runs in production**, and a branch's own unmerged work counts (open point 9 below is closed). A scenario ships a commit from before the lead started and is refused.
- Scenarios now run on package 4's leads world (`startLeadsWorld`): the lead is started by the real tick against the fake `hc`, so the attempt row is real. They share one repo per describe (new file per scenario), and `stateOf` asks again on a version conflict because the tick writes to the same Issue.
- Added `test/quality/checkout.test.ts` (the adapter on the real leads store) and a `quality-write` test that git, agw, the project and `make` run in the lead's directory.
- Intake (package 2) records `regressed` itself (`receive`, a `down` while the Issue is `watching`, `watch` its own). `reportRegression` therefore has no caller yet; see open point 1. A watch whose Issue regressed that way is ended by the next pass.

## How the pieces run

1. `ship` (the lead's verb, outside any transaction): the Issue and whether this call was accepted already are read in one transaction. A repeat of an accepted call gets the first answer without asking git. Otherwise `LeadCheckout`, `Commits` and `Review` are called with no transaction open, `judgeShip` decides, and one transaction records the ship, then `shipped` through `recordIn` (which plans `start_watch`), then the evidence. The machine's own refusal (a closed Issue, another attempt) is stored as a refused ship with the machine's detail.
2. The outbox runs `start_watch`: `startWatchPort` reads the project's window and opens the watch. It keeps nothing in memory.
3. `checkWatches` (each tick): the open watches whose window is over, or whose retry or recheck is due, are claimed (a lease column, committed), verify runs with no transaction open, and one transaction records the check and the Issue's event: `watch_passed` on green, `regressed` after the last retry. Keys are `watch_passed:<issue>:<watch>` and `regressed:<issue>:<watch>`, so a crash anywhere replays to one answer.
4. `reportRegression` (intake calls it with its own signal key): a watched Issue records `regressed` (watch `null`); a closed one is reopened by the factory (`reopened`), because the machine ignores `regressed` there. The same signal again finds its first answer, whatever became of the Issue since.
5. `reopenIssue`: the owner's verb. The machine enforces the 30 days.

## `make check`

```
==> format (oxfmt --check)
All matched files use the correct format.
Finished in 25ms on 112 files using 12 threads.
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
 624 pass
 0 fail
 4595 expect() calls
Ran 624 tests across 42 files. [29.56s]
==> scenarios (bun test tests)
 62 pass
 0 fail
 336 expect() calls
Ran 62 tests across 16 files. [72.42s]
==> check passed
```

## Acceptance

Scenarios (`tests/scenarios/quality/`), real server process and Postgres, the generated CLI, fake agw, and real git and `make` in a temp repo with a bare origin:

- **Ship with evidence:** the commits (landed sha, paths, `deploys`) and the review `covered`; the same ship again is a replay and asks neither git nor agw.
- **Refused without merged commits:** an empty list, a local commit not on origin and an unknown sha are each exit 5 with the error named; the call id is not spent, and the same call then ships.
- **Accepted without a review:** an unscripted agw gives a review of status `unknown` with the reason; an `uncovered` range ships with that status.
- **Watch:** the Issue is still `watching` with no check before the window is over; then verify (`deployed version`, `make verify`) is green and the Issue closes `done`. A docs-only ship skips the version check.
- **Regression:** a red verify retries (four checks), goes back to the lead twice, and the third regression is `waiting:regressed`, which refuses a lead verb. A red that clears on a retry never reaches the lead.
- **Reopen:** within the window the Issue is queued again, the same call is a replay, and an open Issue is refused. A server restarted 31 days on (`FACTORY_CLOCK_OFFSET_MS`) refuses with "closed more than 30 days ago: file a new Issue" and does not verify the closed Issue again.

Beside them: `test/quality/{watch,gate,git,adapters}.test.ts` (pure rules, real git, real `make`, agw answers) and `quality-write.test.ts` (Postgres: the gate, the watch, claim, settle, cancel during verify, a stopping server, regression, reopen; every fake port records whether it was called inside a transaction, and none was).

## Ports declared

| Port | Where | Real adapter in `main.ts` | Stub |
|-|-|-|-|
| `Commits` | `domains/quality/ports.ts` | `GitCommits` | |
| `Review` | same | `AgwReview` (`FACTORY_AGW_BIN`) | |
| `Proof` | same | `MakeAndProbes` | |
| `Projects` | same | `makefileProjects`: a `verify` target means verified, a `deploy` target means `make deploy` and so `make version`; the window is `FACTORY_WATCH_WINDOW_MS` (default none, as the old project default was) | the project file brings the window, probes and migrations (package 3) |
| `LeadCheckout` | same | `leadCheckoutOf` (`app/quality-checkout.ts`): the lead attempt row through the leads store | |

`main.ts` has no stub of mine any more. The one outbox is package 4's, with `startWatchPort` passed in.

## Events recorded on Issues

| Event | From | Key |
|-|-|-|
| `shipped` | `shipIssue` (actor `lead`) | `shipped:<issue>:<attempt>:<call>` |
| `watch_passed` | `checkWatches` (actor `factory`) | `watch_passed:<issue>:<watch>` |
| `regressed` | `checkWatches` after the last retry, or `reportRegression` on a watched Issue | `regressed:<issue>:<watch>`, `regressed:<signal key>` |
| `reopened` | `reopenIssue` (actor `owner`), or `reportRegression` on a closed Issue (actor `factory`) | `reopened:<issue>:<call>`, `reopened:<signal key>` |

## Review outcome

`/review` deep (a sensitive path, the migration), scope `fc5a8ac..HEAD`, thread `rw-5-quality`. The first jobs were abandoned by other workers' prepares on the shared base thread (two earlier attempts, the first with one important finding), so the outcome below is the run on its own thread, job `rv_jg7efeqa5ioyb3voyek4`, on `6feba80`: **clean, 3 nits**, all disposed `fixed` in the commit after it.

The abandoned first round had one important finding, fixed in `843112f` before the final round: the tick chained `pass.then(tick)` with no guard and ran `make verify` on the outbox's chain. The outbox and the watches are now two loops, each skipping a fire while its last pass still runs.

| Finding | Disposition |
|-|-|
| A check that lost a version conflict kept its claim for the 15-minute lease (earlier round) | Fixed: it releases the watch |
| The server had Bun's 10 s idle limit, a ship call waits for git and agw | Fixed: `idleTimeout` 255 s, Bun's maximum |
| Every review range started two agw processes at once | Fixed: four ranges at a time |
| `verify` rows in `quality_evidence` duplicated `quality_checks` and nothing read them | Fixed: no such rows; the kind is gone from the table, contract and domain. Verify's result is `quality_checks` and `GET /issues/:id/quality` |
| `stubLeadCheckout` gives no cut, so the "older than this attempt" check does not run in production (earlier round, nit) | Declined: package 4 brings the cut, and the test with an explicit cut covers the check. Until then a lead can name any commit already on the default branch. Open point 9 |
| A blocked checkout has no ceiling (earlier round, nit) | Declined: the machine has no path from `watching` to a stall except a regression, and a blocked check is not one. The steward (package 7) reads blocked checks. Open point 10 |

The reviewer's file list was refused by agw twice before it matched `stat.txt`, as `learnings.md` expects.

## Open points

1. **`reportRegression` has no caller.** Intake records `regressed` on a watched Issue itself, so only the other half is unused: a signal for a *closed* Issue should reopen it (`app/quality-reopen.ts`: `{ issueId, signal: Key, detail }`, the signal's own deterministic key), and intake's `regressed` on a closed Issue is ignored by the machine. The orchestrator decides whether intake calls it. A closed Issue is reopened, so the third-regression count does not include a regression that reopened it; the orchestrator should confirm that reading.
2. **The path-derived evidence kinds are not ported.** The old gate asked a lead for a screenshot (`ui`), status and logs (`infra`), data queries (`data`) or error rate (`service`) by what the commits touched, and `factory issue evidence` filed them. The brief names only merged commits and a review as evidence, so I built those; `isInert` is the one piece kept, for the deployed-version check. If the kinds stay, they are a follow-up: a `file evidence` verb and a freshness rule in `judgeShip`.
3. **New settings** (`scripts/env-file.sh`'s allow-list is package 9's): `FACTORY_AGW_BIN`, `FACTORY_WATCH_WINDOW_MS`, `FACTORY_VERIFY_RETRY_MS`, `FACTORY_VERIFY_SETTLE_MS` and `FACTORY_CLOCK_OFFSET_MS` (the scenarios use the last to reach 31 days on). The tick is the leads' `FACTORY_TICK_MS`.
4. **`unwiredQuality`** in `api/quality.ts` is a null object so the CLI generator (which builds `createApp` with only `health`) and the API tests see the quality routes. Package 8 may prefer the generator to pass real dependencies.
5. **New words** for `docs/language.md`: ship refused, watch (a record per ship: window, checks, answer), `ended` (a watch whose Issue moved on), review status (`covered`, `not_required`, `uncovered`, `unknown`). Retired words stayed out.
6. **`docs/design.md` §4 describes the old hold.** The new watch keeps its scars: the retries (1, 2, 4 delays) before a regression, the settle time after a restart, the fast-forward-only checkout sync with a blocked state, the deployed-version check against the landed commit. It drops the per-kind evidence (point 2), the review refusal (NL23) and the `close` verb's gate (not in this brief).
7. **A refused ship from the machine is stored as final for its event key** (package 1's rule), so a lead that was refused by the machine ships again with a new `call`. A gate refusal stores no event, so the same `call` can try again.
8. **The CLI prints a refusal's body on stdout**, not stderr (package 0's `runOperation` does so for a declared non-2xx body); the scenarios read it there.
9. **Closed by the integration step:** the lead's cut and branch are read from the attempt row, so a commit older than the attempt is refused and the branch's own unmerged work counts.
10. **A watch whose checkout stays blocked checks again every five minutes, without end.** Each run is a row in `quality_checks`. The steward should read it and act; no signal is sent today.
11. **The listener's idle timeout is 255 s** (`main.ts`), since a ship call waits for git and agw inside one request.
