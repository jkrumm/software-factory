import type {
  CapacityLoopModel,
  FindingClassesModel,
  FixCommitsModel,
  FrictionModel,
  Kpi,
  KpiKey,
  KpiModel,
  LoopYieldModel,
} from '@software-factory/contract'
import {
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
import { TONE_MARK, TONE_TEXT } from '@/components/kit/tone'
import { buttonVariants } from '@/components/ui/button'
import {
  CAPACITY_HINT,
  chartTarget,
  constantRows,
  dayLabels,
  dayValues,
  dayXLabels,
  classWords,
  closeWords,
  yieldWords,
  comparisonWords,
  DEFAULT_WINDOW,
  distanceWords,
  drawsHistory,
  fixCard,
  fixClassRows,
  fixWeekLabel,
  fixWeeksOldestFirst,
  fixWeekTotals,
  formatKpi,
  formatValue,
  frictionRanking,
  groupKpis,
  historyLabels,
  historyValues,
  historyXLabels,
  hoursWords,
  queueReasonWords,
  kpiChange,
  KPI_HINT,
  kpiFooter,
  partWords,
  lineTone,
  mibWords,
  msWords,
  perDayWords,
  SEAT_LABEL,
  seatCells,
  attemptSeatCells,
  edgeWords,
  shortDate,
  type FrictionRow,
  MEANING,
  PARTS_ON_CARD,
  partRows,
  targetTally,
  tripwireWords,
  leadsWords,
  stampWords,
  WINDOW_DAYS,
  windowOf,
  windowWords,
} from '@/lib/improve'
import { ImproveSkeleton } from '@/components/skeletons'
import { useScreen, useScreenNote } from '@/lib/screen'
import { useCapacityLoop, useFindingClasses, useFixCommits, useFriction, useKpis, useLoopYield } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/improve')({
  /** `days` is one of the three windows; a missing or other value is the default and stays out of the URL. */
  validateSearch: (search: Record<string, unknown>): { days?: number } =>
    search.days === undefined ? {} : { days: windowOf(search.days) },
  component: Improve,
})

/** Every card band shares one lattice: 1 column, 2 from `@3xl`, 4 from `@7xl`. */
const LATTICE = 'grid-cols-1 @3xl:grid-cols-2 @7xl:grid-cols-4'

/** A card spans a header, a body and a footer row of the band's grid, so a row shares one height per part; the grid's `gap-4` sits between rows, the card `gap-y-1` between its parts. */
const BAND_CARD = 'row-span-3 grid grid-rows-subgrid gap-y-1 self-stretch'

const KPI_ICON: Record<KpiKey, Icon> = {
  first_verification_passes: SealCheckIcon,
  avoidable_touches: HandPointingIcon,
  asks: ChatCircleDotsIcon,
  recommendation_taken: ScalesIcon,
  errands_no_secret_no_hands: HandPointingIcon,
  issues_closed_per_day: SealCheckIcon,
  test_slot_wait_p50: HourglassIcon,
  minutes_over_ceiling: GaugeIcon,
  specs_not_needed: FileTextIcon,
  specs_per_100: FileTextIcon,
  owner_decisions_per_100: ChatCircleDotsIcon,
  errands_reached_per_100: HandPointingIcon,
  verdict_changes_share: FileTextIcon,
  refusals: ProhibitIcon,
  queue_wait_p90: HourglassIcon,
  cycle_p50: TimerIcon,
  window_points: GaugeIcon,
  cost: CurrencyDollarIcon,
  fix_commits: WrenchIcon,
  queue_capacity_share: HourglassIcon,
  idle_capacity: GaugeIcon,
  working_share: TimerIcon,
  dropped_after_lead: ProhibitIcon,
  nudges_acted: ChatCircleDotsIcon,
  errands_turned_away: HandPointingIcon,
  first_watch_dwell_p50: TimerIcon,
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
      delta={
        kpi.measured && kpi.value !== null
          ? { value: change.text, direction: change.direction, tone: change.tone }
          : undefined
      }
      sub={distanceWords(kpi) ?? undefined}
      meaning={MEANING[kpi.key]}
      extra={PARTS_ON_CARD.has(kpi.key) ? <PartsList kpi={kpi} /> : undefined}
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
          {kpi.parts.length > 0 ? (
            <ul className="mt-2 list-disc pl-4">
              {partWords(kpi).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </MenuPopover>
      }
    />
  )
}

/** What a figure is made of: the largest part named, then every part with its share, largest first. */
function PartsList({ kpi }: { kpi: Kpi }) {
  const rows = partRows(kpi)
  const [largest] = rows
  if (!largest) return null
  return (
    <div className="flex flex-col gap-1.5 text-[length:var(--vx-text-sm)]">
      <p className="font-medium">
        Mostly {largest.label.toLowerCase()}, {Math.round(largest.share * 100)} % of the time Issues waited
      </p>
      <ul aria-label={`${kpi.label}: by reason`} className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 [overflow-wrap:anywhere]">{row.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {row.value}, {Math.round(row.share * 100)} %
              </span>
            </span>
            <Bar share={row.share} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A bar of a share of the largest, on the muted track: width is the only encoding. */
function Bar({ share, tone = 'accent' }: { share: number; tone?: keyof typeof TONE_MARK }) {
  return (
    <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(2, Math.round(share * 100))}%`, backgroundColor: TONE_MARK[tone] }}
      />
    </span>
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
    subtitle: 'This week against the one before',
    meaning: MEANING.fix_commits,
  }
  if (!model || !model.measured) {
    return (
      <StatCard
        {...common}
        hint={KPI_HINT.fix_commits}
        value={model || !pending ? 'Not measured' : 'Loading'}
        sub={model ? 'No fix commit is stored yet: the fix-classes loop has not sorted any' : undefined}
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
      hint={KPI_HINT.fix_commits}
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

function CardGrid({ kpis, model }: { kpis: Kpi[]; model: KpiModel }) {
  return (
    <div className={cn('grid gap-4', LATTICE)}>
      {kpis.map((kpi) => (
        <KpiCard key={kpi.key} kpi={kpi} model={model} />
      ))}
    </div>
  )
}

/** The page by what needs attention: off target first, then the trends, with what is on target and what has no figure (and why) folded below. */
function KpiSections({ model }: { model: KpiModel }) {
  const groups = groupKpis(model.kpis)
  const { met, judged } = targetTally(model.kpis)
  return (
    <>
      <div data-shot="improve-target">
        <Section
          title="Off target"
          aside={judged > 0 ? `${met} of ${judged} targets met, ${groups.off.length} not` : undefined}
        >
          {groups.off.length > 0 ? (
            <CardGrid kpis={groups.off} model={model} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {judged > 0 ? 'Every target that can be judged is met.' : 'No target could be judged.'}
            </p>
          )}
        </Section>
      </div>
      {groups.trend.length > 0 ? (
        <div data-shot="improve-trend">
          <Section title="No target, trends only">
            <CardGrid kpis={groups.trend} model={model} />
          </Section>
        </div>
      ) : null}
      {groups.met.length > 0 ? (
        <div data-shot="improve-met">
          <Fold title="On target" count={groups.met.length}>
            <CardGrid kpis={groups.met} model={model} />
          </Fold>
        </div>
      ) : null}
      {groups.unmeasured.length > 0 ? (
        <div data-shot="improve-unmeasured">
          <Fold title="Not measured" count={groups.unmeasured.length}>
            <CardGrid kpis={groups.unmeasured} model={model} />
          </Fold>
        </div>
      ) : null}
    </>
  )
}

function FrictionRowItem({ row, compared }: { row: FrictionRow; compared: boolean }) {
  return (
    <li className="flex flex-col gap-1 py-2">
      <span className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 [overflow-wrap:anywhere]">{row.label}</span>
        <span className="flex shrink-0 items-baseline gap-4 tabular-nums">
          <span aria-label="Count" className="w-10 text-right font-semibold">
            {row.count}
          </span>
          {compared ? (
            <span aria-label="Change" data-tone={row.tone} className={cn('w-36 text-right', TONE_TEXT[row.tone])}>
              {row.change}
            </span>
          ) : null}
        </span>
      </span>
      <Bar share={row.share} tone={row.tone === 'good' ? 'neutral' : 'accent'} />
    </li>
  )
}

/** The friction kinds ranked by what they counted: the top five in words with their change, the tail folded. */
function FrictionBody({ model }: { model: FrictionModel }) {
  const ranking = frictionRanking(model.counts)
  if (ranking.top.length === 0) {
    return (
      <div className={cn(PANEL, 'p-4')} style={PANEL_SHADOW}>
        <EmptyState title="Nothing counted">
          No friction was recorded in this window. Choose a longer window above.
        </EmptyState>
      </div>
    )
  }
  return (
    <div className={cn(PANEL, 'flex flex-col gap-2 p-4 text-sm')} style={PANEL_SHADOW}>
      <p className="flex justify-end gap-4 text-xs text-muted-foreground">
        <span className="w-10 text-right">Count</span>
        {ranking.compared ? (
          <span className="w-36 text-right">Against the {model.days} days before</span>
        ) : (
          <span>Counting began too recently to compare with the {model.days} days before</span>
        )}
      </p>
      <ul aria-label="Friction, most first" className="divide-y">
        {ranking.top.map((row) => (
          <FrictionRowItem key={row.key} row={row} compared={ranking.compared} />
        ))}
      </ul>
      {ranking.tail.length > 0 ? (
        <Fold title="Everything else that counted" count={ranking.tail.length}>
          <ul aria-label="Friction, the rest" className="divide-y">
            {ranking.tail.map((row) => (
              <FrictionRowItem key={row.key} row={row} compared={ranking.compared} />
            ))}
          </ul>
        </Fold>
      ) : null}
      {ranking.quiet > 0 ? (
        <p className="text-xs text-muted-foreground">{ranking.quiet} more kinds counted nothing in the window.</p>
      ) : null}
    </div>
  )
}

function FrictionSection({ model, pending }: { model: FrictionModel | undefined; pending: boolean }) {
  const aside = model
    ? `${model.issues} Issues filed, ${model.closed} closed in the window${model.since ? `. Counted since ${model.since.slice(0, 10)}` : ''}`
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

/** What each loop that files signals led to: the Issues its signals opened and how those ended, the pace of a close, the kinds it files most. */
function LoopYieldSection({ model }: { model: LoopYieldModel | undefined }) {
  return (
    <div data-shot="improve-yield">
      <Section title="What the loops yielded">
        {model === undefined ? (
          <p className="text-sm text-muted-foreground">Loading</p>
        ) : (
          <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
            <table aria-label="What the loops yielded" className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Loop
                  </th>
                  <th scope="col" className="px-2.5 py-2 font-medium">
                    Days
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">
                    Passes
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">
                    Signals
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">
                    Issues
                  </th>
                  <th scope="col" className="px-2.5 py-2 font-medium">
                    How they ended
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">
                    Median to close
                  </th>
                  <th scope="col" className="px-2.5 py-2 font-medium">
                    Most filed
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {model.loops.flatMap((loop) =>
                  loop.windows.map((window, index) => (
                    <tr key={`${loop.loop}/${window.days}`}>
                      <th scope="row" className="px-4 py-2 text-left font-medium">
                        {index === 0 ? loop.loop : ''}
                      </th>
                      <td className="px-2.5 py-2 tabular-nums">{window.days}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{window.passes ?? '–'}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{window.signals}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{window.issues}</td>
                      <td className="px-2.5 py-2">{yieldWords(window)}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{closeWords(window.medianCloseSeconds)}</td>
                      <td className="px-2.5 py-2 text-muted-foreground">
                        {window.classes.map((c) => `${c.class} (${c.issues})`).join(', ') || '–'}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
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
  idle: 'Idle seat-hours with work ready',
  over: 'Minutes over the load ceiling',
  wait: 'Test slot wait',
} as const

function CapacityCards({ model }: { model: CapacityLoopModel }) {
  const { constants } = model
  const subtitle = `${model.days} days, UTC days`
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
      <section aria-label="Queue waits by reason">
        <Fold title="Queue waits by reason" count={model.queueByReason.length} defaultOpen>
          {model.queueByReason.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No queue wait recorded in the window.</p>
          ) : (
            <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Hours Issues waited to start, and idle seat-hours that fell in minutes they waited, by the reason that
                  kept them from starting
                </caption>
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Reason
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Issues
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Hours
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Idle seats
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {model.queueByReason.map((reason) => (
                    <tr key={reason.kind} className="border-t">
                      <th scope="row" className="px-4 py-2 text-left font-medium">
                        {queueReasonWords(reason.kind)}
                      </th>
                      <td className="px-4 py-2 text-right tabular-nums">{reason.issues}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{hoursWords(reason.queuedHours)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{hoursWords(reason.idleSeatHours)}</td>
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
                <caption className="sr-only">
                  Memory a lead takes per repo, from its process tree samples, as summed resident memory and as physical
                  footprint
                </caption>
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
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Footprint 80th pct
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Footprint / RSS
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
                      <td className="px-4 py-2 text-right tabular-nums">
                        {cost.footprintMibP80 === null ? 'none yet' : mibWords(cost.footprintMibP80)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {cost.footprintToRss === null ? 'none yet' : `${Math.round(cost.footprintToRss * 100)} %`}
                      </td>
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
    <section aria-labelledby="improve-capacity" className="mt-10 grid gap-4">
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

const SEAT_COLUMNS = [
  { key: 'issues', label: 'Issues' },
  { key: 'firstPass', label: 'First verification pass' },
  { key: 'regressions', label: 'Regressions' },
  { key: 'refusals', label: 'Refusals' },
  { key: 'cycle', label: 'Cycle time p50' },
  { key: 'working', label: 'Active time p50' },
  { key: 'cost', label: 'Cost per Issue' },
  { key: 'movedUp', label: 'Moved up' },
] as const

const ATTEMPT_SEAT_COLUMNS = [
  { key: 'attempts', label: 'Attempts' },
  { key: 'issues', label: 'Issues' },
  { key: 'firstPass', label: 'First verification pass' },
  { key: 'cost', label: 'Cost per Issue' },
] as const

function EdgeSection({ model }: { model: KpiModel }) {
  return (
    <div data-shot="improve-edges">
      <Section title="Inferred chain edges" aside="Edges the factory added, created in the window">
        <p className="text-sm text-muted-foreground">{edgeWords(model.edges)}</p>
      </Section>
    </div>
  )
}

function SeatSection({ model }: { model: KpiModel }) {
  const { rows, attemptSeats, tripwire } = model.seats
  return (
    <div data-shot="improve-seats">
      <Section title="By seat" aside="Issues by the seat their first lead ran on">
        <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
          <table className="w-full text-sm">
            <caption className="sr-only">Issues whose first lead started in the window, by the seat it ran on</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Seat
                    <InfoHint word="light seat" className="-my-1" />
                  </span>
                </th>
                {SEAT_COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className="px-4 py-2 text-right font-medium">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cells = seatCells(row)
                return (
                  <tr key={row.seat} className="border-t">
                    <th scope="row" className="px-4 py-2 text-left font-medium">
                      {SEAT_LABEL[row.seat]}
                    </th>
                    {SEAT_COLUMNS.map((column) => (
                      <td key={column.key} className="px-4 py-2 text-right tabular-nums">
                        {cells[column.key]}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{tripwireWords(tripwire)}</p>
      </Section>
      <div data-shot="improve-attempt-seats" className="mt-6">
        <Section title="By attempt seat" aside="Every attempt by the tier and effort it started on">
          <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
            <table className="w-full text-sm">
              <caption className="sr-only">
                Attempts that started in the window, by the tier and effort they ran on
              </caption>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Seat
                  </th>
                  {ATTEMPT_SEAT_COLUMNS.map((column) => (
                    <th key={column.key} scope="col" className="px-4 py-2 text-right font-medium">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {attemptSeats.length === 0 ? (
                  <tr className="border-t">
                    <td colSpan={ATTEMPT_SEAT_COLUMNS.length + 1} className="px-4 py-2 text-muted-foreground">
                      No attempt started in this window
                    </td>
                  </tr>
                ) : (
                  attemptSeats.map((row) => {
                    const cells = attemptSeatCells(row)
                    return (
                      <tr key={cells.seat} className="border-t">
                        <th scope="row" className="px-4 py-2 text-left font-medium">
                          {cells.seat}
                        </th>
                        {ATTEMPT_SEAT_COLUMNS.map((column) => (
                          <td key={column.key} className="px-4 py-2 text-right tabular-nums">
                            {cells[column.key]}
                          </td>
                        ))}
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  )
}

function Improve() {
  const { days = DEFAULT_WINDOW } = Route.useSearch()
  const kpis = useKpis(days)
  const screen = useScreen(kpis)
  const note = useScreenNote(screen, kpis.error)
  const friction = useFriction(days)
  const classes = useFindingClasses()
  const yields = useLoopYield()
  const fixes = useFixCommits()
  const capacity = useCapacityLoop(days)

  if (!kpis.data) {
    return (
      <Page fluid>
        <PageHeader title="Improve" loading={screen === 'loading'} note={note} />
        <WindowSwitch days={days} />
        <WindowSection days={days} />
        {screen === 'loading' ? <ImproveSkeleton /> : null}
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
          <KpiSections model={model} />
          <SeatSection model={model} />
          <EdgeSection model={model} />
          <FixBand model={fixes.data} pending={fixes.isPending} />
          <FrictionSection model={friction.data} pending={friction.isPending} />
          <LoopYieldSection model={yields.data} />
          <FindingClassesSection model={classes.data} />
        </div>
      </div>
      <CapacitySection model={capacity.data} pending={capacity.isPending} />
    </Page>
  )
}
