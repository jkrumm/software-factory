import { ArrowDownRightIcon, ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react'
import { PROJECT_SHIPPED_HOURS, type ProjectIndexRow, type ProjectMedian } from '@software-factory/contract'
import { LOZENGE_TONES } from '@/components/kit/lozenge'
import { MeterBar } from '@/components/kit/meter'
import { SegmentBar } from '@/components/kit/segment-bar'
import { Sparkline } from '@/components/kit/sparkline'
import { TONE_MARK, TONE_TEXT } from '@/components/kit/tone'
import {
  ageShort,
  durationShort,
  hygieneTone,
  LAMP_TONES,
  LAMP_WORDS,
  medianEmpty,
  openOf,
  productionOf,
  shippedOf,
  trendOf,
} from '@/lib/project-table'
import { cn } from '@/lib/utils'

/**
 * The cells of the Projects table, one per column: an in-cell visual from the kit and its figure, right-aligned in
 * tabular figures. A figure the server could not count reads as a dash with its reason on hover, never 0.
 */

const HOUR_MS = 3_600_000

/** "Tue, Nov 10, 22:39": the absolute time a relative one shows on hover. */
const absolute = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

function Figure({ children, title, className }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn('shrink-0 text-right whitespace-nowrap tabular-nums', className)}>
      {children}
    </span>
  )
}

function Dash({ why }: { why: string }) {
  return (
    <span title={why} aria-label={why} className="text-muted-foreground">
      &ndash;
    </span>
  )
}

/** The five words (`docs/language.md` "Where work stands") as one bar on the table's shared scale, and the open count. */
export function NowCell({ row, scale }: { row: ProjectIndexRow; scale: number }) {
  const { running, paused, ready, held, checking } = row.counts.work
  return (
    <div className="flex min-w-0 items-center gap-2">
      <SegmentBar
        name={`Open Issues of ${row.name}`}
        scale={scale}
        className="flex-1"
        segments={[
          { key: 'running', label: 'Running', value: running, tone: LOZENGE_TONES.running },
          { key: 'paused', label: 'Paused', value: paused, tone: LOZENGE_TONES.paused },
          { key: 'ready', label: 'Ready', value: ready, tone: LOZENGE_TONES.ready },
          { key: 'held', label: 'Held', value: held, tone: LOZENGE_TONES.held, faint: true },
          { key: 'checking', label: 'Checking', value: checking, tone: LOZENGE_TONES.checking, faint: true },
        ]}
      />
      <Figure className="w-6">{openOf(row) || <span className="text-muted-foreground">0</span>}</Figure>
    </div>
  )
}

/** The hour labels of the shipped line, oldest first: "Mon 14:00". */
export const hourLabels = (at: number): string[] =>
  Array.from({ length: PROJECT_SHIPPED_HOURS }, (_, i) => {
    const start = new Date(at - (PROJECT_SHIPPED_HOURS - i) * HOUR_MS)
    return start.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  })

/** Shipped per hour over 7 days as a line, and the 7-day count. */
export function ShippedCell({ row, labels }: { row: ProjectIndexRow; labels: string[] }) {
  const total = shippedOf(row)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        {total > 0 ? (
          <Sparkline
            compact
            values={row.shipped.hours}
            labels={labels}
            name={`Shipped per hour by ${row.name}`}
            format={(n) => `${n} shipped`}
            tone="neutral"
            height={20}
          />
        ) : (
          <div aria-hidden="true" className="h-px w-full" style={{ background: 'var(--vx-grid)' }} />
        )}
      </div>
      <Figure className="w-6">{total === 0 ? <span className="text-muted-foreground">0</span> : total}</Figure>
    </div>
  )
}

export function LastShipCell({ row, now }: { row: ProjectIndexRow; now: number }) {
  const last = row.shipped.lastAt
  if (!last) return <Dash why="Nothing shipped yet" />
  return (
    <Figure title={absolute(last)} className="font-mono text-xs">
      {ageShort(now - Date.parse(last))}
    </Figure>
  )
}

const TREND_ICON = { down: ArrowDownRightIcon, up: ArrowUpRightIcon, flat: ArrowRightIcon } as const

/** A median duration with its trend mark against the 7 days before (lower is better). */
export function MedianCell({ median, what }: { median: ProjectMedian; what: string }) {
  if (median.ms === null) return <Dash why={medianEmpty(median)} />
  const trend = trendOf(median)
  const title = `${what}, median of ${median.n} in the last 7 days${trend ? `, ${trend.words}` : ', none the 7 days before'}`
  const Icon = trend ? TREND_ICON[trend.direction] : null
  return (
    <span title={title} className="inline-flex items-center justify-end gap-1 whitespace-nowrap tabular-nums">
      {durationShort(median.ms)}
      {Icon && trend ? (
        <Icon
          weight="bold"
          aria-label={trend.direction === 'flat' ? 'unchanged' : trend.direction === 'down' ? 'faster' : 'slower'}
          className={cn('size-3.5', TONE_TEXT[trend.tone])}
        />
      ) : (
        <span className="inline-block size-3.5" aria-hidden="true" />
      )}
    </span>
  )
}

/** The production lamp: lit only for something live, with the age of what it shows. */
export function ProductionCell({ row, now }: { row: ProjectIndexRow; now: number }) {
  const { lamp, since } = productionOf(row)
  const words = LAMP_WORDS[lamp]
  const tone = LAMP_TONES[lamp]
  const title =
    since !== null
      ? `${words} since ${absolute(since)}`
      : lamp === 'checking'
        ? `${row.counts.work.checking} checking`
        : words
  return (
    <span title={title} className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
      <span
        role="img"
        aria-label={words}
        data-lamp={lamp}
        className="size-2 shrink-0 rounded-full"
        style={{
          background: TONE_MARK[tone],
        }}
      />
      <span
        className={cn('w-10 text-right font-mono text-xs tabular-nums', lamp === 'quiet' && 'text-muted-foreground')}
      >
        {since ? ageShort(now - Date.parse(since)) : lamp === 'checking' ? row.counts.work.checking : ''}
      </span>
    </span>
  )
}

/** Probes clean of run, and how long the oldest finding has been raised. */
export function HygieneCell({ row, now }: { row: ProjectIndexRow; now: number }) {
  const { clean, run, oldestFindingAt, lastPassAt } = row.hygiene
  if (!lastPassAt) return <Dash why="Never swept" />
  if (run === 0) return <Dash why="The newest pass ran no probe" />
  const tone = hygieneTone(row, now)
  const age = oldestFindingAt ? ageShort(now - Date.parse(oldestFindingAt)) : null
  return (
    <span
      title={`${clean} of ${run} probes clean in the pass of ${absolute(lastPassAt)}${oldestFindingAt ? `; the oldest finding raised since ${absolute(oldestFindingAt)}` : ''}`}
      className="inline-flex items-center justify-end gap-2 whitespace-nowrap tabular-nums"
    >
      <span className={cn(tone !== 'neutral' && TONE_TEXT[tone])}>
        {clean}/{run}
      </span>
      <span className={cn('w-10 text-right font-mono text-xs', age ? TONE_TEXT[tone] : 'text-muted-foreground')}>
        {age ?? ''}
      </span>
    </span>
  )
}

/** Plan rows done of all as a graphite meter: progress, not a ceiling, so it never takes a warn tone. */
export function PlanCell({ row }: { row: ProjectIndexRow }) {
  const { done, total } = row.plan
  if (total === 0)
    return (
      <span className="flex justify-end">
        <Dash why="No plan" />
      </span>
    )
  return (
    <div className="flex min-w-0 items-center gap-2" title={`${done} of ${total} plan rows done`}>
      <MeterBar value={done / total} tone="neutral" className="flex-1" />
      <Figure className="w-12">
        {done}/{total}
      </Figure>
    </div>
  )
}

/** Leads running in the project against the seats the host admits now. */
/** The queue state that applies to the project and its priority; a state other than run reads in the warn tone. */
export function QueueCell({ row }: { row: ProjectIndexRow }) {
  const { state, prio } = row.queue
  return (
    <span
      title={`queue ${state}, project priority ${prio}`}
      className="inline-flex items-center justify-end gap-2 whitespace-nowrap font-mono text-xs tabular-nums"
    >
      <span className={state === 'run' ? 'text-muted-foreground' : TONE_TEXT.warn}>{state}</span>
      <span className={prio === 0 ? 'text-muted-foreground' : undefined}>{prio}</span>
    </span>
  )
}

export function LeadsCell({ row, seats }: { row: ProjectIndexRow; seats: number | null }) {
  const { running, cap } = row.leads
  const ceiling = seats === null ? cap : cap === null ? seats : Math.min(cap, seats)
  const title = `${running} running${seats === null ? '' : `; the host admits ${seats} now`}${cap === null ? '' : `; the project allows ${cap}`}`
  return (
    <div className="flex min-w-0 items-center gap-2" title={title}>
      {ceiling ? <MeterBar value={running / ceiling} tone="neutral" className="flex-1" /> : <span className="flex-1" />}
      <Figure className="w-12">
        {running}
        {ceiling ? <span className="text-muted-foreground">/{ceiling}</span> : null}
      </Figure>
    </div>
  )
}
