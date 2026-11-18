import {
  type HygieneAnswer,
  type HygieneCandidate,
  type HygieneFinding,
  type HygieneRequest,
} from '@software-factory/contract'
import { HYGIENE_DEFAULTS } from '@software-factory/contract'
import type { HygieneJudgment, HygienePassRecord } from './ports.ts'
import { MAX_SIGNALS_PER_PASS } from './budget.ts'
import { isIdle, PROBES, type ProbeFinding, type Scope, type SweepReport } from './hygiene-model.ts'

/** Slots the judgment keeps: the deterministic findings may take `MAX_SIGNALS_PER_PASS - JUDGMENT_RESERVE`. */
const JUDGMENT_RESERVE = 2
export const MAX_PROBE_SIGNALS = MAX_SIGNALS_PER_PASS - JUDGMENT_RESERVE

/** A failed judgment is asked again until this many attempts have been made. */
const MAX_JUDGMENT_ATTEMPTS = 3

/** The key prefix of a filed or over-budget judgment finding, so a probe key and a judgment key never meet. */
export const JUDGMENT_PREFIX = 'judgment:'

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Probe order (`PROBES`), within a probe the larger finding first, ties by key. */
export function rankProbeFindings(findings: readonly ProbeFinding[]): ProbeFinding[] {
  return [...findings].sort(
    (a, b) => PROBES.indexOf(a.probe) - PROBES.indexOf(b.probe) || b.count - a.count || byKey(a.key, b.key),
  )
}

/** The first `MAX_PROBE_SIGNALS` ranked findings are filed; the rest are named, never dropped. */
export function probeBudget(ranked: readonly ProbeFinding[]): { file: ProbeFinding[]; overBudget: ProbeFinding[] } {
  return { file: ranked.slice(0, MAX_PROBE_SIGNALS), overBudget: ranked.slice(MAX_PROBE_SIGNALS) }
}

/** What the judgment may file: the pass's budget minus the probe signals filed, never less than the reserve. */
export const judgmentBudget = (probeFiled: number): number =>
  Math.max(MAX_SIGNALS_PER_PASS - probeFiled, JUDGMENT_RESERVE)

/** The probe signals in a record's `filed` (a judgment finding's key carries the prefix). */
export const probeFiledCount = (record: Pick<HygienePassRecord, 'filed'>): number =>
  record.filed.filter((entry) => !entry.key.startsWith(JUDGMENT_PREFIX)).length

const MAX_CANDIDATES = 20

/** The documents handed to the workflow: each path once (stale first), at most 20 of each list. */
function candidatesOf(report: Pick<SweepReport, 'stale' | 'slop'>): {
  stale: HygieneCandidate[]
  slop: HygieneCandidate[]
} {
  const stale = report.stale.slice(0, MAX_CANDIDATES)
  const seen = new Set(stale.map((c) => c.path))
  const slop = report.slop.filter((c) => !seen.has(c.path)).slice(0, MAX_CANDIDATES)
  return { stale, slop }
}

/** The request for `factory-hygiene`; null when there is nothing to read or no budget left. */
export function requestOf(input: {
  repo: string
  cwd: string
  ref: string
  report: Pick<SweepReport, 'stale' | 'slop'>
  max: number
}): HygieneRequest | null {
  const { stale, slop } = candidatesOf(input.report)
  if (stale.length + slop.length === 0 || input.max < 1) return null
  return {
    repo: input.repo,
    cwd: input.cwd,
    ref: input.ref,
    stale,
    slop,
    max: Math.min(input.max, 10),
  }
}

export interface Checked {
  findings: HygieneFinding[]
  /** findings the factory dropped as not valid, each with why */
  rejected: { title: string; why: string }[]
  /** valid findings over `max` */
  overBudget: HygieneFinding[]
}

/** The factory's check of an answer: only candidate paths, one finding per kind and path, at most `max`. */
export function checkAnswer(answer: HygieneAnswer, request: HygieneRequest): Checked {
  const paths = new Set([...request.stale, ...request.slop].map((c) => c.path))
  const seen = new Set<string>()
  const valid: HygieneFinding[] = []
  const rejected: Checked['rejected'] = []
  for (const finding of answer.findings) {
    if (!paths.has(finding.path)) {
      rejected.push({ title: finding.title, why: `${finding.path} is not one of the documents asked about` })
      continue
    }
    const id = `${finding.kind}:${finding.path}`
    if (seen.has(id)) {
      rejected.push({ title: finding.title, why: `a ${finding.kind} finding for ${finding.path} exists already` })
      continue
    }
    seen.add(id)
    valid.push(finding)
  }
  return { findings: valid.slice(0, request.max), rejected, overBudget: valid.slice(request.max) }
}

export const judgmentKey = (finding: Pick<HygieneFinding, 'kind' | 'path'>): string =>
  `${JUDGMENT_PREFIX}${finding.kind}:${finding.path}`

/** Built from the kind and the path, never from the model's wording: intake fingerprints the title, so the same document is one pattern. */
export const judgmentTitle = (finding: Pick<HygieneFinding, 'kind' | 'path'>): string =>
  `Hygiene: ${finding.kind} document ${finding.path}`.slice(0, 512)

/** Why there is nothing to ask: a history scan that failed is said, not hidden behind an empty list. */
export const nothingToRead = (report: Pick<SweepReport, 'candidatesError'>): string =>
  report.candidatesError ? `the documents could not be listed: ${report.candidatesError}` : 'no document to read'

export interface Swept {
  repo: string
  ref: string
}

const shortRef = (ref: string): string => ref.slice(0, 7)

/** The seat the finding's Issue starts on: every hygiene finding is a probe's, and the probe turning green proves the fix. */
const seatLine = (): string =>
  'Seat: light (the probe turning green proves the fix; a class whose Issues keep moving up starts on the standard lead)'

/** A probe finding as a signal: the stable title, what was swept, the evidence lines and how to look again. */
export function probeSignalText(finding: ProbeFinding, swept: Swept): string {
  return [
    `Swept: ${swept.repo} @ ${shortRef(swept.ref)}`,
    `Probe: ${finding.probe} (${finding.key})`,
    seatLine(),
    `Evidence (${finding.count} item(s), up to the first ${finding.lines.length} lines):`,
    ...finding.lines,
    ...(finding.plan ?? []),
    finding.reproduce !== undefined
      ? `Reproduce: ${finding.reproduce}`
      : finding.probe === 'check'
        ? 'Reproduce: make check'
        : 'Sweep: factory read loops',
  ].join('\n')
}

/** A judgment finding as a signal: where it was read, the evidence, the fix. */
export function judgmentSignalText(finding: HygieneFinding, swept: Swept): string {
  return [
    `Swept: ${swept.repo} @ ${shortRef(swept.ref)}`,
    `Judgment: ${finding.kind} document ${finding.path}`,
    seatLine(),
    `Finding: ${finding.title}`,
    `Evidence: ${finding.evidence}`,
    `Fix: ${finding.fix}`,
    `Reproduce: read ${finding.path} at ${shortRef(swept.ref)} against the code it describes`,
  ].join('\n')
}

// ---- which work is due ----------------------------------------------------------------------------------------------------

export type HygieneWork =
  | { kind: 'none' }
  | { kind: 'full'; repo: string }
  | { kind: 'steady'; repo: string }
  | { kind: 'daily'; repo: string; lastFull: HygienePassRecord | null }
  | { kind: 'retry'; repo: string; row: HygienePassRecord }

/** The `ref` of a pass whose checkout could not be made. */
export const NO_REF = 'none'

/** A recorded pass's scope: a pass recorded before the daily scope was a full one. */
const scopeOf = (row: Pick<HygienePassRecord, 'report'>): Scope => row.report.scope ?? 'full'

/**
 * The next work for this tick, at most one project. A project whose newest full pass is older than `everyMs` (or has none) is
 * due a full pass, never-swept first, then oldest. Otherwise one whose newest pass of any scope is older than `dailyMs` is
 * due a daily pass (the cheap probes; `dailyMs` 0 is off), the full ones first. Otherwise a project whose newest full pass is
 * within `everyMs` and whose judgment failed, with attempts left and `retryMs` gone since the attempt, is due a
 * judgment-only retry. `rows` holds the newest pass of each repo and scope. `allow` null is every project.
 *
 * An idle repo (no commit on its default branch for `idleAfterDays`, read from its newest pass) is due its full pass monthly
 * (`monthlyMs`), the document judgment and the `deps` refresh with it; in between its weekly pass is `steady` (the rest of the
 * catalogue). Full first, then steady, then daily.
 */
export function planHygiene(input: {
  projects: readonly string[]
  rows: readonly HygienePassRecord[]
  now: Date
  everyMs: number
  dailyMs?: number
  retryMs: number
  allow: readonly string[] | null
  /** a project's own `hygiene.idleAfterDays`; undefined is the catalogue's default */
  idleAfterDays?: (repo: string) => number | undefined
  monthlyMs?: number
}): HygieneWork {
  const { now } = input
  const dailyMs = input.dailyMs ?? 0
  const newest = new Map<string, HygienePassRecord>()
  const newestFull = new Map<string, HygienePassRecord>()
  const newestWeekly = new Map<string, HygienePassRecord>()
  for (const row of input.rows) {
    const any = newest.get(row.repo)
    if (!any || row.at.getTime() > any.at.getTime()) newest.set(row.repo, row)
    if (scopeOf(row) === 'daily') continue
    const weekly = newestWeekly.get(row.repo)
    if (!weekly || row.at.getTime() > weekly.at.getTime()) newestWeekly.set(row.repo, row)
    if (scopeOf(row) !== 'full') continue
    const full = newestFull.get(row.repo)
    if (!full || row.at.getTime() > full.at.getTime()) newestFull.set(row.repo, row)
  }
  const repos = input.projects.filter((repo) => input.allow === null || input.allow.includes(repo)).sort(byKey)
  // A pass that made no checkout ran no probe at all: it is asked again after the retry gap, not after a week or a day.
  const gapOf = (row: HygienePassRecord | undefined, normal: number): number =>
    row?.ref === NO_REF ? input.retryMs : normal
  const due = (row: HygienePassRecord | undefined, normal: number): boolean =>
    !row || row.at.getTime() <= now.getTime() - gapOf(row, normal)
  const oldest = (a: string, b: string): number =>
    (newest.get(a)?.at.getTime() ?? 0) - (newest.get(b)?.at.getTime() ?? 0)

  const monthlyMs = input.monthlyMs ?? HYGIENE_DEFAULTS.monthlyDays * 86_400_000
  const idle = (repo: string): boolean =>
    isIdle({
      lastCommitAt: newest.get(repo)?.report.lastCommitAt,
      idleAfterDays: input.idleAfterDays?.(repo),
      now,
    })

  const full = repos.filter((repo) => due(newestFull.get(repo), idle(repo) ? monthlyMs : input.everyMs)).sort(oldest)[0]
  if (full !== undefined) return { kind: 'full', repo: full }

  const steady = repos.filter((repo) => idle(repo) && due(newestWeekly.get(repo), input.everyMs)).sort(oldest)[0]
  if (steady !== undefined) return { kind: 'steady', repo: steady }

  const daily = dailyMs > 0 ? repos.filter((repo) => due(newest.get(repo), dailyMs)).sort(oldest)[0] : undefined
  if (daily !== undefined) return { kind: 'daily', repo: daily, lastFull: newestFull.get(daily) ?? null }

  const retries = repos.flatMap((repo) => {
    const row = newestFull.get(repo)
    if (!row) return []
    const { judgment } = row
    const retry =
      judgment.outcome === 'failed' &&
      judgment.attempts < MAX_JUDGMENT_ATTEMPTS &&
      (judgment.judgedAt === null || judgment.judgedAt.getTime() <= now.getTime() - input.retryMs)
    return retry ? [row] : []
  })
  const next = retries.sort((a, b) => (a.judgment.judgedAt?.getTime() ?? 0) - (b.judgment.judgedAt?.getTime() ?? 0))[0]
  return next ? { kind: 'retry', repo: next.repo, row: next } : { kind: 'none' }
}

export const skipped = (reason: string): HygieneJudgment => ({
  outcome: 'skipped',
  attempts: 0,
  judgedAt: null,
  reason,
  findings: [],
})
