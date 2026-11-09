import type {
  FindingClassesModel,
  FixCommitsModel,
  FrictionModel,
  Kpi,
  KpiKey,
  KpiModel,
} from '@software-factory/contract'
import {
  ChatCircleDotsIcon,
  CurrencyDollarIcon,
  GaugeIcon,
  HandPointingIcon,
  HourglassIcon,
  type Icon,
  ProhibitIcon,
  ScalesIcon,
  SealCheckIcon,
  TimerIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Fold, MenuPopover, Skeleton, Sparkline, StackedBars, StatCard } from '@/components/kit'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection, useSidebarCollapsed } from '@/components/sidebar'
import { buttonVariants } from '@/components/ui/button'
import {
  chartTarget,
  classWords,
  comparisonWords,
  DEFAULT_WINDOW,
  distanceWords,
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
  kpiChange,
  kpiFooter,
  lineTone,
  perIssueWords,
  shortDate,
  WINDOW_DAYS,
  windowOf,
  windowWords,
} from '@/lib/improve'
import { failureNote } from '@/lib/api'
import { useFindingClasses, useFixCommits, useFriction, useKpis } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/improve')({
  /** `days` is one of the three windows; a missing or other value is the default and stays out of the URL. */
  validateSearch: (search: Record<string, unknown>): { days?: number } =>
    search.days === undefined ? {} : { days: windowOf(search.days) },
  component: Improve,
})

/** The KPIs in the Console's own order, the headline measures first (not the table order of `docs/product.md`); the fix-commit card follows them (its data is `/v1/fix-commits`). */
const CARD_ORDER: readonly KpiKey[] = [
  'first_verification_passes',
  'avoidable_touches',
  'asks',
  'worth_asking',
  'refusals',
  'queue_wait_p90',
  'queue_wait_p50',
  'cycle_p50',
  'window_points',
  'cost',
]

const KPI_ICON: Record<KpiKey, Icon> = {
  first_verification_passes: SealCheckIcon,
  avoidable_touches: HandPointingIcon,
  asks: ChatCircleDotsIcon,
  worth_asking: ScalesIcon,
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

function KpiCard({ kpi, model }: { kpi: Kpi; model: KpiModel }) {
  const change = kpiChange(kpi)
  const known = kpi.measured && kpi.history.some((point) => point.value !== null)
  return (
    <StatCard
      icon={KPI_ICON[kpi.key]}
      title={kpi.label}
      subtitle={comparisonWords(model.days)}
      value={formatKpi(kpi)}
      delta={kpi.measured ? { value: change.text, direction: change.direction, tone: change.tone } : undefined}
      sub={kpi.measured ? distanceWords(kpi) : undefined}
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

function FixCard({ model, pending }: { model: FixCommitsModel | undefined; pending: boolean }) {
  const common = {
    icon: WrenchIcon,
    title: 'Fix commits per week',
    subtitle: 'This week against the one before',
    className: '@3xl:col-span-2',
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

function CardGrid({
  model,
  fixes,
  fixesPending,
}: {
  model: KpiModel
  fixes: FixCommitsModel | undefined
  fixesPending: boolean
}) {
  return (
    <div className="@container">
      <div aria-label="Key figures" role="group" className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-4">
        {CARD_ORDER.flatMap((key) => model.kpis.filter((kpi) => kpi.key === key)).map((kpi) => (
          <KpiCard key={kpi.key} kpi={kpi} model={model} />
        ))}
        <FixCard model={fixes} pending={fixesPending} />
      </div>
    </div>
  )
}

function FrictionGroup({
  group,
  counts,
}: {
  group: keyof typeof FRICTION_GROUP_LABEL
  counts: FrictionModel['counts']
}) {
  const rows = counts.filter((c) => c.group === group)
  if (rows.length === 0) return null
  const title = FRICTION_GROUP_LABEL[group]
  return (
    <div className={cn(PANEL, 'px-4 py-3')} style={PANEL_SHADOW}>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <ul aria-label={title} className="divide-y text-sm">
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline justify-between gap-4 py-1.5">
            <span>{row.label}</span>
            <span className="flex gap-4 tabular-nums">
              <span aria-label="Count">{row.count}</span>
              <span aria-label="Per Issue closed" className="w-12 text-right text-muted-foreground">
                {perIssueWords(row.perIssue)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FrictionBody({ model }: { model: FrictionModel }) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {model.issues} Issues filed, {model.closed} closed in the window
        {model.since ? `. Counted since ${model.since.slice(0, 10)}` : ''}
      </p>
      {model.counts.length === 0 ? <EmptyState title="Nothing counted" /> : null}
      {(Object.keys(FRICTION_GROUP_LABEL) as (keyof typeof FRICTION_GROUP_LABEL)[]).map((group) => (
        <FrictionGroup key={group} group={group} counts={model.counts} />
      ))}
    </>
  )
}

function FrictionSection({ model, pending }: { model: FrictionModel | undefined; pending: boolean }) {
  return (
    <section aria-labelledby="improve-friction" className="grid gap-3">
      <h2 id="improve-friction" className="text-sm font-medium text-muted-foreground">
        Friction
      </h2>
      {model ? (
        <FrictionBody model={model} />
      ) : (
        <p className="text-sm text-muted-foreground">{pending ? 'Loading' : 'No data yet'}</p>
      )}
    </section>
  )
}

function FindingClassesSection({ model }: { model: FindingClassesModel | undefined }) {
  const quiet = (model?.classes ?? []).filter((c) => c.status !== 'open')
  return (
    <section aria-labelledby="improve-held-classes" className="grid gap-3">
      <h2 id="improve-held-classes" className="text-sm font-medium text-muted-foreground">
        Held finding classes
      </h2>
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
    </section>
  )
}

function FixClassesSection({ model }: { model: FixCommitsModel | undefined }) {
  if (!model || !model.measured) return null
  const rows = fixClassRows(model)
  return (
    <section aria-label="Fix commits by class">
      <Fold title="Fix commits by class" count={fixWeekTotals(model).reduce((a, b) => a + b, 0)}>
        <div className={cn(PANEL, 'overflow-x-auto')} style={PANEL_SHADOW}>
          <table className="w-full text-sm">
            <caption className="sr-only">Fix commits per class, by the week ending on the date shown</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Class
                </th>
                {fixWeeksOldestFirst(model).map((week) => (
                  <th key={fixWeekLabel(week)} scope="col" className="px-4 py-2 text-right font-medium">
                    {fixWeekLabel(week)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t">
                  <th scope="row" className="px-4 py-2 text-left font-medium" title={row.meaning}>
                    {row.key}
                  </th>
                  {row.counts.map((n, i) => (
                    <td key={i} className="px-4 py-2 text-right tabular-nums">
                      {n}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t font-medium">
                <th scope="row" className="px-4 py-2 text-left">
                  Total
                </th>
                {fixWeekTotals(model).map((n, i) => (
                  <td key={i} className="px-4 py-2 text-right tabular-nums">
                    {n}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Fold>
    </section>
  )
}

function Improve() {
  const { days = DEFAULT_WINDOW } = Route.useSearch()
  const kpis = useKpis(days)
  const friction = useFriction(days)
  const classes = useFindingClasses()
  const fixes = useFixCommits()

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
      <div className="grid gap-8">
        <CardGrid model={model} fixes={fixes.data} fixesPending={fixes.isPending} />
        <div className="grid items-start gap-8 xl:grid-cols-2">
          <FrictionSection model={friction.data} pending={friction.isPending} />
          <div className="grid gap-8">
            <FindingClassesSection model={classes.data} />
            <FixClassesSection model={fixes.data} />
          </div>
        </div>
      </div>
    </Page>
  )
}
