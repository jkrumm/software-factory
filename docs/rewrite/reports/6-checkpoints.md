# Package 6: Checkpoints, report

**Done: Decisions with required fields settle in turn (standing policy, the Judge, a reversible default after its wait, the owner), with a ledger; artifacts have revisions, annotations with an "Unanchored" group, and verdicts that reach the lead as one `note_lead`; Errands are raised and done; the owner's line pages checkpoints only, once.** Branch `rw/6-checkpoints` on `fc5a8ac`: eight commits and this report. `make check` is green.

## What changed

- **`domains/checkpoints/`** (pure):
  - `decision.ts`: the form (`readDecisionForm` names every missing field: `recommendation`, `options[1].cost`, `noAnswer.consequence`; a default must be a reversible option and carries its wait), `matchPolicy`, `defaultDue`/`defaultAt`, `guardVerdict`, `judgeInputOf` (scrubbed, repo as its name), `precedentTerms` (the OR query for Postgres text search).
  - `artifact.ts`: kinds, formats, verdicts, `readSubmission`, `readAnnotation`, `readableText`/`anchorOf` (a quote is found in the text a reader can select, through Markdown marks and HTML tags), `renderDecisionForm`.
  - `errand.ts`, `page.ts` (page kinds and keys, `quote`/`redact`, deep link, backoff), `ports.ts` (records, `CheckpointStore`, the four ports).
- **`app/checkpoints.ts`**: `askDecision`, `answerDecision`, `answerIn` (the one place a Decision is settled), `markWorthAsking`, `ledger`, `submitArtifact`, `reviseArtifact`, `annotateArtifact`, `giveVerdict`, `showArtifact`, `raiseErrand`, `finishErrand`, lists. **`checkpoints-settle.ts`**: `settleDecision`, `settleOpen`. **`checkpoints-pages.ts`**: `sendDuePages`, `runCheckpointPass`. **`checkpoints-uses.ts`**: the use cases bound to their dependencies, for the routes.
- **`adapters/`**: `postgres/checkpoint-store.ts`; `blobs/filesystem.ts` (a revision is a file named by its content's hash under `<data dir>/blobs`, written beside its name and renamed into place); `ntfy/ntfy.ts` (the owner's line, with `Click` as the deep link); `agw-ask/judge.ts` (a thin `agw factory-ask` call, 30-minute hang guard, no turn or time budget); `checkpoints/policies.ts` (`stubStandingPolicies`, and a JSON-file stand-in for `project.yaml`).
- **`apps/server/migrations/0600_checkpoints.sql`**: `decisions` (with a GIN index for text search), `decision_steps`, `artifacts`, `artifact_revisions`, `annotations`, `verdicts`, `errands`, `checkpoint_pages`. Status, "anchored" and "when the default is due" are derived, never columns.
- **`packages/contract/src/checkpoints.ts`**, **`api/checkpoints.ts`**, `checkpoint-settings.ts`, and the generated CLI. New commands: `issue ask`, `decision list|show|answer|worth-asking`, `artifact submit|list|show|revise|annotate|verdict`, `errand raise|list|done`, `page list`, `checkpoint pass`.
- **Shared files touched** (additive): `main.ts` (stores, ports, two timers), `api/app.ts` (one `.use`, `checkpoints?` dep), `contract/index.ts`, `generated/operations.ts` (regenerated), `tests/scenarios/fakes/agw.ts` (one branch to `agw-ask.ts`), `tests/scenarios/boot.test.ts` and `apps/cli/test/generate.test.ts` (an exact list became `arrayContaining`/`toContain`, so any package's migration or route can land).
- **Tests**: `apps/server/test/checkpoints/{domain,checkpoints}.test.ts` (59), `tests/scenarios/checkpoints/checkpoints.test.ts` (10 scenarios).

## How a Decision settles

The lead's `factory issue ask` stores the Decision and records `asked`. A pass (`checkpoint pass`, or the server's own timer) then tries, in turn:

| Step | Settles when | Recorded as |
|-|-|-|
| `policy` | a rule of the repo's standing policy matches the question and names an option | `settled_by = policy`, source = the rule's reason |
| `judge` | the Judge answers with one option, a source, and not an irreversible option | `judge`, source = the Judge's |
| `default` | the lead named a reversible default and its wait has run out | `default` |
| `owner` | nothing above did and no default is still waiting: he is paged, once | `owner`, on his answer |

Policy and the Judge claim a step, commit, call the port with no transaction open, and record in a new one. A step claimed by a call in another pass leaves the Decision alone (`in_flight`), so the owner is never paged for work a running Judge call may settle. Every settler that is not the owner puts a `noted` event before `answered`, so the one `note_lead` that ends the wait tells the lead who answered and that the owner can overrule.

## `make check`

```
==> install (bun install --frozen-lockfile)
Checked 44 installs across 100 packages (no changes) [6.00ms]
==> format (oxfmt --check)
All matched files use the correct format.
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
 183 pass
 0 fail
 643 expect() calls
Ran 183 tests across 16 files. [6.68s]
==> scenarios (bun test tests)
 20 pass
 0 fail
 101 expect() calls
Ran 20 tests across 3 files. [6.90s]
==> check passed
```

## Acceptance

All scenarios run the real server process and Postgres, the generated CLI, the fake `agw` (the Judge) and a fake ntfy server.

- **A verdict on a submitted Spec is the lead's next turn:** the verdict reply carries exactly one `note_lead`; the same verdict again, and a different one on that revision, are replays with no effects (the first stands).
- **Four settlers in turn:** by policy (no Judge call, no page); by the Judge (the fake saw the owner's earlier answer as precedent, found by text search; no page); by its default after 31 minutes (the scenario moves `asked_at` in its own table; no page); by the owner, who is paged once with the deep link and the bearer token, however often the pass runs.
- **Missing field:** exit 2, `missing_field`, the field named, nothing stored.
- **Errand:** raised, paged once, done; `note_lead` once; a repeat is a replay.
- **Unanchored:** an annotation whose quote a later revision drops lands in `unanchored`; on the revision it was made on it is anchored again.
- **Replayed outbox:** the same ask again is the same Decision; three more passes send nothing; three pages in total (Spec, one Decision, Errand), none for what the factory settled. The Judge was the only agw caller (three calls), `hc` none.

Every effect has a replay test: ask, answer (one `answered`, one `note_lead`), page plan and send, claim lapse (at-least-once), verdict, revision, annotation, Errand raise and done, blob put.

## Ports declared

| Port (in `domains/checkpoints/ports.ts`) | `main.ts` uses | Real one |
|-|-|-|
| `StandingPolicies.rulesFor(repo)` | `stubStandingPolicies` (empty); `fileStandingPolicies` when `FACTORY_CHECKPOINT_POLICY_FILE` is set (the scenarios) | package 3, from `project.yaml` |
| `JudgePort.judge(input, key)` | `agwJudge`, a thin `agw factory-ask` call | package 7 replaces `adapters/agw-ask/judge.ts` (pending loop, shared failure mapping) |
| `Notifier.send(page)` | `makeNotifier`: ntfy, or an honest stub that refuses with the missing setting | done |
| `BlobStore` | `fileBlobStore` | done |

## Events recorded on Issues

| Event | From | Actor |
|-|-|-|
| `asked` | `askDecision` | lead |
| `noted`, `answered` | `answerIn`, from `answerDecision` (owner) and the settle steps (`factory` for policy and default, `judge`) | owner, factory, judge |
| `submitted` | `submitArtifact`, `reviseArtifact` (Concept or Spec only) | lead |
| `noted`, `verdict_given` | `giveVerdict` (the `noted` only for a note, With notes or Changes, and only while the Issue waits for that review) | owner |
| `errand_raised` | `raiseErrand` | lead |
| `noted`, `errand_done` | `finishErrand` | owner |

A Decision, artifact or Errand whose Issue no longer waits for it is stored (a verdict, an Errand done) or withdrawn (a Decision), and sends no event.

## Review outcome

`/review` deep on `fc5a8ac..HEAD`.

- **Round 1** (job `rv_wenkxsq24x7ogbkizmkf`): 3 important, 1 nit. Never submitted: another worker's `prepare` on the same base (`base:fc5a8ac…`) abandoned the job. All four were fixed in `828ba04`, and the repo base-name nit has a test.
  - A Judge call in flight in another pass let a second pass fall through to the owner and page. `claimStep` now answers `claimed | in_flight | done`; `in_flight` leaves the Decision alone.
  - A page was given up after five failures, so a server started before ntfy was configured lost it. A page is never given up while its checkpoint is open; `failing` is a derived status.
  - Pages waited for every Judge call of a pass. Settle and send now run on timers of their own.
  - The Judge was given the repo's path. It gets the name.
- **Round 2** (job `rv_fpqf7ciuzxt4dxylcnd2`, own thread `rw-6-checkpoints`): actionable, 1 important, 2 nits, all disposed `fixed` in `9b7b707` with tests.
  - `ownerStep` planned a page from a Decision read before a minutes-long Judge call. It now re-reads it under a row lock (`lockDecision`, also used by `answerIn`) and withdraws it if the Issue no longer waits.
  - A recorded answer that rolled back left the step claimed for its 35-minute lease; the step is now let go as `failed`.
  - Revising back to older content counted as a replay; only the latest revision's content does.
- No third round was run: the brief asks for one review. Each fix has a test; I did not break the fixes by hand to see them fail.

## Open points

1. **Parallel workers share a review thread.** `agw review prepare` keys the thread on the base commit, so two packages off `fc5a8ac` abandon each other's prepared jobs (mine was abandoned; my first submit hit the other worker's live job and was refused for its file list, so nothing of theirs changed). Use `--thread <package>` in the parallel briefs. Worth a line in `learnings.md`.
2. **Nothing but the server's own timers settles Decisions until the loops' tick exists.** `FACTORY_CHECKPOINT_PASS_MS` (default 30 s, 0 = off) runs `settle` and `send` as two single-flight timers in `main.ts`. Package 7's tick should call `uses.settle`/`uses.send` (or `runCheckpointPass`) and the timers go. Leases make two callers safe.
3. **Unallowed settings.** `scripts/env-file.sh` (package 9) must allow `FACTORY_DATA_DIR`, `FACTORY_CHECKPOINT_PASS_MS`, `FACTORY_CHECKPOINT_POLICY_FILE`, `FACTORY_NTFY_TOPIC`, `FACTORY_CONSOLE_URL`, `FACTORY_AGW_BIN`; `NTFY_TOKEN` comes from `.env.tpl`. `settings.ts` is not mine, so `checkpoint-settings.ts` reads these itself.
4. **The "lead's own fields" step is a gate, not a settler.** The brief lists it between policy and the Judge. I read it as: the required fields are what the later steps read, and a form missing one is refused. The only way the lead's own words settle anything is its default after the wait.
5. **My calls beyond the brief:**
   - The Judge may not take an irreversible option (the owner's, or a standing policy's). A default must be reversible, refused at ask time with the field named.
   - A Decision with a default is not paged: the owner sees it in the Console, the default is taken after its wait.
   - A Decision is itself an artifact (`kind decision`, its id the Decision's, revision 1 its form as Markdown).
   - A verdict is accepted on the latest revision only.
   - A Report may carry a verdict (a spike's), and wakes no one.
6. **Words without a place in `docs/language.md`:** the Decision `status` (`open`, `answered`, `withdrawn`: the Issue no longer waits for it); a page's `failing`; the settlers `policy`, `judge`, `default`, `owner`; the pass (`checkpoint pass`); a page (one message on the owner's line). The new events are report 1's.
7. **Package 4's brief must read three things this package leaves for it.** The owner's verdict note travels in a `noted` event (with "read it with `factory artifact show <id>`"); the annotations are only in the artifact, so a lead must read it. The `noted` before an `answered` says who answered (policy, Judge, default). A `verdict_given` of `changes` means the lead revises with `factory artifact revise`.
8. **`error` bodies are not declared in the routes' OpenAPI responses.** The generated CLI prints a declared non-2xx body to stdout and drops its code; an undeclared one reaches stderr as `{ error: { code, message } }`, which a lead needs to read a refused form. Package 8 may want the CLI to print declared error bodies to stderr and declare them.
9. **Anchors check the quote only.** The `path` is stored and returned, not matched; Markdown and HTML quotes are compared as plain text after dropping marks and tags. A selection that spans a table cell boundary may not match its source.
10. **At-least-once.** A crash between an ntfy send and its record lets the lease (2 minutes) lapse and the page goes again; the other ntfy-side options (a sequence id) were not researched.
11. **Shared-test edits** (`boot.test.ts`, `generate.test.ts`) will conflict trivially with the other packages' identical edits.
