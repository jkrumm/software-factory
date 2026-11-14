import type { ThroughputModel } from '@software-factory/contract'
import { ArrowRightIcon, CpuIcon, GaugeIcon, SwapIcon, TimerIcon, WarningIcon } from '@phosphor-icons/react'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { MeterBar, Section, Sparkline, StatCard, TimeChart } from '@/components/kit'
import { TONE_TEXT, TONE_TINT } from '@/components/kit/tone'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection, useSidebarCollapsed } from '@/components/sidebar'
import { ThroughputSkeleton } from '@/components/skeletons'
import { useThroughput } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'
import {
  CLASS_LABEL,
  classRows,
  DEFAULT_THROUGHPUT_WINDOW,
  issueNumber,
  kpiLabel,
  kpiValue,
  levelHeight,
  levelWords,
  mibWords,
  minutesWords,
  msWords,
  percentWords,
  progress,
  secondsWords,
  splitRows,
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

function Nothing({ children }: { children: string }) {
  return <EmptyState title={children} icon={CpuIcon} />
}

const dash = (value: number | null, format: (v: number) => string): string => (value === null ? '–' : format(value))

function Stats({ model }: { model: Model }) {
  const { signals } = model.host
  const points = model.host.timeline.points
  const times = points.map((p) => new Date(p.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))
  const slotMinutes = model.project.reduce((sum, p) => sum + p.slot.minutes, 0)
  const closed = model.project.reduce((sum, p) => sum + p.closedIssues, 0)
  const pressured = signals.pressureMinutes.warning + signals.pressureMinutes.critical
  const read = signals.pressureMinutes.normal + pressured
  return (
    <div role="group" aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        id="throughput-pressure"
        icon={WarningIcon}
        title="Memory pressure"
        subtitle={`Over ${windowName(model.hours)}`}
        value={read === 0 ? null : `${pressured} min`}
        valueNote="The host read no pressure level in this window"
        sub={read === 0 ? undefined : `at warning or critical, of ${read} min read`}
        chart={
          <Sparkline
            name="Memory pressure"
            values={points.map((p) => levelHeight(p.pressureLevel))}
            labels={points.map((p, i) => `${levelWords(p.pressureLevel)}, ${times[i]}`)}
            format={(v) => (v === 2 ? 'Critical' : v === 1 ? 'Warning' : 'Normal')}
            tone={signals.pressureMinutes.critical > 0 ? 'bad' : pressured > 0 ? 'warn' : 'neutral'}
          />
        }
        footer={[
          { label: 'Warning', value: `${signals.pressureMinutes.warning} min` },
          { label: 'Critical', value: `${signals.pressureMinutes.critical} min` },
        ]}
      />
      <StatCard
        id="throughput-swap"
        icon={SwapIcon}
        title="Swap in use"
        subtitle="Share of RAM, busiest minute"
        value={dash(signals.swapUsedPct.max, (v) => `${v.toFixed(1)} %`)}
        valueNote="The host read no swap use in this window"
        sub="the largest reading"
        chart={
          <Sparkline
            name="Swap in use"
            values={points.map((p) => p.swapUsedPct)}
            labels={times}
            format={(v) => `${v.toFixed(1)} %`}
          />
        }
        footer={[
          { label: 'Median', value: dash(signals.swapUsedPct.p50, (v) => `${v.toFixed(1)} %`) },
          { label: 'Compressor, largest', value: dash(signals.compressorMib.max, mibWords) },
        ]}
      />
      <StatCard
        id="throughput-load"
        icon={GaugeIcon}
        title="Load"
        subtitle="One-minute average, busiest minute"
        value={dash(signals.load.max, (v) => v.toFixed(1))}
        valueNote="The host read no load in this window"
        sub="the largest reading"
        chart={<Sparkline name="Load" values={points.map((p) => p.load)} labels={times} format={(v) => v.toFixed(1)} />}
        footer={[
          { label: 'Median', value: dash(signals.load.p50, (v) => v.toFixed(1)) },
          { label: 'Idle CPU, lowest', value: dash(signals.cpuIdlePct.min, (v) => `${Math.round(v)} %`) },
        ]}
      />
      <StatCard
        id="throughput-slot"
        icon={TimerIcon}
        title="Slot minutes per closed Issue"
        subtitle={`Over ${windowName(model.hours)}`}
        value={closed === 0 ? null : (slotMinutes / closed).toFixed(1)}
        valueNote="No Issue closed in this window"
        sub={`${Math.round(slotMinutes)} slot minutes, ${closed} closed`}
        bars={model.project.map((p) => Math.round(p.slot.minutes))}
        barLabels={model.project.map((p) => `${p.repo}: ${Math.round(p.slot.minutes)} slot minutes`)}
        footer={[
          {
            label: 'Lead time, mean',
            value: model.lead.closed === 0 ? null : secondsWords(model.lead.wallSeconds / model.lead.closed),
            note: 'No lead closed an Issue',
          },
          { label: 'Issues in the split', value: String(model.lead.closed) },
        ]}
      />
    </div>
  )
}

function Classes({ model }: { model: Model }) {
  const rows = classRows(model)
  const empty = model.host.minutes === 0
  return (
    <Section title="Memory by class" aside={`Mean footprint over ${model.host.minutes} minutes read`}>
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
              <th className={cn(TH, NUM)}>Cores</th>
              <th className={cn(TH, NUM)}>Processes</th>
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
              <td className={cn(TD, NUM)}>{row.cores.toFixed(2)}</td>
              <td className={cn(TD, NUM)}>{row.procs.toFixed(1)}</td>
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
  const { byTenant, byRepo, topProcesses } = model.host
  return (
    <Section title="Where it goes" aside="Largest first, by peak memory">
      <div className="grid gap-6 @container lg:grid-cols-3">
        <Ranked
          label="Memory by tenant"
          head="Tenants"
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
              <Link to="/flow" search={{ project: r.repo }} className={LINK}>
                {r.repo}
              </Link>
            ),
            mean: r.footprintMib,
            peak: r.peakMib,
            note: `leads ${mibWords(r.leadMib)}, steps ${mibWords(r.stepMib)}`,
          }))}
        />
        <Ranked
          label="Notable processes"
          head="Processes"
          empty="No notable process."
          rows={topProcesses.map((p, i) => ({
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
      </div>
    </Section>
  )
}

function Timeline({ model }: { model: Model }) {
  const { points, bucketMinutes } = model.host.timeline
  const times = points.map((p) => new Date(p.at).getTime())
  return (
    <Section title="Pressure, swap and load" aside={`${bucketMinutes}-minute buckets, the busiest minute of each`}>
      {points.length === 0 ? (
        <Nothing>The host recorded no minute in this window.</Nothing>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {[
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
              name: 'Swap in use, share of RAM',
              series: [{ name: 'Swap', values: points.map((p) => p.swapUsedPct), tone: 'accent' as const, area: true }],
              format: (v: number) => `${v.toFixed(1)} %`,
            },
            {
              name: 'Load average',
              series: [{ name: 'Load', values: points.map((p) => p.load), tone: 'neutral' as const, area: true }],
              format: (v: number) => v.toFixed(1),
            },
          ].map((chart) => (
            <div key={chart.name} className="min-w-0 rounded-xl bg-card p-4">
              <h3 className="mb-2 text-[length:var(--vx-text-sm)] font-medium text-muted-foreground">{chart.name}</h3>
              <TimeChart name={chart.name} times={times} series={chart.series} format={chart.format} height={96} />
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function LeadTime({ model }: { model: Model }) {
  const { lead } = model
  const rows = splitRows(lead.split)
  return (
    <Section
      title="Where a lead's time goes"
      aside={`${lead.closed} ${lead.closed === 1 ? 'Issue' : 'Issues'} closed, ${secondsWords(lead.wallSeconds)} of wall time`}
    >
      {lead.closed === 0 ? (
        <Nothing>No Issue with a lead closed in this window.</Nothing>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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
            <ul className="mt-4 grid gap-2">
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
          <Table
            label="The Issues with the longest lead time"
            head={
              <>
                <th className={TH}>Issue</th>
                <th className={TH}>Project</th>
                <th className={cn(TH, NUM)}>Wall time</th>
                <th className={TH}>Largest part</th>
              </>
            }
          >
            {lead.issues.slice(0, 8).map((issue) => {
              const largest = [...splitRows(issue.split)].sort((a, b) => b.seconds - a.seconds)[0]
              return (
                <tr key={issue.issue}>
                  <td className={cn(TD, 'font-mono')}>
                    <Link to="/issues/$id" params={{ id: issueNumber(issue.issue) }} className={LINK}>
                      #{issueNumber(issue.issue)}
                    </Link>
                  </td>
                  <td className={TD}>
                    <Link to="/flow" search={{ project: issue.repo }} className={LINK}>
                      {issue.repo}
                    </Link>
                  </td>
                  <td className={cn(TD, NUM)}>{secondsWords(issue.wallSeconds)}</td>
                  <td className={TD}>
                    {largest && largest.seconds > 0 ? `${largest.label}, ${percentWords(largest.share)}` : '–'}
                  </td>
                </tr>
              )
            })}
          </Table>
        </div>
      )}
    </Section>
  )
}

function Scorecard({ model }: { model: Model }) {
  return (
    <Section title="Project scorecard" aside="Most slot minutes first">
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
              <th className={cn(TH, NUM)}>Peak</th>
              <th className={cn(TH, NUM)}>Slot wait p90</th>
              <th className={cn(TH, NUM)}>CI p50</th>
              <th className={cn(TH, NUM)}>Local share</th>
              <th className={cn(TH, NUM)}>Merge wait</th>
              <th className={cn(TH, NUM)}>Lead time</th>
            </>
          }
        >
          {model.project.map((p) => (
            <tr key={p.repo}>
              <th scope="row" className={cn(TD, 'text-left font-medium')}>
                <Link to="/flow" search={{ project: p.repo }} className={LINK}>
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
              <td className={cn(TD, NUM)}>{dash(p.slot.peakMib, mibWords)}</td>
              <td className={cn(TD, NUM)}>{msWords(p.slot.waitP90Ms)}</td>
              <td className={cn(TD, NUM)}>{dash(p.ci.p50Minutes, minutesWords)}</td>
              <td className={cn(TD, NUM)}>{dash(p.localToCi.localShare, percentWords)}</td>
              <td className={cn(TD, NUM)}>{minutesWords(p.mergeLock.waitMinutes)}</td>
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

function Improvements({ model }: { model: Model }) {
  return (
    <Section title="Improvements" aside="What the loop filed, before and after">
      {model.improvements.length === 0 ? (
        <Nothing>The loop has filed no improvement yet.</Nothing>
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
                  <Link to="/flow" search={{ project: f.project }} className={LINK}>
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
  const query = useThroughput(hours)
  const screen = useScreen(query)
  const note = useScreenNote(screen, query.error)
  const model = query.data
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
      <PageHeader
        title="Throughput"
        note={`Where the host's memory and the leads' hours went over ${windowName(model.hours)}`}
      />
      <WindowSwitch hours={hours} />
      <WindowSection hours={hours} />
      <div className="grid gap-10 @container">
        <Stats model={model} />
        <Classes model={model} />
        <Timeline model={model} />
        <Tenants model={model} />
        <LeadTime model={model} />
        <Scorecard model={model} />
        <Improvements model={model} />
      </div>
    </Page>
  )
}
