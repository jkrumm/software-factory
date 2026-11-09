import type {
  FindingClassesModel,
  FixCommitsModel,
  FrictionModel,
  Kpi,
  KpiKey,
  KpiModel,
} from '@software-factory/contract'
import { createFileRoute, Link } from '@tanstack/react-router'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection, useSidebarCollapsed } from '@/components/sidebar'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import {
  classWords,
  DEFAULT_WINDOW,
  FRICTION_GROUP_LABEL,
  fixClassRows,
  fixWeekLabel,
  fixWeeksOldestFirst,
  fixWeekTotals,
  formatKpi,
  perIssueWords,
  sampleWords,
  STATUS_LABEL,
  targetStatus,
  targetWords,
  type TargetStatus,
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

const HEADLINE: readonly KpiKey[] = [
  'first_verification_passes',
  'avoidable_touches',
  'asks',
  'queue_wait_p90',
  'refusals',
]
const USAGE: readonly KpiKey[] = ['window_points', 'cost']

const STATUS_CLASS: Record<TargetStatus, string> = {
  met: 'bg-good/15 text-good',
  missed: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
  trend: 'bg-muted text-muted-foreground',
  no_target: 'bg-muted text-muted-foreground',
  no_data: 'bg-muted text-muted-foreground',
  not_measured: 'bg-muted text-muted-foreground',
}

function StatusBadge({ kpi }: { kpi: Kpi }) {
  const status = targetStatus(kpi)
  return <Badge className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</Badge>
}

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

function HeadlineCard({ kpi }: { kpi: Kpi }) {
  return (
    <li className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3">
      <span className="text-sm text-muted-foreground">{kpi.label}</span>
      <span className="font-heading text-2xl font-semibold tabular-nums">{formatKpi(kpi)}</span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge kpi={kpi} />
        {targetWords(kpi)}
      </span>
    </li>
  )
}

type KpiList = KpiModel['kpis']

const pick = (kpis: KpiList, keys: readonly KpiKey[]) => keys.flatMap((key) => kpis.filter((k) => k.key === key))

function TargetsSection({ kpis }: { kpis: KpiList }) {
  return (
    <section aria-labelledby="improve-targets" className="grid gap-3">
      <h2 id="improve-targets" className="text-sm font-medium text-muted-foreground">
        Targets
      </h2>
      <ul aria-label="Headline" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {pick(kpis, HEADLINE).map((kpi) => (
          <HeadlineCard key={kpi.key} kpi={kpi} />
        ))}
      </ul>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              {['Measure', 'Value', 'Target', 'Status', 'Counted'].map((name) => (
                <th key={name} scope="col" className="px-4 py-2 font-medium">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kpis.map((kpi) => (
              <tr key={kpi.key} className="border-t align-top">
                <th scope="row" className="px-4 py-2 text-left font-medium">
                  {kpi.label}
                  <details className="mt-1 font-normal text-muted-foreground">
                    <summary className="cursor-pointer text-xs">What is counted</summary>
                    <p className="mt-1 max-w-prose text-xs">{kpi.definition}</p>
                  </details>
                </th>
                <td className="px-4 py-2 tabular-nums">{formatKpi(kpi)}</td>
                <td className="px-4 py-2 text-muted-foreground">{targetWords(kpi)}</td>
                <td className="px-4 py-2">
                  <StatusBadge kpi={kpi} />
                </td>
                <td className="px-4 py-2 text-muted-foreground tabular-nums">{sampleWords(kpi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function UsageSection({ kpis }: { kpis: KpiList }) {
  return (
    <section aria-labelledby="improve-usage" className="grid gap-3">
      <h2 id="improve-usage" className="text-sm font-medium text-muted-foreground">
        Usage
      </h2>
      <ul className="grid grid-cols-2 gap-3">
        {pick(kpis, USAGE).map((kpi) => (
          <li key={kpi.key} className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3">
            <span className="text-sm text-muted-foreground">{kpi.label}</span>
            <span className="font-heading text-2xl font-semibold tabular-nums">{formatKpi(kpi)}</span>
            <span className="text-xs text-muted-foreground">
              {kpi.measured ? sampleWords(kpi) : 'Not measured: the usage schema is not joined here'}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
    <div className="rounded-xl border bg-card px-4 py-3">
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
        <ul aria-label="Held finding classes" className="divide-y rounded-xl border bg-card px-4 text-sm">
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

function FixClassesSection({ model, pending }: { model: FixCommitsModel | undefined; pending: boolean }) {
  const rows = model ? fixClassRows(model) : []
  return (
    <section aria-labelledby="improve-fix-commits" className="grid gap-3">
      <h2 id="improve-fix-commits" className="text-sm font-medium text-muted-foreground">
        Fix commits by class
      </h2>
      {!model || !model.measured ? (
        <p className="text-sm text-muted-foreground">
          {model ? 'No fix commits stored yet.' : pending ? 'Loading' : 'No data yet'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
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

  if (!kpis.data) {
    return (
      <Page>
        <PageHeader title="Improve" note={kpis.isPending ? 'Loading' : failureNote(kpis.error)} />
        <WindowSwitch days={days} />
        <WindowSection days={days} />
      </Page>
    )
  }
  const model = kpis.data
  return (
    <Page>
      <PageHeader title="Improve" note={`Last ${model.days} days, ${windowWords(model.window)}`} />
      <WindowSwitch days={days} />
      <WindowSection days={days} />
      <div className="grid gap-8">
        <TargetsSection kpis={model.kpis} />
        <UsageSection kpis={model.kpis} />
        <FrictionSection model={friction.data} pending={friction.isPending} />
        <FixClassesSection model={fixes.data} pending={fixes.isPending} />
        <FindingClassesSection model={classes.data} />
      </div>
    </Page>
  )
}
