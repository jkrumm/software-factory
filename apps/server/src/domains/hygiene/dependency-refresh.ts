import type { DepsThresholds } from '@software-factory/contract'
import {
  type AdvisoryRow,
  type DependencyEcosystem,
  type DependencyRow,
  MAX_EVIDENCE_LINES,
  type ProbeFinding,
  type ProbeRun,
} from './hygiene-model.ts'
import { cooldownEnd, planLines, planUpgrades, procedureLines } from './upgrades.ts'

/**
 * One dependency refresh per repo. The `deps` and `advisories` probes read every ecosystem; this folds what they read into at
 * most one finding, `deps`, and only when it clears the bar: a high advisory with a fixed version, a runtime major, a runtime
 * dependency a minor behind for long enough, or enough dependencies behind in all. Rows inside their cooldown never count. What
 * does not clear the bar is named in the run's detail (the Hygiene tab shows it) and nothing is filed. Pure.
 */

const DAY_MS = 86_400_000
const MAX_NAMED = 3
const MAX_LINE = 240

const LABEL: Record<DependencyEcosystem, string> = {
  npm: 'npm',
  cargo: 'Cargo',
  python: 'Python',
  swift: 'Swift',
  docker: 'Docker',
  actions: 'GitHub Actions',
}
const COMMAND: Record<DependencyEcosystem, string> = {
  npm: 'bun outdated',
  cargo: 'the versions in Cargo.toml against crates.io',
  python: 'the versions in pyproject.toml or requirements*.txt against PyPI',
  swift: 'the .package versions in Package.swift against the repo tags',
  docker: 'the FROM and image: tags against Docker Hub',
  actions: 'the uses: versions against the action repos tags',
}
const ECOSYSTEMS = Object.keys(LABEL) as DependencyEcosystem[]
const SIZE_ORDER = { major: 0, minor: 1, patch: 2 } as const

export interface Refresh {
  /** why the refresh is filed; empty: it is below the bar */
  reasons: string[]
  /** rows past their cooldown: the ones that count */
  ready: DependencyRow[]
  /** rows still inside their cooldown (or held by the package manager's own) */
  held: DependencyRow[]
}

const isHeld = (row: DependencyRow, now: Date): boolean =>
  row.heldBack === true || (cooldownEnd(row)?.getTime() ?? 0) > now.getTime()

const named = (names: string[]): string =>
  names.length > MAX_NAMED
    ? `${names.slice(0, MAX_NAMED).join(', ')}, +${names.length - MAX_NAMED} more`
    : names.join(', ')

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Whether the readings clear the bar, and why. */
export function judgeRefresh(input: {
  rows: readonly DependencyRow[]
  advisories: readonly AdvisoryRow[]
  thresholds: DepsThresholds
  now: Date
}): Refresh {
  const { now, thresholds } = input
  const ready = input.rows.filter((row) => !isHeld(row, now))
  const held = input.rows.filter((row) => isHeld(row, now))
  const reasons: string[] = []
  if (input.advisories.length) {
    reasons.push(
      `${plural(input.advisories.length, 'high or critical advisory', 'high or critical advisories')} with a fixed version (${named([...new Set(input.advisories.map((a) => a.pkg))])})`,
    )
  }
  const majors = ready.filter((row) => !row.dev && row.size === 'major')
  if (majors.length)
    reasons.push(
      `${plural(majors.length, 'runtime major', 'runtime majors')} behind (${named(majors.map((r) => r.name))})`,
    )
  const stale = ready.filter(
    (row) =>
      !row.dev &&
      row.size === 'minor' &&
      row.releasedAt !== undefined &&
      now.getTime() - row.releasedAt.getTime() >= thresholds.runtimeStaleDays * DAY_MS,
  )
  if (stale.length) {
    reasons.push(
      `${plural(stale.length, 'runtime dependency', 'runtime dependencies')} a minor behind for ${thresholds.runtimeStaleDays}+ days (${named(stale.map((r) => r.name))})`,
    )
  }
  if (ready.length >= thresholds.behindRows) {
    reasons.push(`${ready.length} dependencies behind, the bar is ${thresholds.behindRows}`)
  }
  return { reasons, ready, held }
}

const clip = (text: string): string => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text)

const advisoryLine = (advisory: AdvisoryRow): string =>
  `${advisory.pkg} ${advisory.version}: ${advisory.id} ${advisory.severity} (fixed in ${advisory.fixedIn})`

const rowLine = (row: DependencyRow): string =>
  `${LABEL[row.ecosystem]}: ${row.name} ${row.current} -> ${row.latest} (${row.size}${row.dev ? ', dev' : ''})`

function reproduceOf(advisories: readonly AdvisoryRow[]): string {
  const sources = new Set(advisories.map((advisory) => advisory.source))
  return [
    sources.has('bun') ? 'bun audit --audit-level=high in the directory of the bun.lock' : '',
    sources.has('osv') ? 'osv-scanner scan source -L <lockfile>' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

/** The one finding: why it is filed, the evidence, a section and an upgrade plan per ecosystem, and the procedure once. */
function findingOf(refresh: Refresh, advisories: readonly AdvisoryRow[], now: Date): ProbeFinding {
  const ordered = [...refresh.ready].sort(
    (a, b) => Number(a.dev) - Number(b.dev) || SIZE_ORDER[a.size] - SIZE_ORDER[b.size] || a.name.localeCompare(b.name),
  )
  const lines = [
    `Why filed: ${refresh.reasons.join('; ')}`,
    ...advisories.slice(0, MAX_NAMED).map(advisoryLine),
    ...ordered.map(rowLine),
  ]
    .slice(0, MAX_EVIDENCE_LINES)
    .map(clip)
  const sections = ECOSYSTEMS.flatMap((ecosystem) => {
    const rows = [...refresh.ready, ...refresh.held].filter((row) => row.ecosystem === ecosystem)
    return rows.length
      ? [`## ${LABEL[ecosystem]} (${COMMAND[ecosystem]})`, ...planLines(planUpgrades(rows, now), now)]
      : []
  })
  const plan = [
    ...(advisories.length
      ? [
          '## Advisories with a fixed version (take these first; a fix may be taken inside its cooldown)',
          ...advisories.map(advisoryLine),
          `Reproduce: ${reproduceOf(advisories)}`,
        ]
      : []),
    ...sections,
    ...procedureLines(),
  ]
  return {
    probe: 'deps',
    key: 'deps',
    title: 'Hygiene: dependency refresh',
    lines,
    count: refresh.ready.length + advisories.length,
    plan,
  }
}

const belowBar = (refresh: Refresh, thresholds: DepsThresholds): string => {
  const runtime = refresh.ready.filter((row) => !row.dev).length
  const held = refresh.held.length ? `, ${refresh.held.length} still in cooldown` : ''
  return `below the bar, not filed: ${refresh.ready.length} of ${thresholds.behindRows} behind (${runtime} runtime)${held}${
    refresh.ready.length ? `: ${named(refresh.ready.map((row) => row.name))}` : ''
  }`
}

/** An advisories run that did not speak for every lockfile: a green `deps` must not close what it may have raised. */
const advisoriesUnjudged = (run: ProbeRun): boolean =>
  run.outcome === 'failed' ||
  (run.unjudged?.length ?? 0) > 0 ||
  (run.outcome === 'skipped' && !/^(no supported lockfile|the project opts out)/.test(run.detail))

/**
 * Replaces every `deps` and `advisories` finding of a sweep by the refresh: none, or one `deps` finding. The `deps` run's detail
 * says what was filed or why not; it speaks for the key `deps` only when the advisories it folded in were judged too.
 */
export function foldDependencies(input: {
  findings: readonly ProbeFinding[]
  runs: readonly ProbeRun[]
  thresholds: DepsThresholds
  now: Date
}): { findings: ProbeFinding[]; runs: ProbeRun[] } {
  const own = input.findings.filter((finding) => finding.probe === 'deps' || finding.probe === 'advisories')
  const others = input.findings.filter((finding) => finding.probe !== 'deps' && finding.probe !== 'advisories')
  const rows = own.flatMap((finding) => finding.rows ?? [])
  const seen = new Set<string>()
  const advisories = own
    .flatMap((finding) => finding.advisories ?? [])
    .filter((advisory) => {
      const id = `${advisory.pkg}|${advisory.version}|${advisory.id}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  const refresh = judgeRefresh({ rows, advisories, thresholds: input.thresholds, now: input.now })
  const filed = refresh.reasons.length > 0
  const advisoriesRun = input.runs.find((run) => run.probe === 'advisories')
  const unjudged = advisoriesRun !== undefined && advisoriesUnjudged(advisoriesRun)

  const runs = input.runs.map((run): ProbeRun => {
    if (run.probe !== 'deps') return run
    const verdict = run.outcome === 'clean' || run.outcome === 'found'
    const unjudgedKeys = unjudged && verdict ? [...new Set([...(run.unjudged ?? []), 'deps'])] : run.unjudged
    const detail = !verdict
      ? run.detail
      : filed
        ? `${run.detail}; filed as one refresh: ${refresh.reasons.join('; ')}`
        : rows.length
          ? `${run.detail}; ${belowBar(refresh, input.thresholds)}`
          : run.detail
    return {
      ...run,
      // below the bar is a clean verdict: the dependencies are not behind enough to file
      outcome: verdict && !filed ? 'clean' : run.outcome,
      detail,
      ...(unjudgedKeys?.length ? { unjudged: unjudgedKeys } : {}),
    }
  })
  return { findings: [...(filed ? [findingOf(refresh, advisories, input.now)] : []), ...others], runs }
}
