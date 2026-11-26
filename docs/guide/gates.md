# Gates

A lead cannot ship by saying so. The merge window, the merge guard, the deploy lock, the ship gate and Verify each refuse with a named reason. Review coverage is the exception: it counts rather than refuses. The lead owes it, agw proves it, and the factory records what it finds.

## Review

A review is the lead's own check of its change, run once per ship range through agw, standard or deep.

- **The lead runs it, the factory never does.** `/review <merge-base>..HEAD --thread factory-<issue number>` runs on the lead's own session. Order 6 of the brief makes it a duty before the window.
- **`agw review covered` proves a range.** Run it with `--range origin/master..HEAD --format json`. A range is covered when `uncovered` lists no sha whose entry in `commits` is `required` standard or deep. A light commit needs no review.
- **A held review is a wait, never a downgrade.** When agw answers `held` (the deep cap), the lead runs `factory issue defer --until <reset time>` and reviews then. A ship without the review is not an option.
- **A squash lands as one commit.** The squash patch matches only a single round of the review. After the merge the lead runs `covered` on the landed range and reviews a stale commit on a `-landed` thread.
- **The ship records it.** The status is `covered`, `not_required`, `uncovered` or `unknown`, with its reason. A ship without a review is counted as friction.

> [!NOTE]
> No gate refuses an unreviewed ship. `judgeShip` records the review as evidence and never refuses on it (NL23). The review-related refusals are `ship names no merged commit` and commits git cannot find on the default branch.

<!-- snippet: apps/server/src/domains/quality/gate.ts judgeShip -->
```ts
export function judgeShip(input: {
  reported: readonly string[]
  commits: Result<CommitRead>
  review: ReviewOutcome
```

issue_1807 tightened this rule. It read the lead sessions of four Issues that shipped unreviewed and found three causes. Of Issues 1640 to 1806, 12 shipped unreviewed and 11 of those were stale squash commits. Its ship record, `factory issue show issue_1807`, 2026-11-17 (acceptance lines, trimmed):

```text
met: read the lead sessions of issue_1683, 1701, 1627 and 1675: causes are (1) a squash or merge commit of a multi-round review thread, … so agw covered says stale; (2) 1701 shipped past a held deep review (cap 74/60); (3) 1627 and 1675 pushed a commit after the last review that rode the merge window. Of Issues 1640-1806, 12 shipped unreviewed, 11 of them stale
met: fixed in the brief (order 6): review before taking the window and review commits added after the last review; a held review is a defer, never a ship without it; after a squash or merge, run covered on the landed range and review the landed commit on a -landed thread when stale. Merged as #424, deployed, make verify passes
not met: the covered check itself (agw cumulative-patch matching) is agent-workflows' code; filed as issue_1827 with the repro, so the stale ships of multi-round squashes stay counted until it lands. …
```

The stale answer is agw's judgment, not the factory's. The Issue filed it there as issue_1827 and left the count running.

**Example files:**

- [`brief.ts`, order 6](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L18): review once per range; a held review is a wait
- [`gate.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/quality/gate.ts#L39-L77): the ship gate; a review is evidence, never a refusal
- [`quality-ship.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/app/quality-ship.ts#L74-L90): the other refusals, a Spec owed and annotations unanswered

## The merge window

The merge window is the one stretch per repo in which a lead rebases, pushes, waits for CI and merges.

- **One lead at a time.** `factory merge-lock --project <repo> -- <cmd>` runs the command while it holds `<project>.merge.lock`. Without it, CI (5.3 min p50, 6.2 p90 over 167 runs) outlasted the gap between merges and leads rebased against each other forever.
- **It waits up to 90 minutes** by default, set by `FACTORY_MERGE_LOCK_WAIT_MS`. Past that it exits 75 without running the command.
- **The command is the lead's.** The brief gives it: fetch, rebase onto `origin/master`, push with `--force-with-lease`, wait for CI on the pushed head, `make merge-guard`, `gh pr merge`.
- **A conflict ends the window.** The lead resolves it outside, runs `make check`, and takes the window again.
- **A finished call is reported** to the server (`POST /merge-windows`) after the release, best effort. It changes neither the lock nor the exit code.

<!-- snippet: apps/cli/src/deploy-lock.ts DEFAULT_MERGE_WAIT_MS -->
```ts
/** A merge lock is held across a CI run (~17 min), so a queue of leads waits longer (`FACTORY_MERGE_LOCK_WAIT_MS`). */
const DEFAULT_MERGE_WAIT_MS = 90 * 60_000
```

**Example files:**

- [`deploy-lock.ts`, `deployLock`](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/deploy-lock.ts#L31-L57): one lock mechanism, two kinds, `deploy` and `merge`
- [`brief.ts`, order 7](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L19): the exact command a lead runs inside the window

## The merge guard

The merge guard is `make merge-guard`, the script a lead runs just before it merges, so parallel leads never land onto a master that moved or is red.

- **It refuses with the reason.** Exit 0 when clear, 1 on a refusal with the reasons on stderr, 2 on a usage error.
- **A branch without master.** `origin/master` is not an ancestor of `HEAD`.
- **A taken migration number.** The branch adds a migration whose number master already uses, or another file of the branch repeats. The reason names the next free number.
- **A head with no finished green CI run.** None for that exact sha, one still running, or one red. `--allow-red` never skips this.
- **A red master.** Master's last finished CI run is not green. A cancelled run was superseded and is skipped; an unreadable `gh` refuses too.
- **`--wait` polls the head's CI** every 30 s, up to `--wait-minutes` (default 45).

The reasons, as the code words them:

<!-- snippet: scripts/merge-guard.ts headRed -->
```ts
  if (!last)
    return `CI has not run on ${sha.slice(0, 7)}: push the branch (the head you tested), wait for CI (make merge-guard with MERGE_GUARD_ARGS=--wait waits)`
  if (last.status !== 'completed')
    return `CI on ${sha.slice(0, 7)} is still running (${last.url}): wait for it (MERGE_GUARD_ARGS=--wait waits)`
  if (last.conclusion !== 'success')
    return `CI on ${sha.slice(0, 7)} finished ${last.conclusion} (${last.url}): fix it and push, a merge needs green CI on the exact head`
```

<!-- snippet: scripts/merge-guard.ts evaluate -->
```ts
    refusals.push(
      `${BASE} moved: this branch does not contain ${origin}. git fetch origin ${BASE} && git rebase ${origin}, then make check again`,
    )
// …
        refusals.push(`migration ${name} takes ${n}, which master already uses: rename it to ${next}_<words>.sql`)
```

`BASE` is `master` unless `factory land` lands a fix on another branch (`MERGE_GUARD_BASE`). A master run still running is not a refusal: the head contains `origin/master`, and its green CI proved that exact combination. A refusal prints as `merge-guard: refused: <reason>`.

**Example files:**

- [`merge-guard.ts`, header](https://github.com/jkrumm/software-factory/blob/master/scripts/merge-guard.ts#L1-L16): what it refuses and the exit codes
- [`merge-guard.ts`, `headRed`](https://github.com/jkrumm/software-factory/blob/master/scripts/merge-guard.ts#L75-L87): the head's CI verdict, four cases
- [`merge-guard.ts`, `evaluate`](https://github.com/jkrumm/software-factory/blob/master/scripts/merge-guard.ts#L117-L159): every refusal in order

## Ship

A ship is the lead's report that its change landed and deployed. The ship gate checks it against git, not against the lead. It answers `accepted` or `refused`; the exit codes belong to the commands above.

- **Git finds the commits.** A ship that names no commit ships what the Issue's branches landed: each attempt's branch, newest first, read by content: the first commit of the default branch since the branch forked that holds every file the branch changed as the branch has it (a squash or a rebase), or, for a branch the default branch already holds and the lead made a commit on, the commit that brought it in (a merge, or its tip). Commits named with `--commit` are read as they are. Either way git must find them on the default branch and newer than the Issue's cut, its first attempt's, so a later attempt ships what an earlier one landed. A branch with work and nothing landed is refused with the merge window to take (`factory merge-lock`); with no work at all, as `ship refused: ship names no merged commit`; each refusal is counted as friction.
- **A fix on another branch names it.** `--base <branch>` makes git look for the commits, the review ranges and the landed commit on `origin/<branch>`; the evidence records it and the Watch follows it. Unset, the default branch.
- **Acceptance lines are stated, not judged.** One `--acceptance` per line of the Issue, each starting `met: ` or `not met: `. A `not met` is honest and never refuses; a ship stating nothing is counted as friction like an unreviewed one.
- **CI is recorded** as `green`, `red`, `running`, `missing` or `unknown`, and a red or missing one is counted as friction.
- **A red CI that a Watch regressed on refuses.** After a Watch regressed on the default branch's CI, a ship is refused while that CI is still red for the commit it lands at: the same commit reads the same red. A fix or a revert, or a re-run that turns it green, goes through; a CI that cannot be read never refuses.
- **An alert that regressed the last ship refuses a repeat.** After a monitor's `down` took a ship back to its lead (not a check of the Watch's own), a ship that names no commit the last one did not is refused while one of the Issue's alerts is still down: the same commits read the same alert, and each repeat spends one of the two regressions the Issue has before it stalls. A new commit goes through, as does a ship once the alert is up; the lead's other way out is a Decision (`factory issue ask`) where the alert is not the change's. An alert that cannot be read never refuses.
- **A deploy that has not run refuses.** For a project that deploys with `make` (deploy mode `make`), a ship of a change that deploys reads `make version` as the Watch does, and is refused while the deployed commit does not hold the commit the work landed at (`ship refused: deployed <sha> does not hold <sha>…: run \`make deploy\``): deploy, then ship the same commits again. A version that cannot be read (no `make version`, a timeout, a git that cannot compare), a change that deploys nothing and a project with another deploy mode never refuse; the Watch reports those.
- **An owed Spec refuses.** An Issue with checkpoint `spec` and no Spec submitted is refused until one is.
- **A ship is idempotent.** `--call <id>` makes a repeated call one ship.

issue_1809's ship record, `factory issue show issue_1809`, 2026-11-17 (trimmed):

```json
{
  "at": "2026-11-17T03:04:20.755Z",
  "attempt": 1,
  "result": "accepted",
  "commits": ["a36e5f0105b71add9c685cb4838b0baa7e46e1a8", "5722d2a94329631f30fd75a63dd0250d2feae7b1", "ffc53fd466db1419b7b0d56eaabd76adbc3fb4e6"],
  "review": { "present": true, "note": "covered" },
  "acceptance": [
    { "status": "met", "text": "a step now passes a head frozen for the whole pass window when the head still fits beside it … (headFitsBeside, boundary-tested) …" },
    { "status": "not_met", "text": "the line is not proven shorter in production yet; part of the saturation is real (22.6 leads running on average today against 13 the days before) …" },
    { "status": "not_met", "text": "learned peaks are summed ps RSS while free memory is Activity-Monitor accounting; a footprint comparison from 24 h of host_class_samples was inconclusive, so the accounting is unchanged" }
  ]
}
```

The second line states what production has not yet shown.

**Example files:**

- [`gate.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/quality/gate.ts#L44-L77): `judgeShip`, pure: the same answers give the same verdict
- [`brief.ts`, the ship verb](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L62): the `--acceptance` form and its refusal

## The deploy lock

The deploy lock is the host-local lock two leads of one project take so they never deploy at the same time.

- **A pid symlink.** The lock is a symlink named `<project>.lock` to the holder's pid. `symlinkSync` is atomic and the pid is in place from the first instant.
- **Closed always.** There is no server call and no open-on-outage mode. A lock that cannot be created or read is one stderr line and exit 75 without running the command.
- **Only a dead holder is reclaimed,** one reclaimer at a time, through a `<lock>.reclaim` directory. An unreadable lock is never reclaimed.
- **It waits 30 minutes** by default for a live holder, set by `FACTORY_DEPLOY_LOCK_WAIT_MS`, polled every 2 s.
- **The exit code is the command's.** The lock runs the command with the caller's own stdin, stdout and stderr.

<!-- snippet: apps/cli/src/deploy-lock.ts holdAndRun -->
```ts
if ('failed' in outcome) {
  io.err(`factory: ${kind} lock for ${input.project}: ${outcome.failed}; not running\n`)
  return EX_TEMPFAIL
}
```

The brief wraps the deploy as `factory deploy-lock --project <repo> -- make -B -C <main checkout> deploy` when the project shares it with other leads: from the main checkout, never a worktree, because a worktree's `make deploy` repoints the LaunchAgents at the worktree. `-B` forces the recipe, since a `deploy/` directory would otherwise make plain `make deploy` a silent no-op.

**Example files:**

- [`pid-lock.ts`, `tryTake`](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/pid-lock.ts#L61-L111): take, hold, retry or fail; reclaim a dead holder only
- [`deploy-lock.ts`, `holdAndRun`](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/deploy-lock.ts#L94-L153): the wait loop and its refusals

## Verify and the watch

The watch is the window after a ship, and Verify is the check that ends it: `make verify` and the project's probes.

- **It runs on its own loop,** so a slow verify never holds the leads' pass.
- **CI of the landed commit counts.** In a pull-request project, Verify reads the default branch's CI for the exact merged commit. A run still running is neither green nor red, so the watch looks again and does not pass; one running past an hour is red. A red that the commit before it already had on the same failing check is inherited, not this change's regression.
- **A red check is retried** up to three times, with a doubling delay, before it counts as a regression.
- **A failure returns as a note.** `Regressed` goes back to the lead, who fixes forward. A revert is the lead's call, never a reflex. The lead goes back to work twice; the third regression stalls the Issue.

issue_1809's checks, 2026-11-17:

```json
{ "at": "2026-11-17T03:05:52.724Z", "result": "blocked", "summary": "ci: CI is still running for a36e5f0 (…)" }
{ "at": "2026-11-17T03:11:00.679Z", "result": "green", "summary": "All 4 checks passed." }
```

The first check came 1 minute 32 seconds after the ship. It found CI still running and neither passed nor failed the watch. The second check was green and the watch passed.

**Example files:**

- [`watch.ts`, `ciCheck`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/quality/watch.ts#L83-L126): CI of the landed commit as a check
- [`watch.ts`, `stepOf`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/quality/watch.ts#L267-L274): pass, again or regress

**Read more:**

- [Quality](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#quality): ship, review evidence, watch and verify
- [Merging](https://github.com/jkrumm/software-factory/blob/master/docs/operations.md#L111-L129): the window, the guard and the merge method
- [Shipping](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L114-L150): Gate, Ship, Watch, Verify, Regressed, Friction

Next: [Capacity](./capacity.md)
