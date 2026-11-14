import type { SQL } from 'bun'
import * as z from 'zod'
import type { ThroughputAnswers, ThroughputModel } from '@software-factory/contract'
import { OWNED_ELSEWHERE_KINDS } from '../kernel/throughput-limits.ts'
import type { QueueReasons } from './flow.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

const round = (value: number, decimals = 1) => Math.round(value * 10 ** decimals) / 10 ** decimals
const gib = (mib: number): string => `${round(mib / 1024)} GiB`
const hoursText = (hours: number): string => `${round(hours)} h`

/** What a queue reason is, in words (the kind's own name is in `byReason`). */
const REASON_WORDS: Record<string, string> = {
  memory: 'host memory',
  load: 'the host load',
  window: 'an account whose window is closed',
  cap: 'an account at its lead cap',
  lane: "a lane's cap",
  claim: 'a free claim in the repo',
  drain: 'a drain',
  boot: 'the boot grace',
}
const reasonWords = (kind: string): string => REASON_WORDS[kind] ?? kind

/** A lead that did not fit the free memory is a wait for memory too: both interval kinds are one reason here. */
const reasonOf = (kind: string): string => (kind === 'memory_fit' ? 'memory' : kind)

const LEVEL = new Map<number, ThroughputAnswers['host']['level']>([
  [1, 'normal'],
  [2, 'warning'],
  [4, 'critical'],
])

/** The UTC dates `[from, to]` touches, oldest first. */
export function utcDays(from: Date, to: Date): string[] {
  const days: string[] = []
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= to.getTime(); t += DAY_MS)
    days.push(new Date(t).toISOString().slice(0, 10))
  return days
}

interface Interval {
  kind: string
  issue: string
  from: Date
  to: Date | null
}

/** The hours queued per reason (and the Issues that waited), and the binding reason's hours per UTC day, clipped to `[from, to)`. */
export function queueHours(
  intervals: readonly Interval[],
  window: { from: Date; to: Date },
): {
  byReason: ThroughputAnswers['queue']['byReason']
  perDay: (kind: string) => ThroughputAnswers['queue']['perDay']
} {
  const clipped = (iv: Interval, start: number, end: number): number => {
    const a = Math.max(iv.from.getTime(), start, window.from.getTime())
    const b = Math.min((iv.to ?? window.to).getTime(), end, window.to.getTime())
    return Math.max(0, b - a) / HOUR_MS
  }
  const total = new Map<string, { hours: number; issues: Set<string> }>()
  for (const iv of intervals) {
    const kind = reasonOf(iv.kind)
    const hours = clipped(iv, -Infinity, Infinity)
    if (hours <= 0) continue
    const row = total.get(kind) ?? { hours: 0, issues: new Set<string>() }
    row.hours += hours
    row.issues.add(iv.issue)
    total.set(kind, row)
  }
  const byReason = [...total]
    .map(([kind, r]) => ({ kind, hours: round(r.hours, 2), issues: r.issues.size }))
    .toSorted((a, b) => b.hours - a.hours || a.kind.localeCompare(b.kind))
  const perDay = (kind: string) =>
    utcDays(window.from, window.to).map((day) => {
      const start = Date.parse(`${day}T00:00:00Z`)
      const hours = intervals
        .filter((iv) => reasonOf(iv.kind) === kind)
        .reduce((sum, iv) => sum + clipped(iv, start, start + DAY_MS), 0)
      return { day, hours: round(hours, 2) }
    })
  return { byReason, perDay }
}

type Findings = ThroughputModel['improvements']

/** The open improvement that costs most: still to be judged (`open`, or `shipped` waiting for its after), not one the epoch left unmeasured. */
export function topFinding(findings: Findings): Findings[number] | null {
  return (
    findings
      .filter((f) => f.status === 'open' || f.status === 'shipped')
      .toSorted((a, b) => b.costMinutes - a.costMinutes || a.id.localeCompare(b.id))[0] ?? null
  )
}

export interface AnswerFacts {
  window: { from: Date; to: Date }
  pressure: { normal: number; warning: number; critical: number; unread: number }
  /** the newest host minute of the window; null with none */
  newest: { level: number | null; swapUsedPct: number | null; memoryUsedPct: number | null } | null
  tenant: { budgetMib: number; footprintMib: number; over: boolean }
  /** the tenant class's mean MiB per UTC day (complete hours only) */
  tenantDays: { day: string; mib: number }[]
  intervals: readonly Interval[]
  findings: Findings
  queue: QueueReasons | null
}

/** The three answers from the window's facts. Pure: the page and the retro say the same words. */
export function answersOf(facts: AnswerFacts): ThroughputAnswers {
  const { pressure, newest } = facts
  const level = newest?.level == null ? 'unread' : (LEVEL.get(newest.level) ?? 'unread')
  const pressured = pressure.warning + pressure.critical
  const read = pressure.normal + pressured
  const waiting = [...(facts.queue?.values() ?? [])].find((r) => r.kind === 'memory') ?? null
  const limit = level === 'warning' || level === 'critical' || waiting !== null
  const swap = newest?.swapUsedPct == null ? null : `${round(newest.swapUsedPct)} % of RAM`
  const spell = read === 0 ? '' : ` ${pressured} of ${read} minutes in this window were at warning or critical.`
  const hostSentence =
    level === 'unread' && waiting === null
      ? 'The host read no memory pressure in this window.'
      : `${limit ? 'Yes' : 'No'}: memory pressure is ${level} now${swap ? `, swap ${swap}` : ''}${waiting ? `; an Issue waits for memory (${waiting.message})` : ''}.${spell}`

  const { byReason, perDay } = queueHours(
    facts.intervals.filter((iv) => !(OWNED_ELSEWHERE_KINDS as readonly string[]).includes(iv.kind)),
    facts.window,
  )
  const top = byReason[0] ?? null
  const binding = top ? { kind: top.kind, hours: top.hours, issues: top.issues } : null
  const queueSentence = binding
    ? `Queued Issues wait mostly for ${reasonWords(binding.kind)}: ${hoursText(binding.hours)} across ${binding.issues} ${binding.issues === 1 ? 'Issue' : 'Issues'}.`
    : 'No Issue waited for a cost of the factory in this window.'

  const over = facts.tenant.footprintMib - facts.tenant.budgetMib
  const finding = topFinding(facts.findings)
  const cost: ThroughputAnswers['cost'] = facts.tenant.over
    ? {
        kind: 'tenant',
        sentence: `Standing tenants hold ${gib(facts.tenant.footprintMib)} on average against a ${gib(facts.tenant.budgetMib)} budget: ${gib(over)} over.`,
        figure: over,
        unit: 'MiB',
        perDay: facts.tenantDays,
        budgetMib: facts.tenant.budgetMib,
        finding: null,
      }
    : finding
      ? {
          kind: 'improvement',
          sentence: `The largest open improvement is ${finding.project}, ${finding.kpi.replaceAll('_', ' ')}${finding.subject === '*' ? '' : ` of ${finding.subject}`}: ${Math.round(finding.costMinutes)} minutes of capacity.`,
          figure: finding.costMinutes,
          unit: 'minutes',
          perDay: [],
          budgetMib: facts.tenant.budgetMib,
          finding: {
            id: finding.id,
            project: finding.project,
            kpi: finding.kpi,
            subject: finding.subject,
            before: finding.before,
            target: finding.target,
            after: finding.after,
            unit: finding.unit,
            issue: finding.issue,
          },
        }
      : {
          kind: 'none',
          sentence: `Nothing open costs more than its target; tenants hold ${gib(facts.tenant.footprintMib)} of a ${gib(facts.tenant.budgetMib)} budget.`,
          figure: null,
          unit: null,
          perDay: facts.tenantDays,
          budgetMib: facts.tenant.budgetMib,
          finding: null,
        }

  return {
    host: {
      limit,
      level,
      sentence: hostSentence,
      swapUsedPct: newest?.swapUsedPct ?? null,
      memoryUsedPct: newest?.memoryUsedPct ?? null,
      pressuredMinutes: pressured,
      readMinutes: read,
      waitingFor: waiting?.message ?? null,
    },
    queue: {
      sentence: queueSentence,
      binding,
      perDay: binding ? perDay(binding.kind) : [],
      byReason,
    },
    cost,
  }
}

const Newest = z.object({
  level: z.coerce.number().nullable(),
  swap: z.coerce.number().nullable(),
  memory: z.coerce.number().nullable(),
})
const IntervalRow = z.object({
  kind: z.string(),
  issue_id: z.string(),
  from_at: z.coerce.date(),
  to_at: z.coerce.date().nullable(),
})
const DayRow = z.object({ day: z.string(), hours: z.coerce.number(), mib_minutes: z.coerce.number() })

/** What the answers read besides the model's own figures: the newest host minute, the queue intervals and the tenant class per day. */
export async function readAnswerFacts(
  tx: SQL,
  window: { from: Date; to: Date },
): Promise<Pick<AnswerFacts, 'newest' | 'intervals' | 'tenantDays'>> {
  const { from, to } = window
  const [newestRow] = await tx`
    SELECT pressure_level AS level, swap_used_pct::float8 AS swap, memory_used_pct::float8 AS memory
    FROM factory.host_samples WHERE at >= ${from} AND at < ${to} ORDER BY at DESC LIMIT 1`
  const intervalRows: unknown[] = await tx`
    SELECT kind, issue_id, from_at, to_at FROM factory.queue_intervals
    WHERE from_at < ${to} AND coalesce(to_at, ${to}) > ${from} ORDER BY from_at LIMIT 20000`
  const dayRows: unknown[] = await tx`
    SELECT to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(DISTINCT hour) AS hours,
      coalesce(sum(mib_minutes) FILTER (WHERE class = 'tenant'), 0)::float8 AS mib_minutes
    FROM factory.host_class_hours WHERE hour >= ${from} AND hour + interval '1 hour' <= ${to} GROUP BY 1 ORDER BY 1`
  const newest = newestRow ? Newest.parse(newestRow) : null
  return {
    newest: newest && { level: newest.level, swapUsedPct: newest.swap, memoryUsedPct: newest.memory },
    intervals: intervalRows
      .map((raw) => IntervalRow.parse(raw))
      .map((r) => ({ kind: r.kind, issue: r.issue_id, from: r.from_at, to: r.to_at })),
    tenantDays: dayRows
      .map((raw) => DayRow.parse(raw))
      .map((r) => ({ day: r.day, mib: r.hours === 0 ? 0 : Math.round(r.mib_minutes / (r.hours * 60)) })),
  }
}
