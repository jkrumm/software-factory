import type { CheckRecord, CiState } from './evidence.ts'
import { condense, failingLines, firstFailing } from './output.ts'

/** One check of verify: pass or fail, never averaged. `detail` is data, whatever the check printed. */
export interface Check {
  name: string
  ok: boolean
  detail: string
  /**
   * the check cannot say yet: neither a pass nor a regression, looked at again after `recheckMs`. The checkout is not
   * ours to move, or the default branch's CI for the landed commit has not finished.
   */
  blocked?: boolean
  /**
   * red, but not this change's, so it neither fails the watch nor is retried: a `make` target that failed the same way in
   * the repo's last run before this ship (`markInherited`), or the `ci` check that was red on the same first failing
   * check at the commit before the merge (`ciCheck`)
   */
  inherited?: boolean
  /**
   * the deployed version is readable and does not hold the landed commit: `make deploy` has not run on it. Set by the
   * deployed-version check alone; the ship gate refuses on it, and on no other red of that check (a version that cannot
   * be read is no proof of a missing deploy).
   */
  lacks?: boolean
}

export type Outcome = 'green' | 'red' | 'blocked'

export interface Probe {
  name: string
  http: string
  expect: number
}

/** What a project says of its watch and verify. */
export interface ProjectChecks {
  /** how long a shipped change is watched before verify runs */
  windowMs: number
  /** `make` deploys with `make deploy`; the others are deployed by a push, by the lead, or not at all */
  deployMode: 'auto' | 'make' | 'agentic' | 'none'
  makeVerify: boolean
  /** other `make <target>` the project's targets verify by, each run and judged like `make verify` */
  makeTargets?: string[]
  /** `deploy.paths` of the project file; unset or empty: every path that is not inert deploys */
  deployPaths?: string[]
  /** the project ships by pull request, so CI is read for the landed commit; set only when true */
  ci?: boolean
  probes: Probe[]
}

/** How the watch times its checks. The retry delay doubles: `retryMs`, twice that, four times. */
export interface Timing {
  retryMs: number
  /** how long after a blocked checkout verify looks again */
  recheckMs: number
}

/** A red check is retried this many times before it is a regression: a flaky probe or a deploy settling is no fault. */
export const MAX_RETRIES = 3

export const DEFAULT_RETRY_MS = 60_000
export const DEFAULT_RECHECK_MS = 5 * 60_000

/** The red line where the Makefile has no `version`: a probe the owner adds, never a lead. */
export const NO_VERSION_TARGET =
  'no `make version` target: it is a probe, so the owner adds it (it prints the deployed commit sha) and a lead does not: `factory issue block` with this reason'

/** CI not yet visible for a commit this long after it merged is taken to mean the repo has none. */
const CI_VISIBLE_MS = 10 * 60_000
/** CI still running this long after the merge did not finish. */
const CI_RUNNING_MAX_MS = 60 * 60_000

/** The failing check's name: `CiState.reason` is "<name> <conclusion>", the conclusion being one word. */
const failingCheck = (state: CiState): string | null => state.reason?.replace(/\s+\S+$/, '') || null

/** Whether `parent` was red on the same first failing check as `state`. A parent running, missing or unread is not. */
function redBefore(state: CiState, parent: CiState | null): boolean {
  if (parent?.status !== 'red') return false
  const name = failingCheck(state)
  return name !== null && name === failingCheck(parent)
}

/**
 * What the default branch's CI says of the landed commit, as a check named `ci`. Green is a pass and red names the
 * failing check; a run still going, or none visible in the first ten minutes, is `blocked` (looked at again, no
 * regression); one still going after an hour is red, and none after ten minutes passes (the repo may have no CI). With
 * no merge time the commit is taken as old enough for both. A red whose first failing check was red the same way in
 * `parent` (CI of the default branch before the commit landed) is `inherited`: it was there before the change, so the
 * watch passes on it. A parent that is not red, or not read (null), leaves the red the change's. Only the first failing
 * check of each is compared, so a second, new red behind an inherited first one is not told apart.
 */
export function ciCheck(
  state: CiState,
  input: { sha: string; mergedAt: Date | null; now: Date; parent?: CiState | null },
): Check {
  const name = 'ci'
  const short = input.sha.slice(0, 7)
  const age = input.mergedAt ? input.now.getTime() - input.mergedAt.getTime() : Number.POSITIVE_INFINITY
  const link = state.url ? ` (${state.url})` : ''
  switch (state.status) {
    case 'green':
      return { name, ok: true, detail: `CI green for ${short}` }
    case 'red':
      if (redBefore(state, input.parent ?? null))
        return {
          name,
          ok: false,
          inherited: true,
          detail: `${state.reason ?? 'a check failed'} for ${short}${link}, already red on the commit before it`,
        }
      return { name, ok: false, detail: `${state.reason ?? 'a check failed'} for ${short}${link}` }
    case 'running':
      if (age > CI_RUNNING_MAX_MS)
        return { name, ok: false, detail: `CI did not finish: ${state.reason ?? 'still running'} for ${short}${link}` }
      return { name, ok: false, blocked: true, detail: `CI is still running for ${short}${link}` }
    case 'missing':
      if (age >= CI_VISIBLE_MS) return { name, ok: true, detail: `no CI run found for ${short}` }
      return {
        name,
        ok: false,
        blocked: true,
        detail: `CI is not visible yet for ${short}: still running or not started`,
      }
  }
}

/** The part of an Issue's quality view the ship gate reads: its watches, each with the checks of its runs. */
export interface WatchHistory {
  answer: string | null
  checks: readonly { checks: readonly CheckRecord[] }[]
}

/**
 * Whether the Issue's newest watch ended in a regression on the default branch's CI (a `ci` check red in its last run,
 * not inherited): the red its lead was sent back with. A later pass, or a watch another check regressed, is not.
 */
export function regressedOnCi(watches: readonly WatchHistory[]): boolean {
  const last = watches.at(-1)
  if (last?.answer !== 'regressed') return false
  return last.checks.at(-1)?.checks.some((check) => check.name === 'ci' && !check.ok && !check.inherited) === true
}

/**
 * The refusal of a ship that follows a CI regression while the default branch's CI is still red for the commit it
 * landed at: a red CI is a function of the commit, so shipping again reads the same red and spends a regression on it.
 * Null when CI is green, running, missing or could not be read: only a red that stands refuses.
 */
export function ciStillRed(state: CiState | null, sha: string): string | null {
  if (state?.status !== 'red') return null
  const link = state.url ? ` (${state.url})` : ''
  return `ship refused: the default branch's CI is still red for ${sha.slice(0, 7)}: ${state.reason ?? 'a check failed'}${link}, the red your last Watch regressed on, and shipping again reads the same red. Land a commit that fixes or reverts it, or re-run the failed check where it is a flake; where the red is not this change's (it was red before it), say so in a Decision (\`factory issue ask\`) instead of shipping`
}

/**
 * What a ship that follows an alert's regression owes: the commits of the last accepted ship, when the Issue regressed
 * after it and that regression was an alert (a monitor's `down` while the Watch ran) and not a check of the Watch's own.
 * Null otherwise. The history is the Issue's applied events; `watches` are its Watches, whose last answer is
 * `regressed` only where a check regressed it.
 */
export function afterAlertRegression(
  history: readonly { kind: string }[],
  watches: readonly WatchHistory[],
  ships: readonly { result: 'accepted' | 'refused'; reported: readonly string[] }[],
): readonly string[] | null {
  const shippedAt = history.findLastIndex((record) => record.kind === 'shipped')
  if (shippedAt < 0 || !history.slice(shippedAt + 1).some((record) => record.kind === 'regressed')) return null
  if (watches.at(-1)?.answer === 'regressed') return null
  return ships.findLast((ship) => ship.result === 'accepted')?.reported ?? null
}

/** Whether every commit named is one of `previous` (a sha may be named by any prefix of seven characters or more). */
export function addsNoCommit(named: readonly string[], previous: readonly string[]): boolean {
  return named.every((sha) => previous.some((old) => old.startsWith(sha) || sha.startsWith(old)))
}

/**
 * The refusal of a ship that names no commit its predecessor did, after an alert regressed that one and while the alert
 * is still down: the same commits read the same alert, so the ship only spends a regression. `down` names the subjects.
 */
export function alertStillDown(down: readonly string[]): string {
  return `ship refused: an alert regressed your last ship and is still down (${down.join(', ')}), and this ship names no commit that one did not: shipping again cannot change what the alert reads and spends a regression on it. Land a commit that fixes or reverts the change; where the alert is not this change's (a load that was there before, a window that lags the fix), say so in a Decision (\`factory issue ask\`) instead of shipping`
}

/**
 * The refusal of a ship whose landed commit the deployed version does not hold: the Watch would fail on exactly this
 * line within the hour, so the ship says it now with the missing step. `detail` is the check's own line.
 */
export function notDeployed(detail: string, project: string): string {
  return `ship refused: ${detail}. Deploy first (\`make deploy\`, from the main checkout, never a worktree: \`factory deploy-lock --project ${project} -- make -C "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" deploy\` where leads share the deploy), then ship again with the same commits`
}

export function outcomeOf(checks: readonly Check[]): Outcome {
  if (checks.some((check) => check.blocked)) return 'blocked'
  return checks.every((check) => check.ok || check.inherited) ? 'green' : 'red'
}

/** The part of a failure's output that says what failed: numbers (times, counts, shas, pids) and spacing are not. */
const failureSignature = (detail: string): string =>
  detail
    .replace(/\b[0-9a-f]{7,40}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()

/** The set of failing lines of a check's detail, each by `failureSignature`. */
const failingSet = (detail: string): Set<string> => new Set(failingLines(detail).map(failureSignature))

/**
 * Whether `now` is a failure that was already there in `before`, the details of the earlier runs that were red: the
 * failing lines of this run are all among the failing lines of those runs together. A target that lists its drift prints
 * fewer items as they are fixed, and numbers (counts, versions, pids) change; that is the same red, while a line none of
 * them had is a new failure, an added drift item included. A run that printed no line is compared whole, to each.
 */
function failedBefore(now: string, before: readonly string[]): boolean {
  const mine = failingSet(now)
  if (mine.size === 0) return before.some((detail) => failureSignature(now) === failureSignature(detail))
  const earlier = new Set(before.flatMap((detail) => [...failingSet(detail)]))
  return [...mine].every((line) => earlier.has(line))
}

/**
 * Marks each failed `make <target>` check whose failing lines were all failing in `baseline`: the repo's last finished
 * run before the ship, and the last run of each other Issue's watch in the repo that ended in a regression no pass has
 * answered yet (one red, one owner: that Issue's lead has it, and it is not the Issue's whose watch sees the same red).
 * A verify red in a component the change never touched (a pending OS update, a dependency that moved, a drift list
 * that shrank) is not a regression of the Issue. A line none of them had keeps the check the change's. The version,
 * checkout and probe checks stay the change's: each reads this ship's own commit or the live system. The CI check is
 * marked by `ciCheck`, from the CI of the commit before the merge, not from a baseline. With no baseline,
 * or one that was green, nothing is marked.
 */
export function markInherited(checks: readonly Check[], baseline: readonly CheckRecord[] | null): Check[] {
  if (!baseline) return [...checks]
  return checks.map((check) => {
    if (check.ok || check.blocked || !check.name.startsWith('make ')) return check
    const red = baseline.filter((old) => old.name === check.name && (!old.ok || old.inherited))
    return red.length > 0 &&
      failedBefore(
        check.detail,
        red.map((old) => old.detail),
      )
      ? { ...check, inherited: true }
      : check
  })
}

/** A run of verify as it stands in the watch's history. */
export interface Ran {
  at: Date
  outcome: Outcome
}

/**
 * When the watch looks next: the end of its window, then, after a red, the retry delay (doubling), after a blocked
 * checkout the recheck delay. Read from the checks already made, so nothing is kept.
 */
export function nextCheckAt(watch: { startedAt: Date; windowMs: number }, ran: readonly Ran[], timing: Timing): Date {
  const last = ran.at(-1)
  if (!last) return new Date(watch.startedAt.getTime() + watch.windowMs)
  if (last.outcome === 'blocked') return new Date(last.at.getTime() + timing.recheckMs)
  const reds = ran.filter((one) => one.outcome === 'red').length
  return new Date(last.at.getTime() + timing.retryMs * 2 ** Math.max(0, reds - 1))
}

/** What a run of verify means for the watch, given the runs before it. */
export type Step = { kind: 'pass' } | { kind: 'again' } | { kind: 'regress'; detail: string }

export function stepOf(before: readonly Ran[], checks: readonly Check[]): Step {
  const outcome = outcomeOf(checks)
  if (outcome === 'green') return { kind: 'pass' }
  if (outcome === 'blocked') return { kind: 'again' }
  if (before.filter((one) => one.outcome === 'red').length < MAX_RETRIES) return { kind: 'again' }
  return { kind: 'regress', detail: regressionDetail(checks) }
}

const MAX_DETAIL = 1_800
/** How many failing lines head a check in the note, each clipped: what the lead reads first, before any cut output. */
const HEAD_LINES = 3
const HEAD_CHARS = 140
/** Below this a check's share of the budget is no room for its condensed output. */
const MIN_OUTPUT = 120

const clip = (line: string): string => (line.length <= HEAD_CHARS ? line : `${line.slice(0, HEAD_CHARS - 1)}…`)

/**
 * What the lead reads of a regression, the failing part first: the names of the failed checks, then for each its first
 * failing lines, then what it printed (condensed, so the budget is shared and every cut falls on a line boundary and is
 * marked). A check that printed only a few lines is its name and those lines.
 */
export function regressionDetail(checks: readonly Check[]): string {
  const failed = checks.filter((check) => !check.ok && !check.inherited)
  const heads = failed.map((check) => firstFailing(check.detail, HEAD_LINES).map(clip))
  const isShort = (check: Check): boolean =>
    failingLines(check.detail).length <= HEAD_LINES && !check.detail.includes('lines cut]')
  const spent = heads.reduce(
    (sum, lines, i) => sum + (isShort(failed[i] as Check) ? 0 : lines.join('\n').length + 40),
    0,
  )
  const share = Math.floor(Math.max(0, MAX_DETAIL - spent) / Math.max(1, failed.length))
  const blocks = failed.map((check, i) => {
    if (isShort(check)) return `${check.name} failed: ${condense(check.detail, share)}`
    const head = [`${check.name} failed, first failing lines:`, ...(heads[i] ?? []).map((line) => `  ${line}`)]
    return (share < MIN_OUTPUT ? head : [...head, 'output:', condense(check.detail, share)]).join('\n')
  })
  const names =
    failed.length > 1 ? [`${failed.length} checks failed: ${failed.map((check) => check.name).join(', ')}`] : []
  return [...names, ...blocks].join('\n')
}
