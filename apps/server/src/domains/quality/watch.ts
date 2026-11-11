import type { CiState } from './evidence.ts'
import { condense } from './output.ts'

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
  return checks.every((check) => check.ok) ? 'green' : 'red'
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

/**
 * What the lead reads of a regression: each failed check, by name, with the failing part of what it printed. The budget
 * is shared between them and every cut falls on a line boundary and is marked (`condense`).
 */
export function regressionDetail(checks: readonly Check[]): string {
  const failed = checks.filter((check) => !check.ok)
  const share = Math.floor(MAX_DETAIL / Math.max(1, failed.length))
  return failed.map((check) => `${check.name} failed: ${condense(check.detail, share)}`).join('\n')
}
