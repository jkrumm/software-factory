import type {
  CapacityLoopModel,
  FindingClassesModel,
  FixCommitsModel,
  FrictionModel,
  Kpi,
  KpiKey,
  KpiModel,
} from '@software-factory/contract'
import {
  CaretRightIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CurrencyDollarIcon,
  FileTextIcon,
  GaugeIcon,
  HandPointingIcon,
  HourglassIcon,
  ArmchairIcon,
  type Icon,
  ProhibitIcon,
  ScalesIcon,
  SealCheckIcon,
  TimerIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Fold, InfoHint, MenuPopover, Section, Skeleton, Sparkline, StackedBars, StatCard } from '@/components/kit'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection, useSidebarCollapsed } from '@/components/sidebar'
import { LINKED_CARD } from '@/components/kit/card-link'
import { TONE_MARK } from '@/components/kit/tone'
import { buttonVariants } from '@/components/ui/button'
import {
  CAPACITY_HINT,
  chartTarget,
  constantRows,
  dayLabels,
  dayValues,
  dayXLabels,
  classWords,
  comparisonWords,
  DEFAULT_WINDOW,
  distanceWords,
  drawsHistory,
  FRICTION_GROUP_HINT,
  FRICTION_GROUP_LABEL,
  fixCard,
  fixClassRows,
  fixWeekLabel,
  fixWeeksOldestFirst,
  fixWeekTotals,
  formatKpi,
  formatValue,
  historyLabels,
  historyValues,
  historyXLabels,
  hoursWords,
  kpiChange,
  KPI_HINT,
  kpiFooter,
  lineTone,
  mibWords,
  msWords,
  perDayWords,
  perIssueWords,
  shortDate,
  STATUS_WORD,
  statusTone,
  summaryKpis,
  targetStatus,
  targetTally,
  targetWords,
  stampWords,
  WINDOW_DAYS,
  windowOf,
  windowWords,
} from '@/lib/improve'
import { failureNote } from '@/lib/api'
import { useCapacityLoop, useFindingClasses, useFixCommits, useFriction, useKpis } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/improve')({
  /** `days` is one of the three windows; a missing or other value is the default and stays out of the URL. */
  validateSearch: (search: Record<string, unknown>): { days?: number } =>
    search.days === undefined ? {} : { days: windowOf(search.days) },
  component: Improve,
})

/** The KPI bands in the Console's own order, the headline measures first; the fix-commit band follows them (its data is `/v1/fix-commits`). */
const QUALITY: readonly KpiKey[] = [
  'first_verification_passes',
  'avoidable_touches',
  'asks',
  'worth_asking',
  'specs_per_100',
  'owner_decisions_per_100',
]
const PACE_AND_GATES: readonly KpiKey[] = ['queue_wait_p90', 'queue_wait_p50', 'cycle_p50', 'refusals']
const SPEND: readonly KpiKey[] = ['window_points', 'cost']

/** Every card band shares one lattice: 1 column, 2 from `@3xl`, 4 from `@7xl`. */
const LATTICE = 'grid-cols-1 @3xl:grid-cols-2 @7xl:grid-cols-4'

/** A card spans a header, a body and a footer row of the band's grid, so a row shares one height per part; the grid's `gap-4` sits between rows, the card `gap-y-1` between its parts. */
const BAND_CARD = 'row-span-3 grid grid-rows-subgrid gap-y-1 self-stretch'

const KPI_ICON: Record<KpiKey, Icon> = {
  first_verification_passes: SealCheckIcon,
  avoidable_touches: HandPointingIcon,
  asks: ChatCircleDotsIcon,
  worth_asking: ScalesIcon,
  specs_per_100: FileTextIcon,
  owner_decisions_per_100: ChatCircleDotsIcon,
  refusals: ProhibitIcon,
  queue_wait_p90: HourglassIcon,
  queue_wait_p50: HourglassIcon,
  cycle_p50: TimerIcon,
  window_points: GaugeIcon,
  cost: CurrencyDollarIcon,
  fix_commits: WrenchIcon,
}

/** A surface card that is not a StatCard: a panel step with the faint card shadow, no border. */
const PANEL = 'rounded-xl bg-card'
const PANEL_SHADOW = { boxShadow: 'var(--vx-shadow-card)' }

function WindowSwitch({ days }: { days: number }) {
  const collapsed = useSidebarCollapsed()
  return (
    <nav aria-label="Window" className={cn('mb-6 flex gap-2', !collapsed && 'md:hidden')}>
      {WINDOW_DAYS.map((choice) => (
        <Link
          key={choice}
          to="/improve"
          search={{ days: choice }}
          aria-current={choice === days ? 'page' : undefined}
          className={cn(buttonVariants({ variant: choice === days ? 'secondary' : 'outline', size: 'sm' }))}
        >
          {choice} days
        </Link>
      ))}
    </nav>
  )
}

function WindowSection({ days }: { days: number }) {
  return (
    <SidebarSection title="Window">
      {WINDOW_DAYS.map((choice) => (
        <SidebarEntry
          key={choice}
          label={`${choice} days`}
          current={choice === days}
          render={(props) => <Link to="/improve" search={{ days: choice }} {...props} />}
        />
      ))}
    </SidebarSection>
  )
}

function KpiCard({ kpi, model, className }: { kpi: Kpi; model: KpiModel; className?: string }) {
  const change = kpiChange(kpi)
  const known = drawsHistory(kpi)
  return (
    <StatCard
      id={`kpi-${kpi.key}`}
      className={cn(BAND_CARD, className)}
      icon={KPI_ICON[kpi.key]}
      title={kpi.label}
      hint={KPI_HINT[kpi.key]}
      subtitle={comparisonWords(model.days)}
      value={formatKpi(kpi)}
      delta={kpi.measured ? { value: change.text, direction: change.direction, tone: change.tone } : undefined}
      sub={kpi.measured ? (distanceWords(kpi) ?? undefined) : undefined}
      chart={
        known ? (
          <Sparkline
            values={historyValues(kpi)}
            labels={historyLabels(kpi, model.windows)}
            target={chartTarget(kpi.target)}
            tone={lineTone(kpi)}
            name={kpi.label}
            format={(value) => formatValue(kpi.unit, value)}
          />
        ) : kpi.measured ? (
          <NoHistory />
        ) : null
      }
      xLabels={known ? historyXLabels(model.days, model.windows) : undefined}
      footer={kpiFooter(kpi)}
      menu={
        <MenuPopover label={`${kpi.label}: what is counted`} title="What is counted">
          {kpi.definition}
        </MenuPopover>
      }
    />
  )
}

const CHART_HEIGHT = 88

/** The chart's place on a measured KPI that has too few windows to draw: a dashed baseline and the reason, no chart role. */
function NoHistory() {
  return (
    <div style={{ height: CHART_HEIGHT }} className="flex flex-col justify-end gap-2">
      <div className="border-t border-dashed border-border" />
      <p className="text-xs text-muted-foreground">Not enough windows yet to draw a line</p>
    </div>
  )
}

function FixCard({ model, pending }: { model: FixCommitsModel | undefined; pending: boolean }) {
  const common = {
    icon: WrenchIcon,
    title: 'Fix commits per week',
    hint: KPI_HINT.fix_commits,
    subtitle: 'This week against the one before',
  }
  if (!model || !model.measured) {
    return (
      <StatCard
        {...common}
        value={model || !pending ? 'No data' : 'Loading'}
        sub={model ? 'No fix commits stored yet' : undefined}
        chart={model ? null : <Skeleton height={CHART_HEIGHT} />}
        footer={[
          { label: 'Target', value: 'falling' },
          { label: 'Counted', value: model || !pending ? 'No fix commits' : 'Loading' },
        ]}
      />
    )
  }
  const card = fixCard(model)
  const first = card.weeks[0]
  const last = card.weeks.at(-1)
  return (
    <StatCard
      {...common}
      value={card.latest}
      delta={{ value: card.change.text, direction: card.change.direction, tone: card.tone }}
      sub="Falling is the target"
      chart={
        <StackedBars
          name="Fix commits per week by class"
          unit="fix commits"
          height={CHART_HEIGHT}
          series={card.classes.map((c) => ({ key: c.key, label: c.key, slot: c.slot + 1 }))}
          bars={card.weeks.map((w) => ({ label: `Week to ${w.label}`, values: w.counts }))}
        />
      }
      xLabels={first && last ? [shortDate(first.label), 'Weeks ending', shortDate(last.label)] : undefined}
      footer={[
        { label: 'Total in the shown weeks', value: String(card.total) },
        { label: 'Busiest class', value: card.busiest ? `${card.busiest.key} (${card.busiest.total})` : 'None' },
      ]}
      menu={
        <MenuPopover label="Fix commits: what is counted" title="What is counted">
          Commits on a project's default branch whose subject is a conventional fix, sorted into a class by the
          fix-classes loop; each week is seven days ending on the date shown, the newest on the right.
        </MenuPopover>
      }
    />
  )
}

/** One DOM, two layouts: a compact row of a shared panel, and from `@7xl` a tile of its own (status, figure, label, target). */
function SummaryTile({ kpi }: { kpi: Kpi }) {
  const status = targetStatus(kpi)
  const id = `kpi-${kpi.key}`
  const figure = kpi.measured && kpi.value !== null
  return (
    <li className="min-w-0 @7xl:flex @7xl:rounded-xl @7xl:bg-card @7xl:shadow-[var(--vx-shadow-card)]">
      <a
        href={`#${id}`}
        title="Jump to the card"
        onClick={(event) => {
          const card = document.getElementById(id)
          if (!card) return
          event.preventDefault()
          card.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }}
        className={cn(
          LINKED_CARD,
          'relative grid min-h-11 min-w-0 flex-1 grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          '@md:flex @md:gap-3',
          '@7xl:flex-col @7xl:items-stretch @7xl:gap-1 @7xl:rounded-xl @7xl:py-3',
        )}
      >
        <span className="col-start-1 row-start-1 flex shrink-0 items-center gap-2 text-[length:var(--vx-text-sm)] font-medium @md:min-w-24 @7xl:order-1 @7xl:min-w-0">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: TONE_MARK[statusTone(status)] }}
          />
          {STATUS_WORD[status]}
        </span>
        <span
          title={kpi.label}
          className="col-start-1 row-start-2 min-w-0 text-[length:var(--vx-text-sm)] leading-tight font-semibold tracking-tight @md:flex-1 @md:truncate @7xl:order-3 @7xl:line-clamp-2 @7xl:min-h-[2.5em] @7xl:flex-none @7xl:whitespace-normal"
        >
          {kpi.label}
        </span>
        <span
          className={cn(
            'col-start-2 row-start-1 shrink-0 justify-self-end tabular-nums @7xl:order-2',
            figure
              ? 'text-[length:var(--vx-text-md)] font-semibold @7xl:text-[length:var(--vx-text-xl)]'
              : 'text-[length:var(--vx-text-sm)] text-muted-foreground',
          )}
        >
          {formatKpi(kpi)}
        </span>
        <span className="col-start-2 row-start-2 shrink-0 justify-self-end text-[length:var(--vx-text-sm)] text-muted-foreground @7xl:order-4">
          {targetWords(kpi)}
        </span>
        <CaretRightIcon
          aria-hidden="true"
          className="col-start-3 row-span-2 row-start-1 size-3.5 shrink-0 text-muted-foreground @7xl:absolute @7xl:top-3 @7xl:right-4"
        />
      </a>
    </li>
  )
}

function SummaryStrip({ model }: { model: KpiModel }) {
  const kpis = summaryKpis(model.kpis)
  if (kpis.length === 0) return null
  const { met, judged } = targetTally(kpis)
  return (
    <div data-shot="improve-summary">
      <Section title="Against target" aside={judged > 0 ? `${met} of ${judged} targets met` : undefined}>
        <ul
          aria-label="Targets"
          className={cn(
            'grid grid-cols-1 divide-y rounded-xl bg-card shadow-[var(--vx-shadow-card)]',
            '@7xl:auto-cols-fr @7xl:grid-flow-col @7xl:gap-4 @7xl:divide-y-0 @7xl:rounded-none @7xl:bg-transparent @7xl:shadow-none',
          )}
        >
          {kpis.map((kpi) => (
            <SummaryTile key={kpi.key} kpi={kpi} />
          ))}
        </ul>
      </Section>
    </div>
  )
}

function KpiBand({
  title,
  aside,
  keys,
  model,
  shot,
  cardClassName,
}: {
  title: string
  aside?: string
  keys: readonly KpiKey[]
  model: KpiModel
  shot: string
  /** Added to every card of the band (a column span). */
  cardClassName?: string
}) {
  const kpis = keys.flatMap((key) => model.kpis.filter((kpi) => kpi.key === key))
  if (kpis.length === 0) return null
  return (
    <div data-shot={shot}>
      <Section title={title} aside={aside}>
        <div className={cn('grid gap-4', LATTICE)}>
          {kpis.map((kpi) => (
            <KpiCard key={kpi.key} kpi={kpi} model={model} className={cardClassName} />
          ))}
        </div>
      </Section>
    </div>
  )
}

type FrictionRows = FrictionModel['counts']

/** One heading, rows with hairlines; every group has the same row pitch. */
function FrictionGroup({
  title,
  hint,
  rows,
}: {
  title: string
  hint: (typeof FRICTION_GROUP_HINT)[keyof typeof FRICTION_GROUP_HINT] | null
  rows: FrictionRows
}) {
  return (
    <div className="mb-4 break-inside-avoid">
      <h3 className="mb-1 flex items-center gap-0.5 text-sm font-medium">
        {title}
        {hint ? <InfoHint word={hint} className="-my-1" /> : null}
      </h3>
      <ul aria-label={title} className="divide-y text-sm">
        {rows.map((row) => (
          <li
            key={row.key}
            className={cn(
              'flex items-baseline justify-between gap-4 py-1.5',
              row.count === 0 && 'text-muted-foreground',
            )}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">{row.label}</span>
            <span className="flex shrink-0 gap-4 tabular-nums">
              <span aria-label="Count" className="w-10 text-right">
                {row.count}
              </span>
              <span aria-label="Per Issue closed" className="w-14 text-right text-muted-foreground">
                {perIssueWords(row.perIssue)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

type FrictionGroupKey = keyof typeof FRICTION_GROUP_LABEL

function FrictionBody({ model }: { model: FrictionModel }) {
  const hintOf = (group: FrictionGroupKey) =>
    group in FRICTION_GROUP_HINT ? FRICTION_GROUP_HINT[group as keyof typeof FRICTION_GROUP_HINT] : null
  const groups = (Object.keys(FRICTION_GROUP_LABEL) as FrictionGroupKey[])
    .map((group) => ({ group, rows: model.counts.filter((c) => c.group === group) }))
    .filter(({ rows }) => rows.length > 0)
  /** A group of one row without a hint is not worth a heading of its own: they share "Also counted", where the first stood. */
  const single = ({ group, rows }: (typeof groups)[number]) => rows.length === 1 && !hintOf(group)
  const alsoCounted = groups.filter(single).flatMap(({ rows }) => rows)
  const firstSingle = groups.find(single)
  return (
    <div className={cn(PANEL, 'p-4')} style={PANEL_SHADOW}>
      {model.counts.length === 0 ? <EmptyState title="Nothing counted" /> : null}
      <div className="columns-1 gap-x-8 @3xl:columns-2 @6xl:columns-3">
        {groups.map((entry) => {
          if (!single(entry)) {
            return (
              <FrictionGroup
                key={entry.group}
                title={FRICTION_GROUP_LABEL[entry.group]}
                hint={hintOf(entry.group)}
                rows={entry.rows}
              />
            )
          }
          if (entry !== firstSingle) return null
          return <FrictionGroup key="also-counted" title="Also counted" hint={null} rows={alsoCounted} />
        })}
      </div>
    </div>
  )
}

function FrictionSection({ model, pending }: { model: FrictionModel | undefined; pending: boolean }) {
  const aside = model
    ? `${model.issues} Issues filed, ${model.closed} closed in the window${model.since ? `. Counted since ${model.since.slice(0, 10)}` : ''}. Rows: count, then per Issue closed`
    : undefined
  return (
    <div data-shot="improve-friction">
      <Section title="Friction" aside={aside}>
        {model ? (
          <FrictionBody model={model} />
        ) : (
          <p className="text-sm text-muted-foreground">{pending ? 'Loading' : 'No data yet'}</p>
        )}
      </Section>
    </div>
  )
}

function FindingClassesSection({ model }: { model: FindingClassesModel | undefined }) {
  const quiet = (model?.classes ?? []).filter((c) => c.status !== 'open')
  return (
    <div data-shot="improve-held">
      <Section title="Held finding classes">
        {quiet.length === 0 ? (
          <p className="text-sm text-muted-foreground">{model ? 'No finding class is held.' : 'Loading'}</p>
        ) : (
          <ul aria-label="Held finding classes" className={cn(PANEL, 'divide-y px-4 text-sm')} style={PANEL_SHADOW}>
            {quiet.map((c) => (
              <li key={`${c.loop}/${c.class}`} className="flex flex-col gap-0.5 py-2">
                <span>
                  {c.loop} · {c.class}{' '}
                  <span className="text-muted-foreground">{c.status === 'held' ? 'held' : 'on probation'}</span>
                </span>
                <span className="text-muted-foreground">{classWords(c)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function FixClassesPanel({ model }: { model: FixCommitsModel }) {
  const rows = fixClassRows(model)
  return (
    <section
      aria-label="Fix commits by class"
      className={cn(PANEL, 'flex min-w-0 flex-col overflow-x-auto')}
      style={PANEL_SHADOW}
    >
      <h3 className="flex items-baseline gap-2 px-4 pt-3 pb-1 text-sm font-medium">
        Fix commits by class
        <span className="text-muted-foreground tabular-nums">{fixWeekTotals(model).reduce((a, b) => a + b, 0)}</span>
      </h3>
      <table className="h-full w-full flex-1 text-sm">
        <caption className="sr-only">Fix commits per class, by the week ending on the date shown</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="w-px px-4 py-2 font-medium whitespace-nowrap">
              Class
            </th>
            {fixWeeksOldestFirst(model).map((week) => (
              <th
                key={fixWeekLabel(week)}
                scope="col"
                title={fixWeekLabel(week)}
                className="px-2.5 py-2 text-right font-medium whitespace-nowrap"
              >
                {shortDate(week.to)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t">
              <th scope="row" className="w-px px-4 py-2 text-left font-medium whitespace-nowrap" title={row.meaning}>
                {row.key}
              </th>
              {row.counts.map((n, i) => (
                <td key={i} className="px-2.5 py-2 text-right tabular-nums">
                  {n}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t font-medium">
            <th scope="row" className="w-px px-4 py-2 text-left whitespace-nowrap">
              Total
            </th>
            {fixWeekTotals(model).map((n, i) => (
              <td key={i} className="px-2.5 py-2 text-right tabular-nums">
                {n}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  )
}

function FixBand({ model, pending }: { model: FixCommitsModel | undefined; pending: boolean }) {
  return (
    <div data-shot="improve-fix">
      <Section title="Fix commits">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <FixCard model={model} pending={pending} />
          {model?.measured ? <FixClassesPanel model={model} /> : null}
        </div>
      </Section>
    </div>
  )
}

const CAPACITY_TITLE = {
  throughput: 'Issues closed',
  idle: 'Idle seat-hours with work queued',
  over: 'Minutes over the load ceiling',
  wait: 'Test slot wait',
} as const

function CapacityCards({ model }: { model: CapacityLoopModel }) {
  const { constants } = model
  const subtitle = `Last ${model.days} days, UTC days`
  const wait = model.slotWait
  return (
    <div className="@container">
      <div
        aria-label="Capacity figures"
        role="group"
        className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-4"
      >
        <StatCard
          icon={CheckCircleIcon}
          title={CAPACITY_TITLE.throughput}
          hint={CAPACITY_HINT.throughput}
          subtitle={subtitle}
          value={perDayWords(model.throughput.total, model.days)}
          sub={`${model.throughput.total} closed in the window`}
          chart={
            <Sparkline
              values={dayValues(model.throughput.perDay)}
              labels={dayLabels(model.throughput.perDay)}
              tone="neutral"
              name="Issues closed per day"
              format={(value) => `${value} closed`}
            />
          }
          xLabels={dayXLabels(model.throughput.perDay)}
          footer={[
            { label: 'Closed', value: String(model.throughput.total) },
            { label: 'Window', value: `${model.days} days` },
          ]}
        />
        <StatCard
          icon={ArmchairIcon}
          title={CAPACITY_TITLE.idle}
          hint={CAPACITY_HINT.idle}
          subtitle={subtitle}
          value={hoursWords(model.idleSeatHours.total)}
          sub="Seats no lead held while Issues waited"
          chart={
            <Sparkline
              values={dayValues(model.idleSeatHours.perDay)}
              labels={dayLabels(model.idleSeatHours.perDay)}
              tone="neutral"
              name="Idle seat-hours per day"
              format={hoursWords}
            />
          }
          xLabels={dayXLabels(model.idleSeatHours.perDay)}
          footer={[
            { label: 'Leads per account', value: String(constants.leadsPerAccount) },
            { label: 'Seat bonus at most', value: String(constants.seatsMaxBonus) },
          ]}
        />
        <StatCard
          icon={GaugeIcon}
          title={CAPACITY_TITLE.over}
          subtitle={subtitle}
          value={String(model.minutesOverCeiling.total)}
          sub="Host minutes above the ceiling in force"
          chart={
            <Sparkline
              values={dayValues(model.minutesOverCeiling.perDay)}
              labels={dayLabels(model.minutesOverCeiling.perDay)}
              tone="neutral"
              name="Minutes over the load ceiling per day"
              format={(value) => `${value} min`}
            />
          }
          xLabels={dayXLabels(model.minutesOverCeiling.perDay)}
          footer={[
            { label: 'Load ceiling', value: String(constants.loadCeiling) },
            { label: 'Extra slot below load', value: String(constants.slotExtraLoad) },
          ]}
        />
        <StatCard
          icon={HourglassIcon}
          title={CAPACITY_TITLE.wait}
          hint={CAPACITY_HINT.wait}
          subtitle={subtitle}
          value={wait.n === 0 ? 'No data' : msWords(wait.p50Ms)}
          sub={wait.n === 0 ? 'No steps recorded yet' : `Median; 90th percentile ${msWords(wait.p90Ms)}`}
          chart={
            wait.n === 0 ? null : (
              <Sparkline
                values={dayValues(wait.perDayP50)}
                labels={dayLabels(wait.perDayP50)}
                tone="neutral"
                name="Median test slot wait per day"
                format={(value) => msWords(value)}
              />
            )
          }
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
    </div>
  )
}

function CapacityTables({ model }: { model: CapacityLoopModel }) {
  return (
    <div className="grid items-start gap-8 xl:grid-cols-2">
      <section aria-label="Steps by memory">
        <Fold title="Steps by peak memory" count={model.topSteps.length} defaultOpen>
          {model.topSteps.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No steps recorded yet.</p>
          ) : (
            <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
              <table className="w-full text-sm">
                <caption className="sr-only">Test-slot steps with the largest peak memory in the window</caption>
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Step
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Runs
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Peak
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      80th pct
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Duration
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Wait
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {model.topSteps.map((step) => (
                    <tr key={step.name} className="border-t">
                      <th scope="row" className="px-4 py-2 text-left font-medium">
                        {step.name}
                      </th>
                      <td className="px-4 py-2 text-right tabular-nums">{step.runs}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{mibWords(step.maxPeakMib)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{mibWords(step.p80PeakMib)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{msWords(step.medianDurationMs)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{msWords(step.medianWaitMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Fold>
      </section>
      <section aria-label="Lead cost per repo">
        <Fold title="Lead cost per repo" count={model.leadCosts.length} defaultOpen>
          {model.leadCosts.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No lead samples recorded yet.</p>
          ) : (
            <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
              <table className="w-full text-sm">
                <caption className="sr-only">Memory a lead takes per repo, from its process tree samples</caption>
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Repo
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Attempts
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      80th pct
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Last
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {model.leadCosts.map((cost) => (
                    <tr key={cost.repo} className="border-t">
                      <th scope="row" className="px-4 py-2 text-left font-medium">
                        {cost.repo}
                      </th>
                      <td className="px-4 py-2 text-right tabular-nums">{cost.attempts}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{mibWords(cost.peakMibP80)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{mibWords(cost.lastPeakMib)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Fold>
      </section>
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

function CapacitySection({ model, pending }: { model: CapacityLoopModel | undefined; pending: boolean }) {
  return (
    <section aria-labelledby="improve-capacity" className="grid gap-4">
      <h2 id="improve-capacity" className="text-sm font-medium text-muted-foreground">
        Capacity
      </h2>
      {model ? (
        <>
          <CapacityCards model={model} />
          <CapacityTables model={model} />
          <CapacityReaped model={model} />
          <dl aria-label="Settings in force" className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            {constantRows(model.constants).map((row) => (
              <div key={row.key} className="flex gap-1.5">
                <dt>{row.label}</dt>
                <dd className="text-foreground tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{pending ? 'Loading' : 'No data yet'}</p>
      )}
    </section>
  )
}

function Improve() {
  const { days = DEFAULT_WINDOW } = Route.useSearch()
  const kpis = useKpis(days)
  const friction = useFriction(days)
  const classes = useFindingClasses()
  const fixes = useFixCommits()
  const capacity = useCapacityLoop(days)

  if (!kpis.data) {
    return (
      <Page fluid>
        <PageHeader title="Improve" note={kpis.isPending ? 'Loading' : failureNote(kpis.error)} />
        <WindowSwitch days={days} />
        <WindowSection days={days} />
      </Page>
    )
  }
  const model = kpis.data
  return (
    <Page fluid>
      <PageHeader title="Improve" note={`Last ${model.days} days, ${windowWords(model.window)}`} />
      <WindowSwitch days={days} />
      <WindowSection days={days} />
      <div role="group" aria-label="Key figures" className="@container">
        <div className="grid gap-10">
          <SummaryStrip model={model} />
          <KpiBand title="Quality" keys={QUALITY} model={model} shot="improve-target" />
          <KpiBand title="Pace and gates" keys={PACE_AND_GATES} model={model} shot="improve-pace" />
          <KpiBand
            title="Spend"
            keys={SPEND}
            model={model}
            shot="improve-spend"
            cardClassName="@3xl:col-span-1 @7xl:col-span-2"
          />
          <FixBand model={fixes.data} pending={fixes.isPending} />
          <FrictionSection model={friction.data} pending={friction.isPending} />
          <FindingClassesSection model={classes.data} />
        </div>
        <CapacitySection model={capacity.data} pending={capacity.isPending} />
      </div>
    </Page>
  )
}
