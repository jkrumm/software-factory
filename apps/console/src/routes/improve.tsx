import type {
  FindingClassesModel,
  FixCommitsModel,
  FrictionModel,
  Kpi,
  KpiKey,
  KpiModel,
  LoopYieldModel,
  SeatsModel,
} from '@software-factory/contract'
import {
  FileTextIcon,
  GaugeIcon,
  HandPointingIcon,
  HourglassIcon,
  type Icon,
  SealCheckIcon,
  TimerIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useWindowKeys } from '@/components/shortcuts'
import { Fold, InfoHint, MenuPopover, Section, Skeleton, Sparkline, StackedBars, StatCard } from '@/components/kit'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection, useSidebarCollapsed } from '@/components/sidebar'
import { TONE_MARK, TONE_TEXT } from '@/components/kit/tone'
import { buttonVariants } from '@/components/ui/button'
import {
  chartTarget,
  classIsQuiet,
  classWords,
  closeWords,
  yieldWords,
  comparisonWords,
  DEFAULT_WINDOW,
  besideWords,
  drawsHistory,
  FIX_HINT,
  FIX_MEANING,
  fixCard,
  formatKpi,
  formatValue,
  frictionRanking,
  groupKpis,
  historyLabels,
  historyValues,
  historyXLabels,
  kpiChange,
  KPI_HINT,
  kpiFooter,
  partWords,
  subWords,
  lineTone,
  SEAT_LABEL,
  seatCells,
  shortDate,
  type FrictionRow,
  MEANING,
  PARTS_ON_CARD,
  partRows,
  targetTally,
  reviewerCells,
  reviewerTripwireWords,
  REVIEWER_LABEL,
  tripwireWords,
  deliveryRows,
  WINDOW_DAYS,
  windowOf,
  windowWords,
} from '@/lib/improve'
import { ImproveSkeleton } from '@/components/skeletons'
import { useScreen, useScreenNote } from '@/lib/screen'
import { useFindingClasses, useFixCommits, useFriction, useKpis, useLoopYield, useSeats } from '@/lib/queries'
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
  avoidable_touches: HandPointingIcon,
  first_verification_passes: SealCheckIcon,
  specs_not_needed: FileTextIcon,
  errands_reached_per_100: HandPointingIcon,
  cycle_p50: TimerIcon,
  queue_wait_p90: HourglassIcon,
  quota_at_reset: GaugeIcon,
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
      sub={subWords(kpi) ?? undefined}
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
          <span className="block">{kpi.definition}</span>
          {kpi.parts.length > 0 ? (
            <ul className="mt-2 list-disc pl-4">
              {partWords(kpi).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {kpi.beside.length > 0 ? (
            <>
              <span className="mt-2 block font-medium">Read beside it</span>
              <ul className="mt-1 list-disc pl-4">
                {besideWords(kpi).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
        </MenuPopover>
      }
    />
  )
}

/** What a figure is made of: the largest part named, then every part with its share of the parts, largest first. */
function PartsList({ kpi }: { kpi: Kpi }) {
  const rows = partRows(kpi)
  const [largest] = rows
  if (!largest) return null
  return (
    <div className="flex flex-col gap-1.5 text-[length:var(--vx-text-sm)]">
      <p className="font-medium">
        Mostly {largest.label.toLowerCase()}, {Math.round(largest.share * 100)} % of the parts
      </p>
      <ul aria-label={`${kpi.label}: by part`} className="flex flex-col gap-1">
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
    meaning: FIX_MEANING,
  }
  if (!model || !model.measured) {
    return (
      <StatCard
        {...common}
        hint={FIX_HINT}
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
      hint={FIX_HINT}
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

/** The seven KPIs in one band, ordered by what needs attention: off target first, then those with no target yet, those on target and those with no figure (each says why). */
function KpiSections({ model }: { model: KpiModel }) {
  const groups = groupKpis(model.kpis)
  const { met, judged } = targetTally(model.kpis)
  return (
    <div data-shot="improve-target">
      <Section title="KPIs" aside={judged > 0 ? `${met} of ${judged} targets met` : 'No target could be judged'}>
        <CardGrid kpis={[...groups.off, ...groups.trend, ...groups.met, ...groups.unmeasured]} model={model} />
      </Section>
    </div>
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
          <PanelTable
            caption="What the loops yielded"
            heads={['Loop', 'Days', 'Passes', 'Signals', 'Issues', 'How they ended', 'Median to close', 'Most filed']}
            left={[1, 5, 7]}
          >
            {model.loops.flatMap((loop) =>
              loop.windows.map((window, index) => (
                <tr key={`${loop.loop}/${window.days}`} className="border-t">
                  <th scope="row" className={ROW_HEAD}>
                    {index === 0 ? loop.loop : ''}
                  </th>
                  <td className="px-4 py-2 tabular-nums">{window.days}</td>
                  <td className={CELL}>{window.passes ?? '–'}</td>
                  <td className={CELL}>{window.signals}</td>
                  <td className={CELL}>{window.issues}</td>
                  <td className="px-4 py-2">{yieldWords(window)}</td>
                  <td className={CELL}>{closeWords(window.medianCloseSeconds)}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {window.classes.map((c) => `${c.class} (${c.issues})`).join(', ') || '–'}
                  </td>
                </tr>
              )),
            )}
          </PanelTable>
        )}
      </Section>
    </div>
  )
}

function FindingClassesSection({ model }: { model: FindingClassesModel | undefined }) {
  const quiet = (model?.classes ?? []).filter(classIsQuiet)
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
                  <span className="text-muted-foreground">
                    {c.status === 'held' ? 'held' : c.status === 'probation' ? 'on probation' : 'on the standard lead'}
                  </span>
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

function FixBand({ model, pending }: { model: FixCommitsModel | undefined; pending: boolean }) {
  return (
    <div data-shot="improve-fix">
      <Section title="Fix commits">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <FixCard model={model} pending={pending} />
        </div>
      </Section>
    </div>
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

const REVIEWER_COLUMNS = [
  { key: 'seat', label: 'Seat' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'findings', label: 'Findings per review' },
  { key: 'applied', label: 'Applied' },
  { key: 'rounds', label: 'Rounds until clean' },
  { key: 'firstPass', label: 'First verification pass' },
  { key: 'regressions', label: 'Regressed Issues' },
  { key: 'cost', label: 'Cost per review' },
  { key: 'wall', label: 'Wall time p50' },
] as const

/** A panel holding one table: a caption for screen readers, the column heads (the first reads left, the rest right) and the body rows. */
function PanelTable({
  caption,
  heads,
  left = [],
  children,
}: {
  caption: string
  heads: ReactNode[]
  /** the indexes of the heads after the first that read left */
  left?: number[]
  children: ReactNode
}) {
  return (
    <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {heads.map((head, i) => (
              <th
                key={i}
                scope="col"
                className={cn('px-4 py-2 font-medium', i > 0 && !left.includes(i) && 'text-right')}
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

const ROW_HEAD = 'px-4 py-2 text-left font-medium'
const CELL = 'px-4 py-2 text-right tabular-nums'

function ReviewerSection({ model }: { model: SeatsModel }) {
  return (
    <div data-shot="improve-reviewers" className="mt-6">
      <Section title="Reviewers" aside="The two reviewer seats over the reviews recorded in the window">
        <PanelTable
          caption="Reviews recorded in the window, by the seat they ran on"
          heads={['Reviewer', ...REVIEWER_COLUMNS.map((c) => c.label)]}
        >
          {model.reviewers.rows.map((row) => {
            const cells = reviewerCells(row)
            return (
              <tr key={row.seat} className="border-t">
                <th scope="row" className={ROW_HEAD}>
                  {REVIEWER_LABEL[row.seat]}
                </th>
                {REVIEWER_COLUMNS.map((column) => (
                  <td key={column.key} className={CELL}>
                    {cells[column.key]}
                  </td>
                ))}
              </tr>
            )
          })}
        </PanelTable>
        {reviewerTripwireWords(model.reviewers).map((line) => (
          <p key={line} className="mt-2 text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </Section>
    </div>
  )
}

function SeatSection({ model }: { model: SeatsModel }) {
  const { rows, tripwire, delivery } = model.seats
  return (
    <div data-shot="improve-seats">
      <Section title="By seat" aside="Issues by the seat their first lead ran on">
        <PanelTable
          caption="Issues whose first lead started in the window, by the seat it ran on"
          heads={[
            <span key="seat" className="inline-flex items-center gap-1">
              Seat
              <InfoHint word="light seat" className="-my-1" />
            </span>,
            ...SEAT_COLUMNS.map((c) => c.label),
          ]}
        >
          {rows.map((row) => {
            const cells = seatCells(row)
            return (
              <tr key={row.seat} className="border-t">
                <th scope="row" className={ROW_HEAD}>
                  {SEAT_LABEL[row.seat]}
                </th>
                {SEAT_COLUMNS.map((column) => (
                  <td key={column.key} className={CELL}>
                    {cells[column.key]}
                  </td>
                ))}
              </tr>
            )
          })}
        </PanelTable>
        <p className="mt-2 text-sm text-muted-foreground">{tripwireWords(tripwire)}</p>
      </Section>
      <div data-shot="improve-light-delivery" className="mt-6">
        <Section title="What the light seat delivers" aside="Four figures beside the lead row's, over the window">
          <PanelTable
            caption="The light seat's delivery against the lead row's, over the window"
            heads={['Figure', 'Light', 'Lead']}
          >
            {deliveryRows(delivery).map((row) => (
              <tr key={row.key} className="border-t align-top">
                <th scope="row" className={ROW_HEAD}>
                  {row.label}
                  <span className="mt-0.5 block max-w-prose text-xs font-normal text-muted-foreground">
                    {row.definition}
                  </span>
                </th>
                <td className={CELL}>{row.light}</td>
                <td className={CELL}>{row.lead}</td>
              </tr>
            ))}
          </PanelTable>
        </Section>
      </div>
    </div>
  )
}

function Improve() {
  const { days = DEFAULT_WINDOW } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  useWindowKeys(WINDOW_DAYS, days, (next) => void navigate({ search: { days: next } }))
  const kpis = useKpis(days)
  const screen = useScreen(kpis)
  const note = useScreenNote(screen, kpis.error)
  const friction = useFriction(days)
  const classes = useFindingClasses()
  const yields = useLoopYield()
  const fixes = useFixCommits()
  const seats = useSeats(days)

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
          {seats.data ? (
            <>
              <SeatSection model={seats.data} />
              <ReviewerSection model={seats.data} />
            </>
          ) : null}
          <FixBand model={fixes.data} pending={fixes.isPending} />
          <FrictionSection model={friction.data} pending={friction.isPending} />
          <LoopYieldSection model={yields.data} />
          <FindingClassesSection model={classes.data} />
        </div>
      </div>
    </Page>
  )
}
