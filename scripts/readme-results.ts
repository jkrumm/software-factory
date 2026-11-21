#!/usr/bin/env bun
/**
 * The result numbers of the README and the guide's start page. One dated snapshot, `docs/results.json`, holds what
 * `factory read kpis` and `factory read friction` said; both pages carry the same table, rendered from it between two
 * markers, and `scripts/readme-check.ts` fails when either page differs from it or a KPI of the catalog has no figure.
 * `bun scripts/readme-results.ts --refresh` reads the factory (7 days), rewrites the snapshot and both blocks; with no
 * flag it rewrites the blocks from the snapshot.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KPI_CATALOG_KEYS } from '../packages/contract/src/kpi-catalog.ts'

export const RESULTS_START = '<!-- results:start -->'
export const RESULTS_END = '<!-- results:end -->'

/** A KPI as the snapshot keeps it: its value, what it stands on and the target it was read against. */
export interface KpiFigure {
  value: number
  n: number | null
  count: number | null
  target: { kind: string; min: number | null; max: number | null }
}

/** What the factory said on one day: the window, the Issues and Decisions of it, and the seven KPIs. */
export interface Results {
  at: string
  window: { from: string; to: string }
  filed: number
  loopFiled: number
  closed: number
  decisionsAnswered: { judge: number; default: number; owner: number; orchestrator: number }
  kpis: Record<string, KpiFigure>
}

export const ROOT = join(import.meta.dir, '..')
/** The pages that carry the block, from the repo root. */
export const RESULT_PAGES = ['README.md', 'docs/guide/README.md'] as const

const number = (n: number): string => n.toLocaleString('en-US')
const percent = (share: number): string => `${(share * 100).toFixed(1)} %`
const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)} h`
const duration = (ms: number): string => (ms < 3 * 3_600_000 ? `${Math.round(ms / 60_000)} minutes` : hours(ms))

const targetOf = (kpi: KpiFigure, show: (v: number) => string): string => {
  const { kind, min, max } = kpi.target
  if (kind === 'at_most' && max !== null) return `the target is at most ${show(max)}`
  if (kind === 'at_least' && min !== null) return `the target is at least ${show(min)}`
  return 'no target yet'
}

/** The block both pages carry, markers included, rendered from the snapshot alone. */
export function renderResults(r: Results): string {
  const k = (key: string): KpiFigure => {
    const kpi = r.kpis[key]
    if (!kpi) throw new Error(`docs/results.json has no figure for the KPI ${key}`)
    return kpi
  }
  const answered = r.decisionsAnswered
  const total = answered.judge + answered.default + answered.owner + answered.orchestrator
  const touches = k('avoidable_touches')
  const passes = k('first_verification_passes')
  const specs = k('specs_not_needed')
  const errands = k('errands_reached_per_100')
  const cycle = k('cycle_p50')
  const queue = k('queue_wait_p90')
  const quota = k('quota_at_reset')
  const rows: [string, string][] = [
    ['Issues filed', `${number(r.filed)}, of which the factory's own loops filed ${number(r.loopFiled)}`],
    ['Issues closed', number(r.closed)],
    ['Median time from filed to closed', `${duration(cycle.value)} (${targetOf(cycle, hours)})`],
    ['Queue wait, 90th percentile', `${hours(queue.value)} (${targetOf(queue, hours)})`],
    [
      'First verifications that passed',
      `${percent(passes.value)} of ${number(passes.n ?? 0)} (${targetOf(passes, (v) => `${v * 100} %`)})`,
    ],
    [
      'Decisions answered',
      `${total}: the Judge ${answered.judge}, a default ${answered.default}, the owner ${answered.owner}, his delegate ${answered.orchestrator}`,
    ],
    [
      'Times the owner stepped in where the factory should have settled it',
      `${touches.count ?? 0} (${touches.value.toFixed(3)} per Issue filed by a person, an agent or an alert; ${targetOf(touches, (v) => String(v))})`,
    ],
    [
      'Specs the owner marked not needed',
      `${percent(specs.value)} of ${specs.n ?? 0} verdicts (${targetOf(specs, (v) => `${v * 100} %`)})`,
    ],
    [
      'Errands that reached the owner',
      `${errands.value.toFixed(1)} per 100 Issues (${errands.count ?? 0}; ${targetOf(errands, String)})`,
    ],
    [
      'Quota used at the weekly reset',
      `${percent(quota.value)} over ${quota.n ?? 0} resets (${targetOf(quota, (v) => `${v * 100} %`)})`,
    ],
  ]
  const lines = [
    RESULTS_START,
    `From ${utc(r.window.from)} (the counting epoch) to ${utc(r.window.to)}, all projects. Read on ${r.at.slice(0, 10)} with \`factory read kpis\` and \`factory read friction\`; \`bun scripts/readme-results.ts --refresh\` reads them again.`,
    '',
    '| What | Result |',
    '|-|-|',
    ...rows.map(([what, result]) => `| ${what} | ${result} |`),
    RESULTS_END,
  ]
  return lines.join('\n')
}

/** `text` with the block between the markers replaced by `block`; null when a marker is missing. */
export function withResults(text: string, block: string): string | null {
  const start = text.indexOf(RESULTS_START)
  const end = text.indexOf(RESULTS_END)
  if (start === -1 || end === -1 || end < start) return null
  return text.slice(0, start) + block + text.slice(end + RESULTS_END.length)
}

/** Every disagreement between a page's block, the snapshot and the KPI catalog. */
export function checkResults(page: string, text: string, results: Results): string[] {
  const missing = KPI_CATALOG_KEYS.filter((key) => !(key in results.kpis))
  if (missing.length)
    return [
      `docs/results.json: no figure for the KPI ${missing.join(', ')}. Run \`bun scripts/readme-results.ts --refresh\`.`,
    ]
  const next = withResults(text, renderResults(results))
  if (next === null) return [`${page}: no result block (${RESULTS_START} ... ${RESULTS_END}).`]
  if (next !== text)
    return [`${page}: the result numbers are not docs/results.json. Run \`bun scripts/readme-results.ts\`.`]
  return []
}

const run = async (...cmd: string[]): Promise<unknown> => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'inherit' })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`)
  return JSON.parse(out)
}

/** The snapshot from the factory's own reads over the last 7 days. */
async function readResults(): Promise<Results> {
  const kpis = (await run('factory', 'read', 'kpis', '--days', '7', '--format', 'json')) as {
    at: string
    window: { from: string; to: string }
    kpis: {
      key: string
      value: number
      n: number | null
      count: number | null
      target: KpiFigure['target']
      beside: { key: string; value: number }[]
    }[]
  }
  const friction = (await run('factory', 'read', 'friction', '--days', '7', '--format', 'json')) as {
    issues: number
    closed: number
    counts: { key: string; count: number }[]
  }
  const count = (key: string): number => friction.counts.find((c) => c.key === key)?.count ?? 0
  const touches = kpis.kpis.find((x) => x.key === 'avoidable_touches')
  return {
    at: kpis.at,
    window: kpis.window,
    filed: friction.issues,
    loopFiled: touches?.beside.find((b) => b.key === 'loop_filed')?.value ?? 0,
    closed: friction.closed,
    decisionsAnswered: {
      judge: count('decision_answered:judge'),
      default: count('decision_answered:default'),
      owner: count('decision_answered:owner'),
      orchestrator: count('decision_answered:orchestrator'),
    },
    kpis: Object.fromEntries(
      kpis.kpis.map((x) => [x.key, { value: x.value, n: x.n, count: x.count, target: x.target }]),
    ),
  }
}

if (import.meta.main) {
  const snapshot = join(ROOT, 'docs', 'results.json')
  if (process.argv.includes('--refresh')) await writeFile(snapshot, `${JSON.stringify(await readResults(), null, 2)}\n`)
  const block = renderResults(JSON.parse(await readFile(snapshot, 'utf8')) as Results)
  for (const page of RESULT_PAGES) {
    const text = await readFile(join(ROOT, page), 'utf8')
    const next = withResults(text, block)
    if (next === null) throw new Error(`${page} has no result block (${RESULTS_START} ... ${RESULTS_END})`)
    if (next !== text) await writeFile(join(ROOT, page), next)
  }
}
