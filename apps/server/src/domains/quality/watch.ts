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
   * a `make` target that failed the same way in the repo's last run before this ship: red, but not this change's, so it
   * neither fails the watch nor is retried (`markInherited`)
   */
  inherited?: boolean
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
export const CI_VISIBLE_MS = 10 * 60_000
/** CI still running this long after the merge did not finish. */
export const CI_RUNNING_MAX_MS = 60 * 60_000

/**
 * What the default branch's CI says of the landed commit, as a check named `ci`. Green is a pass and red names the
 * failing check; a run still going, or none visible in the first ten minutes, is `blocked` (looked at again, no
 * regression); one still going after an hour is red, and none after ten minutes passes (the repo may have no CI). With
 * no merge time the commit is taken as old enough for both.
 */
export function ciCheck(state: CiState, input: { sha: string; mergedAt: Date | null; now: Date }): Check {
  const name = 'ci'
  const short = input.sha.slice(0, 7)
  const age = input.mergedAt ? input.now.getTime() - input.mergedAt.getTime() : Number.POSITIVE_INFINITY
  const link = state.url ? ` (${state.url})` : ''
  switch (state.status) {
    case 'green':
      return { name, ok: true, detail: `CI green for ${short}` }
    case 'red':
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

export function outcomeOf(checks: readonly Check[]): Outcome {
  if (checks.some((check) => check.blocked)) return 'blocked'
  return checks.every((check) => check.ok || check.inherited) ? 'green' : 'red'
}

/** The part of a failure's output that says what failed: numbers (times, counts, shas, pids) and spacing are not. */
export const failureSignature = (detail: string): string =>
  detail
    .replace(/\b[0-9a-f]{7,40}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()

/** The set of failing lines of a check's detail, each by `failureSignature`. */
const failingSet = (detail: string): Set<string> => new Set(failingLines(detail).map(failureSignature))

/**
 * Whether `now` is a failure that was already there in `before`: the failing lines of this run are all among the failing
 * lines of that one. A target that lists its drift prints fewer items as they are fixed, and numbers (counts, versions,
 * pids) change; that is the same red, while a line the baseline never had is a new failure, an added drift item
 * included. A run that printed no line is compared whole.
 */
function failedBefore(now: string, before: string): boolean {
  const mine = failingSet(now)
  if (mine.size === 0) return failureSignature(now) === failureSignature(before)
  const earlier = failingSet(before)
  return [...mine].every((line) => earlier.has(line))
}

/**
 * Marks each failed `make <target>` check whose failing lines were all failing in `baseline`, the repo's last finished
 * run before the ship: a verify red in a component the change never touched (a pending OS update, a dependency that
 * moved, a drift list that shrank) is not a regression of the Issue. A line the baseline did not have keeps the
 * check the change's. The version, CI, checkout and probe checks stay the change's: each reads this ship's own commit
 * or the live system. With no baseline, or one that was green, nothing is marked.
 */
export function markInherited(checks: readonly Check[], baseline: readonly CheckRecord[] | null): Check[] {
  if (!baseline) return [...checks]
  return checks.map((check) => {
    if (check.ok || check.blocked || !check.name.startsWith('make ')) return check
    const before = baseline.some(
      (old) => old.name === check.name && (!old.ok || old.inherited) && failedBefore(check.detail, old.detail),
    )
    return before ? { ...check, inherited: true } : check
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
