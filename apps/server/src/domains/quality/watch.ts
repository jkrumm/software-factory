import { condense } from './output.ts'

/** One check of verify: pass or fail, never averaged. `detail` is data, whatever the check printed. */
export interface Check {
  name: string
  ok: boolean
  detail: string
  /** the check could not look at the code at all (the checkout is not ours to move): neither a pass nor a regression */
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
