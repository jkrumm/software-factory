# Chains and Plans

A dependency wait is an edge, and an edge is declared, never guessed. A project's plan file holds the rows not yet filed, and the factory files each as an Issue once its edges clear. Many leads append to that file at once. A git merge driver appends their rows, so pure appends do not conflict.

Below: the chain (edges), plan rows, the merge driver, Replan (changing plan and edges) and Defer (a lead's own wait).

## The chain

The chain is the dependency graph of Issues and plan rows, across projects. It decides what can run at once.

- **An edge waits for a close.** `issue` runs only after `after` has closed, in any outcome. A stopped blocker releases what waits for it. A row that needs the blocker to have shipped says `after_needs: shipped` (see Plans).
- **Satisfied once.** An edge is satisfied when its blocker is first seen closed. A blocker that reopens holds nobody back.
- **No cycles.** Adding `issue -> after` is refused when `after` already waits, through open edges, for `issue`.
- **Edges cross repos.** A plan row names a row of another project as `other-project:key`, and an Issue is filed `--after` any Issue.
- **Independent work has no edge.** The server runs unrelated rows side by side when the repo's `leads` allow it. An `after` is for a row that needs what the first one shipped.

<!-- snippet: apps/server/src/domains/planning/chain.ts Edge -->
```ts
export interface Edge {
  issue: IssueId
  after: IssueId
  satisfied: boolean
  /** who inferred the edge and why (`triage: <reason>`); absent for an edge somebody stated */
  inferredBy?: string | undefined
}
```

`factory issue show issue_1797`, 2026-11-17, trimmed. This guide's own Issue stands after the docs truth pass, which closed:

```json
{ "edges": { "after": [ { "issue": "issue_1796", "via": "edge", "open": false, "satisfied": true } ], "before": [] } }
```

### Inferred edges

An inferred edge is one the factory added, not the filer.

- **Evidence or nothing.** Triage's `after` edge stands only when the filed title or text names the blocker (`Issue 1177`, `issue_1177`, `#1177`). A shared file or topic is no evidence that an Issue builds on another's output. On 2026-11-14 an incident fix and a Spec were chained behind a registry Issue and a 48-hour reading; that is the case the rule came from.
- **The owner's rank wins.** An Issue ranked at `prio` 400 or above takes no inferred edge. The owner's `--after` is stated, not inferred.
- **The reason shows.** An inferred edge stores `inferred_by`, and the queue reason says it: `waits for Issue 1177 (inferred by triage: <reason>) to close`.
- **It is measured.** For an Issue its edges hold, each admission look runs a second time as if the edges were gone. When every admission rule passes, the edge has held the Issue behind free capacity, and `ready_since` records from when. An edge that never did this delayed nothing.
- **It is taken back.** The queue loop removes an inferred edge when both Issues shipped with no meaningful path in common, or when the blocker waited on the owner (the person) for more than 6 hours.

**Example files:**

- [`chain.ts` L3-L17](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/planning/chain.ts#L3-L17): `Edge`, the one shape of a dependency.
- [`chain.ts` L19-L42](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/planning/chain.ts#L19-L42): the cycle check and the edges a close satisfies.
- [`docs/architecture.md` L811-L813](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#L811-L813): the evidence rule and the readiness measure.

## Plans

A plan is a project's `docs/plan.yaml`: the work not yet filed, as rows. The server reads it from the repo's default branch and tracks each row until its Issue closes.

- **A row is filed once.** Its Issue is remembered by project and key, and the lead sees `Plan row <key>.` before the facts.
- **Four states, derived, never stored:**
  - `waiting`: an `after` row is open, an `after_days` window or a `not_before` has not run out, or the target repo is unknown.
  - `filable`: no condition holds it.
  - `open`: an Issue exists.
  - `done`: the Issue closed, in any outcome.
- **The row carries the brief.** `facts` holds the why, what, change and acceptance the lead reads. A lead cannot see the plan or the session that wrote it.
- **Conditions are data.** `after`, `after_needs: shipped`, `after_days`, `not_before`, `lane`, `repo` and `checkpoint: spec` are keys of the row, not logic.
- **The file is strict.** Unknown keys are refused, and a file over 1 MiB or with more than 100 YAML aliases is a broken plan. The server keeps the last valid plan in force.
- **Checked offline.** `factory plan check docs/plan.yaml` prints every problem with its line and column and exits 2 when there is one. It needs no server and no token.

A real row of this repo, with a time and an edge:

```yaml
  - key: burn-in-day-7
    kind: docs
    not_before: 2026-11-15T08:00:00Z
    after: [burn-in-day-3]
    title: Burn-in report, day 7
```

`factory project plan software-factory --format plain`, 2026-11-17:

```text
burn-in-day-3	done	issue_756	-	Burn-in report, day 3
burn-in-day-7	done	issue_1384	-	Burn-in report, day 7
```

`burn-in-day-3` became issue_756 and closed at 14:04 on 2026-11-11. The day-7 row waited for the clock. The planning loop filed it as issue_1384 at 08:00:01.955 on 2026-11-15, under two seconds after `not_before`. Settle took 2 ms. A lead was admitted at 09:47:48. The Issue closed at 09:58:31 with the Report handed over.

**Example files:**

- [`plan.yaml` L199-L215](https://github.com/jkrumm/software-factory/blob/master/docs/plan.yaml#L199-L215): the two burn-in rows, one after the other.
- [`plan.ts` L10-L43](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/planning/plan.ts#L10-L43): the four row states and what a status carries.
- [`plan.md` L8-L99](https://github.com/jkrumm/software-factory/blob/master/docs/plan.md#L8-L99): the file, a row's keys, and when a row is filed.

## The plan merge driver

The plan merge driver is a git merge driver that keeps `docs/plan.yaml` conflict-free: it keeps master's file and appends what the branch added.

- **Why it exists.** Leads append rows faster than a check and a CI run take, so a plain rebase conflicts on the last lines every time.
- **Declared in the repo.** Git keeps no driver in a tracked file, so the rebase names it on its command line: `git -c merge.plan.driver='factory plan merge %O %A %B' rebase origin/master && factory plan check`.
- **Appends only.** If one side only added to the end of the base, the result is the other side plus that tail. A side that also changed existing lines is no append: the driver leaves git's line merge with its conflict markers and exits 1, so two edits of one row stay a conflict a person reads.
- **Not `union`.** Git's own `merge=union` drops the lines two appended rows share, such as a `why: |-` and its text, and leaves a row corrupt.
- **Offline.** `factory plan merge` needs no server and no token. `factory plan check` after it refuses a duplicate row key.

```text
# docs/plan.yaml is an append-only aggregator: leads add rows at the end, so two branches always touch the same last lines.
# The driver (`git -c merge.plan.driver='factory plan merge %O %A %B' rebase …`, docs/plan.md) keeps master's file and appends the
# branch's rows; git's own `union` drops the lines two rows share. Without the -c, git merges by line as for any file.
docs/plan.yaml merge=plan
```

**Example files:**

- [`.gitattributes`](https://github.com/jkrumm/software-factory/blob/master/.gitattributes#L1-L4): the declaration.
- [`plan-merge.ts` L14-L24](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/plan-merge.ts#L14-L24): `mergeAppends`, the whole rule.
- [`plan-merge.ts` L32-L53](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/plan-merge.ts#L32-L53): the verb, with the fallback to a line merge.

## Replan

A Replan is an Issue whose lead rereads a project's plan against its open and recently closed Issues and proposes changes as a Spec.

- **Three triggers.** `owner` (`factory planning replan <project>`), `stalled` (a timed wait of `FACTORY_LONG_WAIT_MS` or more has Issues behind it) and `held` (a row with `after_needs: shipped` waits behind a row that closed without shipping).
- **One at a time.** One Replan is open per project. Asking again adds the words to it as a note.
- **Decisions before the Spec.** Every non-obvious choice is a Decision raised before the Spec is submitted. The Spec has one section per change, with the row key or Issue and the reason.
- **A verdict allows the edit.** On Looks good or With notes the lead edits `docs/plan.yaml` through the project's ship path and applies edge changes and cancellations with `factory issue replan`.
- **The server gates that verb.** The Issue must be a Replan its lead works on, its latest Spec must carry one of those verdicts, and every Issue it re-edges or cancels must belong to the Replan's own project. Otherwise nothing is applied.

<!-- snippet: apps/server/src/domains/planning/replan.ts REPLAN_TRIGGERS -->
```ts
export const REPLAN_TRIGGERS = ['owner', 'stalled', 'held'] as const
```

issue_1197, `factory issue show issue_1197`, 2026-11-17: filed on 2026-11-14 at 16:11:33 with trigger `stalled`. The head was issue_1178, shipped and waiting only on a measurement timer, with issue_1196 behind it. A lead was admitted at 16:21:42 and started on sonnet at high effort at 16:21:59. It handed over a Spec at 16:22:19, "Replan: free issue_1196 from the shipped issue_1178". The owner did not read it. The Spec screen settled it by rule: a Replan that changes no plan row and cancels nothing only reorders open Issues. The verdict was Looks good at 16:22:26. The Issue closed at 16:23:18, twelve minutes after it was filed, with:

"Replan applied: edge an Issue after an Issue removed (1178 shipped, waits only on a measurement timer); no plan row or code change, nothing to deploy".

**Example files:**

- [`replan.ts` L1-L50](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/planning/replan.ts#L1-L50): triggers, inputs and the lead's playbook.
- [`spec-screen.ts` L88-L120](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/spec-screen.ts#L88-L120): the rule that settles a Replan which only frees Issues.

## Defer

A defer is a lead's named wait: until a time, until other Issues close, or on the review of its pull request.

| Wait | Verb | Ends |
|-|-|-|
| `timer` | `factory issue defer` until a time | the clock reaches it |
| `dependency` | `factory issue defer` after other Issues | the chain finds every one closed |
| `external` | `factory issue defer --review` | the review poll sees an approval, a request for changes, a new comment, a merge or a close |

- **No person, no stall.** None of the three waits on the owner by itself, and none is a stall. The Issue is Paused, split by what it waits for.
- **A deferred lead gives its claim back.** A lead that waits for another Issue of the same repo then cannot hold the one place that Issue needs. The lead takes a claim again before it is told its wait is over.
- **The steward defers too.** It defers a working Issue behind a queued Issue of its repo that waits for the claim it holds, and writes why in the event.
- **A defer is not a Decision.** A wait the lead can name needs no answer. What a person must do is an Errand, and a choice is a Decision (see [Checkpoints](./checkpoints.md)).

This guide's Spec shows a wait behind another repo's Issue. On 2026-11-17 the owner annotated the diagram tool in revision 1: it should have a Basalt theme. The lead answered the annotation `deferred` and filed the theme as an Issue of repo-a. Its reply: "The guide's five diagrams use it; the diagram step waits for it, the chapters do not." The chapters were written first, and the diagram pass waits for that Issue.

**Example files:**

- [`language.md` L260-L275](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L260-L275): every wait, who it needs and what ends it.
- [`claims.ts` L76-L95](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/claims.ts#L76-L95): the waits that free a claim.

**Read more:**

- [The plan file](https://github.com/jkrumm/software-factory/blob/master/docs/plan.md#L1-L99), [Changing an edge](https://github.com/jkrumm/software-factory/blob/master/docs/plan.md#L201-L233) and [Replan](https://github.com/jkrumm/software-factory/blob/master/docs/plan.md#L293-L309) in `docs/plan.md`.
- [Inferred edges and edge readiness](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#L811-L813) in `docs/architecture.md`.
- [Defer](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L71) in `docs/language.md`.

Next: [Checkpoints](./checkpoints.md)
