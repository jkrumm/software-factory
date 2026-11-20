import type { CapacityLoopModel, ThroughputModel } from '@software-factory/contract'
import {
  ArmchairIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  CpuIcon,
  GaugeIcon,
  HardDrivesIcon,
  HourglassIcon,
  MemoryIcon,
  StackIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useWindowKeys } from '@/components/shortcuts'
import { type ReactNode, useState } from 'react'
import { Fold, InfoHint, MeterBar, Section, Sparkline, StatCard, TimeChart } from '@/components/kit'
import { TONE_TEXT, TONE_TINT } from '@/components/kit/tone'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection, useSidebarCollapsed } from '@/components/sidebar'
import { ThroughputSkeleton } from '@/components/skeletons'
import { useCapacityLoop, useThroughput } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'
import {
  CAPACITY_HINT,
  CLASS_LABEL,
  classRows,
  constantRows,
  DEFAULT_THROUGHPUT_WINDOW,
  dayLabels,
  dayValues,
  dayWords,
  dayXLabels,
  edgeSourceWords,
  epochLine,
  hostFigures,
  hostTrends,
  hoursWords,
  issueNumber,
  kpiLabel,
  kpiValue,
  leadsWords,
  levelHeight,
  levelWords,
  mibWords,
  msWords,
  percentWords,
  perDayWords,
  progress,
  queueWords,
  RECENT_SPAN,
  secondsWords,
  splitRows,
  stampWords,
  STATUS,
  THROUGHPUT_WINDOWS,
  throughputWindowOf,
  windowName,
} from '@/lib/throughput'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/throughput')({
  /** `hours` is one of the three windows; a missing or other value is the default and stays out of the URL. */
  validateSearch: (search: Record<string, unknown>): { hours?: number } =>
    search.hours === undefined ? {} : { hours: throughputWindowOf(search.hours) },
  component: Throughput,
})

type Model = ThroughputModel

const LINK =
  'rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:underline'
const TH = 'px-3 py-2 text-left text-xs font-medium text-muted-foreground'
const TD = 'px-3 py-2 align-middle'
const NUM = 'text-right tabular-nums'

function WindowSwitch({ hours }: { hours: number }) {
  const collapsed = useSidebarCollapsed()
  return (
    <nav aria-label="Window" className={cn('mb-6 flex gap-2', !collapsed && 'md:hidden')}>
      {THROUGHPUT_WINDOWS.map((choice) => (
        <Link
          key={choice}
          to="/throughput"
          search={{ hours: choice }}
          aria-current={choice === hours ? 'page' : undefined}
          className={cn(buttonVariants({ variant: choice === hours ? 'secondary' : 'outline', size: 'sm' }))}
        >
          {windowName(choice)}
        </Link>
      ))}
    </nav>
  )
}

function WindowSection({ hours }: { hours: number }) {
  return (
    <SidebarSection title="Window">
      {THROUGHPUT_WINDOWS.map((choice) => (
        <SidebarEntry
          key={choice}
          label={windowName(choice)}
          current={choice === hours}
          render={(props) => <Link to="/throughput" search={{ hours: choice }} {...props} />}
        />
      ))}
    </SidebarSection>
  )
}

/** A table in a container that scrolls on its own when the viewport is too narrow for it, hairlines between rows only. */
function Table({
  label,
  head,
  children,
  narrow,
}: {
  label: string
  head: ReactNode
  children: ReactNode
  /** The table fits its column: no minimum width, long names wrap. */
  narrow?: boolean
}) {
  return (
    <div className="overflow-x-auto rounded-xl bg-card">
      <table aria-label={label} className={cn('w-full text-[length:var(--vx-text-sm)]', !narrow && 'min-w-max')}>
        <thead>
          <tr className="border-b">{head}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  )
}

/** An empty panel: `children` is why, `next` the first step (a longer window is the usual one). */
function Nothing({ children, next = 'Choose a longer window above.' }: { children: string; next?: string }) {
  return (
    <EmptyState title={children} icon={CpuIcon}>
      {next}
    </EmptyState>
  )
}

const dash = (value: number | null, format: (v: number) => string): string => (value === null ? '–' : format(value))

const HOST_TREND_NAME = { cpu: 'CPU busy', memory: 'Memory used', swap: 'Swap used', load: 'Load' } as const

const LEVEL_NAME = { normal: 'Normal', warning: 'Warning', critical: 'Critical', unread: 'Not read' } as const

/** The host now, as numbers: CPU, memory and swap as amounts, the kernel's pressure, and the load against its ceiling. */
function HostRow({ model }: { model: Model }) {
  const figures = hostFigures(model)
  const points = model.host.timeline.points
  const times = points.map((p) => new Date(p.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))
  const over = windowName(model.hours)
  const trends = hostTrends(model)
  const hasTrend = model.host.recent.length > 0
  /** the gauge against its ceiling, and under it the last minutes: the dot is the minute the card's figure reads */
  const bar = (key: 'cpu' | 'memory' | 'swap' | 'load') => {
    const { fill, tone } = figures[key]
    const { values, labels, format } = trends[key]
    return (
      <>
        {fill === null ? null : <MeterBar value={Math.min(1, Math.max(0, fill))} tone={tone} />}
        {hasTrend ? (
          <Sparkline
            name={`${HOST_TREND_NAME[key]}, ${RECENT_SPAN}`}
            values={values}
            labels={labels}
            format={format}
            tone={tone}
            height={40}
          />
        ) : null}
      </>
    )
  }
  const trendLabels: [string, string, string] | undefined = hasTrend
    ? ['−15 min', `(${RECENT_SPAN})`, 'now']
    : undefined
  return (
    <section aria-labelledby="throughput-host-now" className="min-w-0">
      <h2 id="throughput-host-now" className="sr-only">
        The host now
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 @7xl:grid-cols-5">
        <StatCard
          id="throughput-cpu"
          icon={CpuIcon}
          title="CPU busy"
          hint="cpu busy"
          subtitle="Share of all cores, newest minute"
          value={figures.cpu.value}
          valueNote={figures.cpu.valueNote}
          sub={figures.cpu.sub}
          chart={bar('cpu')}
          xLabels={trendLabels}
        />
        <StatCard
          id="throughput-memory"
          icon={MemoryIcon}
          title="Memory used"
          hint="memory used"
          subtitle="Of the RAM installed, newest minute"
          value={figures.memory.value}
          valueNote={figures.memory.valueNote}
          sub={figures.memory.sub}
          chart={bar('memory')}
          xLabels={trendLabels}
        />
        <StatCard
          id="throughput-swap"
          icon={HardDrivesIcon}
          title="Swap used"
          hint="swap used"
          subtitle="Of the swap file, newest minute"
          value={figures.swap.value}
          valueNote={figures.swap.valueNote}
          sub={figures.swap.sub}
          chart={bar('swap')}
          xLabels={trendLabels}
        />
        <StatCard
          id="throughput-pressure"
          icon={WarningIcon}
          title="Memory pressure"
          hint="memory pressure"
          subtitle={`Kernel verdict, ${over}`}
          value={figures.pressure.value}
          valueNote={figures.pressure.valueNote}
          sub={figures.pressure.sub}
          chart={
            <Sparkline
              name="Memory pressure"
              values={points.map((p) => levelHeight(p.pressureLevel))}
              labels={points.map((p, i) => `${levelWords(p.pressureLevel)}, ${times[i]}`)}
              format={(v) => (v >= 2 ? 'Critical' : v >= 1 ? 'Warning' : 'Normal')}
              tone={figures.pressure.tone}
            />
          }
        />
        <StatCard
          id="throughput-load"
          icon={GaugeIcon}
          title="Load"
          hint="load"
          subtitle="Threads wanting a core, per minute"
          value={figures.load.value}
          valueNote={figures.load.valueNote}
          sub={figures.load.sub}
          chart={bar('load')}
          xLabels={trendLabels}
        />
      </div>
    </section>
  )
}

/** The three answers, in order, each a question, one sentence, one figure and its trend. The server wrote the sentences. */
function Answers({ model }: { model: Model }) {
  const { answers } = model
  const { host, queue, cost } = answers
  const costDays = cost.perDay
  return (
    <section aria-labelledby="throughput-answers" className="min-w-0">
      <h2 id="throughput-answers" className="sr-only">
        The three answers
      </h2>
      <div className="grid gap-4 lg:grid-cols-3">
        <StatCard
          id="throughput-host"
          icon={WarningIcon}
          title="Is the host the limit right now?"
          hint="memory pressure"
          subtitle={`Memory pressure over ${windowName(model.hours)}`}
          value={host.level === 'unread' ? null : LEVEL_NAME[host.level]}
          valueNote="The host read no pressure level in this window"
          delta={
            host.level === 'unread'
              ? undefined
              : host.limit
                ? { value: 'The limit', tone: 'bad', direction: 1 }
                : { value: 'Not the limit', tone: 'good', direction: 0 }
          }
          sub={host.sentence}
          chart={null}
        />
        <StatCard
          id="throughput-queue"
          icon={HourglassIcon}
          title="What keeps Issues from starting?"
          hint="binding reason"
          subtitle={`Hours in the queue over ${windowName(model.hours)}`}
          value={queue.binding ? hoursWords(queue.binding.hours) : null}
          valueNote="No Issue waited for a cost of the factory in this window"
          sub={queue.sentence}
          chart={
            queue.binding ? (
              <Sparkline
                name={`Hours in the queue for ${queueWords(queue.binding.kind)}`}
                values={queue.perDay.map((d) => d.hours)}
                labels={queue.perDay.map((d) => dayWords(d.day))}
                format={hoursWords}
              />
            ) : null
          }
          footer={[
            { label: 'Binding reason', value: queue.binding ? queueWords(queue.binding.kind) : null, note: 'None' },
            { label: 'Issues', value: queue.binding ? String(queue.binding.issues) : null, note: 'None' },
          ]}
        />
        <StatCard
          id="throughput-cost"
          icon={StackIcon}
          title="What is the largest avoidable cost?"
          hint="avoidable cost"
          subtitle={
            cost.kind === 'improvement' ? 'The open improvement that costs most' : 'Tenants against their budget'
          }
          value={
            cost.figure === null
              ? null
              : cost.unit === 'MiB'
                ? `${mibWords(cost.figure)} over`
                : `${Math.round(cost.figure)} min`
          }
          valueNote="Nothing open costs more than its target"
          sub={cost.sentence}
          chart={
            cost.finding ? (
              <FindingProgress finding={cost.finding} />
            ) : costDays.length > 0 ? (
              <Sparkline
                name="Standing tenant memory against its budget"
                values={costDays.map((d) => d.mib)}
                labels={costDays.map((d) => dayWords(d.day))}
                format={mibWords}
                target={cost.budgetMib}
                tone={cost.kind === 'tenant' ? 'warn' : 'neutral'}
              />
            ) : null
          }
          footer={
            cost.finding
              ? [
                  { label: 'Project', value: cost.finding.project },
                  { label: 'Measures', value: kpiLabel(cost.finding.kpi) },
                ]
              : [
                  { label: 'Budget', value: mibWords(cost.budgetMib) },
                  { label: 'Tenants hold', value: mibWords(model.host.tenantBudget.footprintMib) },
                ]
          }
        />
      </div>
    </section>
  )
}

const CAPACITY_TITLE = {
  throughput: 'Issues closed',
  idle: 'Idle seat-hours with work ready',
  over: 'Minutes over the load ceiling',
  wait: 'Test slot wait',
} as const

/** The idle seat-hours of each day with the drained queue's share taken out. */
const notDrainPerDay = (model: CapacityLoopModel) =>
  model.idleSeatHours.perDay.map((d) => ({
    day: d.day,
    value: Math.max(0, (d.value ?? 0) - (model.idleSeatHoursDrain.perDay.find((x) => x.day === d.day)?.value ?? 0)),
  }))

/** What the capacity loop did over the window: Issues closed, idle seats, minutes over the load ceiling, test slot wait. */
function CapacityCards({ model }: { model: CapacityLoopModel }) {
  const { constants } = model
  const subtitle = `${model.days} ${model.days === 1 ? 'day' : 'days'}, UTC days`
  const wait = model.slotWait
  const notDrain = notDrainPerDay(model)
  const spark = (points: CapacityLoopModel['throughput']['perDay'], name: string, format: (v: number) => string) => (
    <Sparkline values={dayValues(points)} labels={dayLabels(points)} tone="neutral" name={name} format={format} />
  )
  return (
    <section aria-labelledby="throughput-capacity" className="min-w-0">
      <h2 id="throughput-capacity" className="sr-only">
        Capacity
      </h2>
      <div aria-label="Capacity figures" role="group" className="grid gap-4 sm:grid-cols-2 @7xl:grid-cols-4">
        <StatCard
          icon={CheckCircleIcon}
          title={CAPACITY_TITLE.throughput}
          hint="issues closed"
          subtitle={subtitle}
          value={perDayWords(model.throughput.total, model.days)}
          sub={`${model.throughput.total} closed in the window`}
          chart={spark(model.throughput.perDay, 'Issues closed per day', (v) => `${v} closed`)}
          xLabels={dayXLabels(model.throughput.perDay)}
          footer={[
            { label: 'Closed', value: String(model.throughput.total) },
            { label: 'Window', value: `${model.days} ${model.days === 1 ? 'day' : 'days'}` },
          ]}
        />
        <StatCard
          icon={ArmchairIcon}
          title={CAPACITY_TITLE.idle}
          hint="idle seat-hours"
          subtitle={subtitle}
          value={hoursWords(Math.max(0, model.idleSeatHours.total - model.idleSeatHoursDrain.total))}
          sub={`Seats no lead held while Issues waited; ${hoursWords(model.idleSeatHoursDrain.total)} behind a drained queue left out`}
          chart={spark(notDrain, 'Idle seat-hours per day', hoursWords)}
          xLabels={dayXLabels(model.idleSeatHours.perDay)}
          footer={[
            { label: 'Leads per account', value: leadsWords(constants) },
            { label: 'Seat bonus at most', value: String(constants.seatsMaxBonus) },
          ]}
        />
        <StatCard
          icon={GaugeIcon}
          title={CAPACITY_TITLE.over}
          hint="load ceiling"
          subtitle={subtitle}
          value={String(model.minutesOverCeiling.total)}
          sub="Host minutes above the ceiling in force"
          chart={spark(model.minutesOverCeiling.perDay, 'Minutes over the load ceiling per day', (v) => `${v} min`)}
          xLabels={dayXLabels(model.minutesOverCeiling.perDay)}
          footer={[
            { label: 'Load ceiling', value: String(constants.loadCeiling) },
            { label: 'Extra slot below load', value: String(constants.slotExtraLoad) },
          ]}
        />
        <StatCard
          icon={HourglassIcon}
          title={CAPACITY_TITLE.wait}
          hint="test slot wait"
          subtitle={subtitle}
          value={wait.n === 0 ? 'No data' : msWords(wait.p50Ms)}
          sub={wait.n === 0 ? 'No steps recorded yet' : `Median; 90th percentile ${msWords(wait.p90Ms)}`}
          chart={wait.n === 0 ? null : spark(wait.perDayP50, 'Median test slot wait per day', msWords)}
          xLabels={wait.n === 0 ? undefined : dayXLabels(wait.perDayP50)}
          footer={[
            {
              label: '90th percentile',
              value: wait.n === 0 ? null : msWords(wait.p90Ms),
              note: 'No steps recorded yet',
            },
            { label: 'Steps recorded', value: String(wait.n) },
          ]}
        />
      </div>
    </section>
  )
}

/** The test-slot steps that peaked highest, and the `after` edges the factory added against the files the Issues shared. */
function CapacityTables({ model }: { model: CapacityLoopModel }) {
  return (
    <div className="grid gap-8">
      <Section
        level={3}
        title="Steps by peak memory"
        aside="Test-slot steps with the largest peak memory in the window"
      >
        {model.topSteps.length === 0 ? (
          <Nothing>No steps recorded yet.</Nothing>
        ) : (
          <Table
            label="Test-slot steps with the largest peak memory in the window"
            head={
              <>
                <th className={TH}>Step</th>
                <th className={cn(TH, NUM)}>Runs</th>
                <th className={cn(TH, NUM)}>Peak</th>
                <th className={cn(TH, NUM)}>80th pct</th>
                <th className={cn(TH, NUM)}>Duration</th>
                <th className={cn(TH, NUM)}>Wait</th>
              </>
            }
          >
            {model.topSteps.map((step) => (
              <tr key={step.name}>
                <th scope="row" className={cn(TD, 'text-left font-medium')}>
                  {step.name}
                </th>
                <td className={cn(TD, NUM)}>{step.runs}</td>
                <td className={cn(TD, NUM)}>{mibWords(step.maxPeakMib)}</td>
                <td className={cn(TD, NUM)}>{mibWords(step.p80PeakMib)}</td>
                <td className={cn(TD, NUM)}>{msWords(step.medianDurationMs)}</td>
                <td className={cn(TD, NUM)}>{msWords(step.medianWaitMs)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section
        level={3}
        title="Edges by shared files"
        aside="After edges that triage and the queue loop added, and whether the two Issues touched a file in common"
      >
        {model.edges.bySource.length === 0 ? (
          <Nothing>No edge added in the window.</Nothing>
        ) : (
          <Table
            label="After edges the factory added, by who added them"
            head={
              <>
                <th className={TH}>Added by</th>
                <th className={cn(TH, NUM)}>Edges</th>
                <th className={cn(TH, NUM)}>Needed</th>
                <th className={cn(TH, NUM)}>Not needed</th>
                <th className={cn(TH, NUM)}>Not measured</th>
                <th className={cn(TH, NUM)}>Taken back</th>
                <th className={cn(TH, NUM)}>Share not needed</th>
              </>
            }
          >
            {model.edges.bySource.map((source) => (
              <tr key={source.source}>
                <th scope="row" className={cn(TD, 'text-left font-medium')}>
                  {edgeSourceWords(source.source)}
                  {source.stopped ? ' (no new edges)' : ''}
                </th>
                <td className={cn(TD, NUM)}>{source.added}</td>
                <td className={cn(TD, NUM)}>{source.needed}</td>
                <td className={cn(TD, NUM)}>{source.notNeeded}</td>
                <td className={cn(TD, NUM)}>{source.unknown}</td>
                <td className={cn(TD, NUM)}>{source.removed}</td>
                <td className={cn(TD, NUM)}>
                  {source.notNeededShare === null ? 'none measured' : percentWords(source.notNeededShare)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <CapacityReaped model={model} />
      <dl aria-label="Settings in force" className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        {constantRows(model.constants).map((row) => (
          <div key={row.key} className="flex gap-1.5">
            <dt>{row.label}</dt>
            <dd className="text-foreground tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function CapacityReaped({ model }: { model: CapacityLoopModel }) {
  const newest = model.reaped.newest[0]
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
      <span>
        <span className="text-foreground tabular-nums">{model.reaped.total}</span> processes of closed attempts ended by
        the
      </span>
      <span className="inline-flex items-center">
        reaper
        <InfoHint word={CAPACITY_HINT.reaped} className="-my-1" />
      </span>
      <span>
        {newest
          ? `in the window; the newest ${newest.comm} (by ${newest.reason}) at ${stampWords(newest.at)}`
          : 'in the window'}
      </span>
    </p>
  )
}

/** An improvement's way from its before to its target, the after where one is read. */
function FindingProgress({ finding }: { finding: NonNullable<Model['answers']['cost']['finding']> }) {
  const done = progress(finding)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 text-[length:var(--vx-text-sm)] tabular-nums">
        <span>{kpiValue(finding.kpi, finding.before)}</span>
        <ArrowRightIcon aria-hidden="true" className="size-3 text-muted-foreground" />
        <span className="text-muted-foreground">target {kpiValue(finding.kpi, finding.target)}</span>
        <ArrowRightIcon aria-hidden="true" className="size-3 text-muted-foreground" />
        <span className="font-medium">
          {finding.after === null ? 'not read' : kpiValue(finding.kpi, finding.after)}
        </span>
      </div>
      <MeterBar value={done === null ? 0 : Math.max(0, Math.min(1, done))} tone="neutral" />
    </div>
  )
}

/** One detail, closed until opened; its body is not drawn while closed, so a chart measures itself when it appears. */
function Detail({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Fold title={title} count={count} open={open} onOpenChange={setOpen}>
      {open ? children : null}
    </Fold>
  )
}

function Classes({ model }: { model: Model }) {
  const rows = classRows(model)
  const empty = model.host.minutes === 0
  return (
    <Section level={3} title="Memory by class" aside={`Mean footprint over ${model.host.minutes} minutes read`}>
      {empty ? (
        <Nothing>The host loop recorded no minute in this window.</Nothing>
      ) : (
        <Table
          label="Footprint by process class"
          head={
            <>
              <th className={TH}>Class</th>
              <th className={cn(TH, 'w-[34%]')}>Share of the footprint</th>
              <th className={cn(TH, NUM)}>Mean</th>
              <th className={cn(TH, NUM)}>Peak</th>
            </>
          }
        >
          {rows.map((row) => (
            <tr key={row.class} data-class={row.class}>
              <th scope="row" className={cn(TD, 'text-left font-medium')}>
                {row.label}
              </th>
              <td className={TD}>
                <div className="flex items-center gap-3">
                  <MeterBar value={row.share} tone="neutral" className="min-w-24 flex-1" />
                  <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">
                    {percentWords(row.share)}
                  </span>
                </div>
              </td>
              <td className={cn(TD, NUM)}>{mibWords(row.footprintMib)}</td>
              <td className={cn(TD, NUM)}>{mibWords(row.peakMib)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  )
}

function Ranked({
  label,
  head,
  rows,
  empty,
}: {
  label: string
  head: string
  rows: { key: string; name: ReactNode; mean?: number; peak: number; note?: string }[]
  empty: string
}) {
  const top = Math.max(1, ...rows.map((r) => r.peak))
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[length:var(--vx-text-sm)] font-medium text-muted-foreground">{head}</h3>
      {rows.length === 0 ? (
        <Nothing>{empty}</Nothing>
      ) : (
        <Table
          narrow
          label={label}
          head={
            <>
              <th className={TH}>Name</th>
              <th className={cn(TH, 'w-[34%]')}>Peak</th>
              <th className={cn(TH, NUM)}>Mean</th>
            </>
          }
        >
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={cn(TD, 'min-w-0 text-left font-medium break-words')}>
                {row.name}
                {row.note ? <span className="block text-xs font-normal text-muted-foreground">{row.note}</span> : null}
              </th>
              <td className={TD}>
                <div className="flex items-center gap-2">
                  <MeterBar value={row.peak / top} tone="neutral" className="min-w-12 flex-1" />
                  <span className="w-16 shrink-0 text-right tabular-nums">{mibWords(row.peak)}</span>
                </div>
              </td>
              <td className={cn(TD, NUM)}>{row.mean === undefined ? '–' : mibWords(row.mean)}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

function Tenants({ model }: { model: Model }) {
  const { byTenant, byRepo, tenantBudget } = model.host
  const budgetNote = `${mibWords(tenantBudget.footprintMib)} on average of a ${mibWords(tenantBudget.budgetMib)} budget${tenantBudget.over ? ', over it' : ''}`
  return (
    <Section level={3} title="Where it goes" aside="Largest first, by peak memory">
      <div className="grid gap-6 @container lg:grid-cols-2">
        <Ranked
          label="Memory by tenant"
          head={`Tenants: ${budgetNote}`}
          empty="No tenant held memory."
          rows={byTenant.map((t) => ({ key: t.tenant, name: t.tenant, mean: t.footprintMib, peak: t.peakMib }))}
        />
        <Ranked
          label="Memory by project"
          head="Projects (leads and check steps)"
          empty="No lead or step held memory."
          rows={byRepo.map((r) => ({
            key: r.repo,
            name: (
              <Link to="/projects/$name" params={{ name: r.repo }} className={LINK}>
                {r.repo}
              </Link>
            ),
            mean: r.footprintMib,
            peak: r.peakMib,
            note: `leads ${mibWords(r.leadMib)}, steps ${mibWords(r.stepMib)}`,
          }))}
        />
      </div>
    </Section>
  )
}

/** The five processes with the largest peak: what to look at when the host is the limit. */
function Processes({ model }: { model: Model }) {
  return (
    <Section level={3} title="Largest processes" aside="By peak memory">
      <Ranked
        label="Notable processes"
        head="Processes"
        empty="No notable process."
        rows={model.host.topProcesses.slice(0, 5).map((p, i) => ({
          key: `${i}-${p.name}-${p.class}-${p.repo ?? ''}-${p.tenant ?? ''}`,
          name: p.name,
          peak: p.peakMib,
          note: [
            CLASS_LABEL[p.class] ?? p.class,
            p.repo ?? p.tenant,
            p.grownMib === null ? null : `grew ${mibWords(p.grownMib)}`,
          ]
            .filter(Boolean)
            .join(', '),
        }))}
      />
    </Section>
  )
}

function Timeline({ model }: { model: Model }) {
  const { points, bucketMinutes } = model.host.timeline
  const times = points.map((p) => new Date(p.at).getTime())
  const { now } = model.host
  const gb = (bytes: number | null) => (bytes === null ? null : bytes / 1024 ** 3)
  const charts = [
    {
      name: 'CPU busy, share of all cores',
      series: [{ name: 'CPU', values: points.map((p) => p.cpuBusyPct), tone: 'accent' as const, area: true }],
      format: (v: number) => `${v.toFixed(0)} %`,
      reference: 100,
    },
    {
      name: 'Memory used, GB',
      series: [
        { name: 'Memory', values: points.map((p) => gb(p.memoryUsedBytes)), tone: 'neutral' as const, area: true },
      ],
      format: (v: number) => `${v.toFixed(1)} GB`,
      reference: gb(now?.ramBytes ?? null) ?? undefined,
    },
    {
      name: 'Swap used, GB',
      series: [{ name: 'Swap', values: points.map((p) => gb(p.swapUsedBytes)), tone: 'accent' as const, area: true }],
      format: (v: number) => `${v.toFixed(1)} GB`,
    },
    {
      name: 'Memory pressure',
      series: [
        {
          name: 'Pressure',
          values: points.map((p) => levelHeight(p.pressureLevel)),
          tone: 'warn' as const,
          area: true,
        },
      ],
      format: (v: number) => (v >= 2 ? 'Critical' : v >= 1 ? 'Warning' : 'Normal'),
    },
    {
      name: 'Load average',
      series: [{ name: 'Load', values: points.map((p) => p.load), tone: 'neutral' as const, area: true }],
      format: (v: number) => v.toFixed(1),
      reference: now?.loadCeiling ?? undefined,
    },
  ]
  return (
    <Section
      level={3}
      title="CPU, memory, swap, pressure and load"
      aside={`${bucketMinutes}-minute buckets, the busiest minute of each`}
    >
      {points.length === 0 ? (
        <Nothing>The host recorded no minute in this window.</Nothing>
      ) : (
        <div className="grid gap-6 lg:grid-cols-6">
          {charts.map((chart, i) => (
            <div
              key={chart.name}
              className={cn('min-w-0 rounded-xl bg-card p-4', i < 3 ? 'lg:col-span-2' : 'lg:col-span-3')}
            >
              <h3 className="mb-2 text-[length:var(--vx-text-sm)] font-medium text-muted-foreground">{chart.name}</h3>
              <TimeChart
                name={chart.name}
                times={times}
                series={chart.series}
                format={chart.format}
                reference={chart.reference}
                height={96}
              />
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/** What each queue reason cost over the window, most first. */
function Reasons({ model }: { model: Model }) {
  const { byReason } = model.answers.queue
  return (
    <Section level={3} title="What each reason cost" aside="Hours in the queue in the window">
      {byReason.length === 0 ? (
        <Nothing>No Issue waited for a cost of the factory in this window.</Nothing>
      ) : (
        <Table
          narrow
          label="Hours in the queue by reason"
          head={
            <>
              <th className={TH}>Reason</th>
              <th className={cn(TH, NUM)}>Hours</th>
              <th className={cn(TH, NUM)}>Issues</th>
            </>
          }
        >
          {byReason.map((r) => (
            <tr key={r.kind} data-reason={r.kind}>
              <th scope="row" className={cn(TD, 'text-left font-medium')}>
                {queueWords(r.kind)}
              </th>
              <td className={cn(TD, NUM)}>{hoursWords(r.hours)}</td>
              <td className={cn(TD, NUM)}>{r.issues}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  )
}

function LeadTime({ model }: { model: Model }) {
  const { lead } = model
  const rows = splitRows(lead.split)
  return (
    <Section
      level={3}
      title="Where a lead's time goes"
      aside={`${lead.closed} ${lead.closed === 1 ? 'Issue' : 'Issues'} closed, ${secondsWords(lead.wallSeconds)} of wall time`}
    >
      {lead.closed === 0 ? (
        <Nothing>No Issue with a lead closed in this window.</Nothing>
      ) : (
        <div className="min-w-0 rounded-xl bg-card p-4">
          <div
            role="img"
            aria-label={`Lead time: ${rows.map((r) => `${r.label} ${percentWords(r.share)}`).join(', ')}`}
            className="flex h-5 gap-0.5 overflow-hidden rounded-md"
          >
            {rows
              .filter((r) => r.share > 0)
              .map((r) => (
                <div
                  key={r.key}
                  title={`${r.label}: ${secondsWords(r.seconds)}, ${percentWords(r.share)}`}
                  className="h-full min-w-0.5"
                  style={{ width: `${r.share * 100}%`, background: `var(--vx-series-${r.slot})` }}
                />
              ))}
          </div>
          <ul className="mt-4 grid gap-2 lg:grid-cols-2">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center gap-2 text-[length:var(--vx-text-sm)]">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: `var(--vx-series-${r.slot})` }}
                />
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <span className="tabular-nums">{secondsWords(r.seconds)}</span>
                <span className="w-10 text-right text-muted-foreground tabular-nums">{percentWords(r.share)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

/** The slot minutes per closed Issue over the window, with the counts it comes from: the line above the scorecard. */
function scorecardAside(model: Model): string {
  const slotMinutes = model.project.reduce((sum, p) => sum + p.slot.minutes, 0)
  const closed = model.project.reduce((sum, p) => sum + p.closedIssues, 0)
  return closed === 0
    ? 'No Issue closed in this window'
    : `${(slotMinutes / closed).toFixed(1)} slot minutes per closed Issue (${Math.round(slotMinutes)} over ${closed})`
}

function Scorecard({ model }: { model: Model }) {
  return (
    <Section level={3} title="Project scorecard" aside={scorecardAside(model)}>
      {model.project.length === 0 ? (
        <Nothing>No project closed an Issue, ran a step or finished a CI run in this window.</Nothing>
      ) : (
        <Table
          label="One row per project"
          head={
            <>
              <th className={TH}>Project</th>
              <th className={cn(TH, NUM)}>Closed</th>
              <th className={cn(TH, NUM)}>Slot min / Issue</th>
              <th className={TH}>Check p50 / p90</th>
              <th className={cn(TH, NUM)}>Failed min</th>
              <th className={cn(TH, NUM)}>Lead time</th>
            </>
          }
        >
          {model.project.map((p) => (
            <tr key={p.repo}>
              <th scope="row" className={cn(TD, 'text-left font-medium')}>
                <Link to="/projects/$name" params={{ name: p.repo }} className={LINK}>
                  {p.repo}
                </Link>
              </th>
              <td className={cn(TD, NUM)}>{p.closedIssues}</td>
              <td className={cn(TD, NUM)}>{dash(p.slot.minutesPerClosedIssue, (v) => v.toFixed(1))}</td>
              <td className={cn(TD, 'tabular-nums')}>
                {p.check.tiers.length === 0
                  ? '–'
                  : p.check.tiers
                      .slice(0, 2)
                      .map((t) => `${t.tier} ${msWords(t.p50Ms)} / ${msWords(t.p90Ms)}`)
                      .join(', ')}
              </td>
              <td className={cn(TD, NUM)}>{p.slot.failedMinutes.toFixed(1)}</td>
              <td className={cn(TD, NUM)}>
                {p.leadTime.closed === 0 ? '–' : secondsWords(p.leadTime.wallSeconds / p.leadTime.closed)}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  )
}

const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`

/** The steps their project declared remote: where they ran, why the mini kept them, the hold, and the pressure line. */
function RemoteSteps({ model }: { model: Model }) {
  const { pressure, steps } = model.tests.remote
  const baseline = pressure.baseline
  return (
    <div className="mt-6 grid gap-3">
      <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">
        {`Production pressure line: memory ${pressure.memoryPct} %, io ${pressure.ioPct} % of the last 10 s, `}
        {pressure.from === 'baseline' && baseline
          ? `from ${baseline.samples} samples over ${baseline.spanHours} h with no step running (p99 memory ${baseline.memoryP99} %, io ${baseline.ioP99} %).`
          : baseline
            ? `the default until a day of samples exists (${baseline.samples} so far over ${baseline.spanHours} h, p99 memory ${baseline.memoryP99} %, io ${baseline.ioP99} %).`
            : 'the default until a day of samples with no step running exists (none yet).'}
      </p>
      {steps.length === 0 ? (
        <Nothing>No step declared remote was placed in this window.</Nothing>
      ) : (
        <Table
          label="One row per step declared remote"
          head={
            <>
              <th className={TH}>Step</th>
              <th className={cn(TH, NUM)}>Runs VPS</th>
              <th className={cn(TH, NUM)}>Runs mini</th>
              <th className={cn(TH, NUM)}>Placed VPS</th>
              <th className={cn(TH, NUM)}>Mini, slot free</th>
              <th className={cn(TH, NUM)}>Mini, no room</th>
              <th className={cn(TH, NUM)}>Mini, not sooner</th>
              <th className={cn(TH, NUM)}>Mini, held</th>
              <th className={TH}>Hold</th>
            </>
          }
        >
          {steps.map((r) => (
            <tr key={r.step}>
              <th scope="row" className={cn(TD, 'text-left font-medium')}>
                {r.step}
              </th>
              <td className={cn(TD, NUM)}>{r.vpsRuns}</td>
              <td className={cn(TD, NUM)}>{r.miniRuns}</td>
              <td className={cn(TD, NUM)}>{r.placed.vps}</td>
              <td className={cn(TD, NUM)}>{r.placed.free}</td>
              <td className={cn(TD, NUM)}>{r.placed.noRoom}</td>
              <td className={cn(TD, NUM)}>{r.placed.notSooner}</td>
              <td className={cn(TD, NUM)}>{r.placed.held}</td>
              <td className={TD}>
                {r.hold === null
                  ? '–'
                  : `${r.hold.active ? 'Held' : 'Held until'} ${utc(r.hold.until)}${r.hold.active ? ' ' : ' (ended) '}for ${msWords(r.hold.holdMs)}, disagreement ${r.hold.disagreements}`}
                {r.lastDisagreement === null ? null : (
                  <div className="text-muted-foreground">
                    {`Red on the VPS ${utc(r.lastDisagreement.at)}: `}
                    {r.lastDisagreement.tests.length > 0
                      ? r.lastDisagreement.tests
                          .map(
                            (t) =>
                              `${t.name} (${msWords(t.durationMs)}${t.timeoutMs === null ? '' : `, timeout ${msWords(t.timeoutMs)}`})`,
                          )
                          .join('; ')
                      : (r.lastDisagreement.tail ?? '').split('\n').slice(-3).join(' | ')}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

function StepsByHost({ model }: { model: Model }) {
  const hosts = model.tests.byHost
  return (
    <Section level={3} title="Steps by host" aside="Test steps of the window on each host">
      {hosts.length === 0 ? (
        <Nothing>No step ran in this window.</Nothing>
      ) : (
        <Table
          label="One row per host"
          head={
            <>
              <th className={TH}>Host</th>
              <th className={cn(TH, NUM)}>Runs</th>
              <th className={cn(TH, NUM)}>Red</th>
              <th className={cn(TH, NUM)}>Slot min</th>
              <th className={cn(TH, NUM)}>Wait p50</th>
              <th className={cn(TH, NUM)}>Wait p90</th>
              <th className={cn(TH, NUM)}>Run p50</th>
              <th className={cn(TH, NUM)}>Red off, green home</th>
            </>
          }
        >
          {hosts.map((h) => (
            <tr key={h.host}>
              <th scope="row" className={cn(TD, 'text-left font-medium')}>
                {h.host}
              </th>
              <td className={cn(TD, NUM)}>{h.runs}</td>
              <td className={cn(TD, NUM)}>{h.failed}</td>
              <td className={cn(TD, NUM)}>{h.minutes.toFixed(1)}</td>
              <td className={cn(TD, NUM)}>{dash(h.waitP50Ms, msWords)}</td>
              <td className={cn(TD, NUM)}>{dash(h.waitP90Ms, msWords)}</td>
              <td className={cn(TD, NUM)}>{dash(h.durationP50Ms, msWords)}</td>
              <td className={cn(TD, NUM)}>{h.disagreed}</td>
            </tr>
          ))}
        </Table>
      )}
      <RemoteSteps model={model} />
    </Section>
  )
}

function Improvements({ model }: { model: Model }) {
  return (
    <Section level={3} title="Improvements" aside="What the loop filed, before and after">
      {model.improvements.length === 0 ? (
        <Nothing next="An improvement shows here once the loop files it.">
          The loop has filed no improvement yet.
        </Nothing>
      ) : (
        <Table
          label="Improvement findings"
          head={
            <>
              <th className={TH}>Project</th>
              <th className={TH}>Measures</th>
              <th className={TH}>Before, target and after</th>
              <th className={TH}>Status</th>
              <th className={TH}>Issue</th>
            </>
          }
        >
          {model.improvements.map((f) => {
            const status = STATUS[f.status] ?? { label: f.status, tone: 'neutral' as const }
            const done = progress(f)
            return (
              <tr key={f.id} data-status={f.status}>
                <th scope="row" className={cn(TD, 'text-left font-medium')}>
                  <Link to="/projects/$name" params={{ name: f.project }} className={LINK}>
                    {f.project}
                  </Link>
                </th>
                <td className={TD}>
                  {kpiLabel(f.kpi)}
                  {f.subject === '*' ? null : <span className="ml-2 text-muted-foreground">{f.subject}</span>}
                </td>
                <td className={TD}>
                  <div className="flex flex-wrap items-center gap-x-2 tabular-nums">
                    <span>{kpiValue(f.kpi, f.before)}</span>
                    <ArrowRightIcon aria-hidden="true" className="size-3 text-muted-foreground" />
                    <span className="text-muted-foreground">target {kpiValue(f.kpi, f.target)}</span>
                    <ArrowRightIcon aria-hidden="true" className="size-3 text-muted-foreground" />
                    <span className="font-medium">{f.after === null ? 'not read' : kpiValue(f.kpi, f.after)}</span>
                  </div>
                  <MeterBar
                    value={done === null ? 0 : Math.max(0, Math.min(1, done))}
                    tone={done === null ? 'neutral' : done >= 1 ? 'good' : done > 0 ? 'accent' : 'warn'}
                    className="mt-1.5 max-w-64"
                  />
                </td>
                <td className={TD}>
                  <span
                    className={cn(
                      'inline-flex h-5 items-center rounded-md px-1.5 text-xs',
                      TONE_TINT[status.tone],
                      TONE_TEXT[status.tone],
                    )}
                  >
                    {status.label}
                  </span>
                  {f.reason ? <span className="mt-1 block text-xs text-muted-foreground">{f.reason}</span> : null}
                </td>
                <td className={cn(TD, 'font-mono')}>
                  {f.issue === null ? (
                    '–'
                  ) : (
                    <Link to="/issues/$id" params={{ id: issueNumber(f.issue) }} className={LINK}>
                      #{issueNumber(f.issue)}
                    </Link>
                  )}
                </td>
              </tr>
            )
          })}
        </Table>
      )}
    </Section>
  )
}

function Throughput() {
  const { hours = DEFAULT_THROUGHPUT_WINDOW } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  useWindowKeys(THROUGHPUT_WINDOWS, hours, (next) => void navigate({ search: { hours: next } }))
  const query = useThroughput(hours)
  const screen = useScreen(query)
  const note = useScreenNote(screen, query.error)
  const model = query.data
  const capacity = useCapacityLoop(Math.max(1, Math.round(hours / 24)))
  if (!model) {
    return (
      <Page fluid>
        <PageHeader title="Throughput" loading={screen === 'loading'} note={note} />
        <WindowSwitch hours={hours} />
        <WindowSection hours={hours} />
        {screen === 'loading' ? <ThroughputSkeleton /> : null}
      </Page>
    )
  }
  return (
    <Page fluid>
      <PageHeader title="Throughput" note={epochLine(model) ?? `Over ${windowName(model.hours)}`} />
      <WindowSwitch hours={hours} />
      <WindowSection hours={hours} />
      <div className="grid gap-8 @container">
        <HostRow model={model} />
        <Answers model={model} />
        {capacity.data ? <CapacityCards model={capacity.data} /> : null}
        <Section title="Detail" aside="One step from each answer">
          <div className="grid gap-2">
            <Detail title="The host over time: CPU, memory, swap, pressure and load, and the largest processes">
              <div className="grid gap-8">
                <Timeline model={model} />
                <Processes model={model} />
              </div>
            </Detail>
            <Detail
              title="The queue: what each reason cost, and where a lead's time goes"
              count={model.answers.queue.byReason.length}
            >
              <div className="grid gap-8">
                <Reasons model={model} />
                <LeadTime model={model} />
              </div>
            </Detail>
            <Detail title="The cost: memory by class, tenants and projects">
              <div className="grid gap-8">
                <Classes model={model} />
                <Tenants model={model} />
              </div>
            </Detail>
            <Detail title="The cost: project scorecard" count={model.project.length}>
              <Scorecard model={model} />
            </Detail>
            <Detail title="The cost: steps by host" count={model.tests.byHost.length}>
              <StepsByHost model={model} />
            </Detail>
            {capacity.data ? (
              <Detail title="The capacity loop: steps by peak memory, edges by shared files, the reaper and the settings">
                <CapacityTables model={capacity.data} />
              </Detail>
            ) : null}
            <Detail title="The cost: improvements ledger" count={model.improvements.length}>
              <Improvements model={model} />
            </Detail>
          </div>
        </Section>
      </div>
    </Page>
  )
}
