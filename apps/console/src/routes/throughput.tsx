import type { ThroughputModel } from '@software-factory/contract'
import { ArrowRightIcon, CpuIcon, HourglassIcon, StackIcon, WarningIcon } from '@phosphor-icons/react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { Fold, MeterBar, Section, Sparkline, StatCard, TimeChart } from '@/components/kit'
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
  dayWords,
  epochLine,
  hoursWords,
  issueNumber,
  kpiLabel,
  kpiValue,
  levelHeight,
  levelWords,
  mibWords,
  msWords,
  percentWords,
  progress,
  queueWords,
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

const LEVEL_NAME = { normal: 'Normal', warning: 'Warning', critical: 'Critical', unread: 'Not read' } as const

/** The three answers, in order, each a question, one sentence, one figure and its trend. The server wrote the sentences. */
function Answers({ model }: { model: Model }) {
  const { answers } = model
  const { host, queue, cost } = answers
  const points = model.host.timeline.points
  const times = points.map((p) => new Date(p.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))
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
          chart={
            <Sparkline
              name="Memory pressure"
              values={points.map((p) => levelHeight(p.pressureLevel))}
              labels={points.map((p, i) => `${levelWords(p.pressureLevel)}, ${times[i]}`)}
              format={(v) => (v >= 2 ? 'Critical' : v >= 1 ? 'Warning' : 'Normal')}
              tone={host.level === 'critical' ? 'bad' : host.level === 'warning' ? 'warn' : 'neutral'}
            />
          }
          footer={[
            { label: 'Swap in use', value: dash(host.swapUsedPct, (v) => `${v.toFixed(1)} %`), note: 'Not read' },
            { label: 'Memory used', value: dash(host.memoryUsedPct, (v) => `${Math.round(v)} %`), note: 'Not read' },
          ]}
        />
        <StatCard
          id="throughput-queue"
          icon={HourglassIcon}
          title="What do queued Issues wait for?"
          subtitle={`Queued hours over ${windowName(model.hours)}`}
          value={queue.binding ? hoursWords(queue.binding.hours) : null}
          valueNote="No Issue waited for a cost of the factory in this window"
          sub={queue.sentence}
          chart={
            queue.binding ? (
              <Sparkline
                name={`Queued hours for ${queueWords(queue.binding.kind)}`}
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
              <Link to="/flow" search={{ project: r.repo }} className={LINK}>
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
  return (
    <Section
      level={3}
      title="Pressure, swap and load"
      aside={`${bucketMinutes}-minute buckets, the busiest minute of each`}
    >
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

/** What each queue reason cost over the window, most first. */
function Reasons({ model }: { model: Model }) {
  const { byReason } = model.answers.queue
  return (
    <Section level={3} title="What each reason cost" aside="Queued hours in the window">
      {byReason.length === 0 ? (
        <Nothing>No Issue waited for a cost of the factory in this window.</Nothing>
      ) : (
        <Table
          narrow
          label="Queued hours by reason"
          head={
            <>
              <th className={TH}>Reason</th>
              <th className={cn(TH, NUM)}>Queued</th>
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
    <Section level={3} title="Improvements" aside="What the loop filed, before and after">
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
      <PageHeader title="Throughput" note={epochLine(model) ?? `Over ${windowName(model.hours)}`} />
      <WindowSwitch hours={hours} />
      <WindowSection hours={hours} />
      <div className="grid gap-8 @container">
        <Answers model={model} />
        <Section title="Detail" aside="One step from each answer">
          <div className="grid gap-2">
            <Detail title="The host: pressure, swap and load, and the largest processes">
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
            <Detail title="The cost: improvements ledger" count={model.improvements.length}>
              <Improvements model={model} />
            </Detail>
          </div>
        </Section>
      </div>
    </Page>
  )
}
