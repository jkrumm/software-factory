import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { FlowModel, WorkCounts } from '@software-factory/contract'
import { CheckCircleIcon, HourglassIcon, QueueIcon, RocketLaunchIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { DigestStrip } from '@/components/flow/digest-strip'
import { OverviewBand } from '@/components/overview/band'
import { IssueTable } from '@/components/flow/issue-table'
import { TrendChart } from '@/components/flow/trend-chart'
import { StatCard } from '@/components/kit'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ActiveFilters, type FilterChip, SidebarEntry, SidebarSection } from '@/components/sidebar'
import {
  cardsOf,
  countsOf,
  defaultSort,
  type FlowFilters,
  flowNote,
  LIST_LABEL,
  listOf,
  listStateOf,
  openSplits,
  originsOf,
  originWord,
  projectsOf,
  type FlowStat,
  type Sort,
  singleProject,
  sortedCards,
  startSort,
  STATE_KEYS,
  statsOf,
} from '@/lib/flow'
import { useNow } from '@/lib/now'
import { FlowSkeleton } from '@/components/skeletons'
import { useScreen, useScreenNote } from '@/lib/screen'
import { useFlow, useProjectDigests } from '@/lib/queries'

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const Route = createFileRoute('/')({
  /** `project` and `origin` filter the list, `state` picks what it lists: `/?project=argo&state=running` is a linkable view. */
  validateSearch: (search: Record<string, unknown>): FlowFilters => {
    const project = text(search.project)
    const origin = text(search.origin)
    const state = listStateOf(search.state)
    return { ...(project ? { project } : {}), ...(origin ? { origin } : {}), ...(state ? { state } : {}) }
  },
  component: Overview,
})

function FlowSidebar({ data, filters }: { data: FlowModel; filters: FlowFilters }) {
  const projects = openSplits(data, 'repo')
  const origins = openSplits(data, 'origin')
  const entries = (
    name: 'project' | 'origin',
    values: readonly string[],
    splits: Record<string, WorkCounts>,
    word: (value: string) => string,
  ) =>
    values.map((value) => {
      const pressed = filters[name] === value
      return (
        <SidebarEntry
          key={value}
          label={word(value)}
          open={splits[value]}
          pressed={pressed}
          render={(props) => <Link to="/" search={{ ...filters, [name]: pressed ? undefined : value }} {...props} />}
        />
      )
    })
  const all = (name: 'project' | 'origin') => (
    <SidebarEntry
      label="All"
      pressed={!filters[name]}
      render={(props) => <Link to="/" search={{ ...filters, [name]: undefined }} {...props} />}
    />
  )
  return (
    <>
      <SidebarSection title="Projects">
        {all('project')}
        {entries('project', projectsOf(data), projects, (v) => v)}
      </SidebarSection>
      <SidebarSection title="Origin">
        {all('origin')}
        {entries('origin', originsOf(data), origins, originWord)}
      </SidebarSection>
    </>
  )
}

const STAT_ICON = {
  running: RocketLaunchIcon,
  paused: HourglassIcon,
  notStarted: QueueIcon,
  shipped: CheckCircleIcon,
} as const

/** The domain word each card carries an InfoHint for. */
const STAT_HINT = {
  running: 'running',
  paused: 'paused',
  notStarted: 'not started',
  shipped: 'shipped this week',
} as const

/** The four stat cards: factory-wide, each opens the list of the Issues it counts. */
function StatRow({ data, now }: { data: FlowModel; now: number }) {
  return (
    <div
      aria-label="Totals"
      role="group"
      className="-mx-4 mb-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-2 lg:overflow-visible lg:px-0 xl:grid-cols-4"
    >
      {statsOf(data, now).map((stat: FlowStat) => (
        <StatCard
          key={stat.key}
          className="w-72 shrink-0 snap-start lg:w-auto"
          icon={STAT_ICON[stat.key]}
          title={stat.title}
          hint={STAT_HINT[stat.key]}
          subtitle={stat.subtitle}
          value={stat.value}
          delta={{ value: stat.delta, higherIsBetter: stat.higherIsBetter }}
          sub={stat.sub}
          series={stat.series ? { values: stat.series, labels: stat.labels } : undefined}
          bars={stat.bars}
          barLabels={stat.bars ? stat.labels : undefined}
          xLabels={stat.xLabels}
          footer={stat.footer}
          as={(props) => <Link to="/" search={{ state: stat.state }} {...props} />}
        />
      ))}
    </div>
  )
}

/**
 * The Issues behind a filter: a heading with their count, a link to the Chain, and the table. With no filter set it is
 * collapsed to its heading and one line saying what opens it. Sorting is the list's own state, reset when the list's
 * state changes.
 */
function FlowList({ data, filters, now }: { data: FlowModel; filters: FlowFilters; now: number }) {
  const [picked, setPicked] = useState<Sort | null>(null)
  const filtered = Boolean(filters.state || filters.project || filters.origin)
  if (!filtered) {
    return (
      <section aria-labelledby="flow-list" data-testid="flow-list" data-collapsed="true" className="mb-4">
        <h2 id="flow-list" className="border-b pb-1.5 text-sm font-medium text-muted-foreground">
          Issues
        </h2>
        <p className="pt-2 text-sm text-muted-foreground">
          Pick a word, a project or an origin to list its Issues here.
        </p>
      </section>
    )
  }
  const cards = listOf(cardsOf(data, filters), filters.state)
  const sort = picked ?? defaultSort(filters.state)
  const rows = sortedCards(cards, sort)
  const project = filters.project ?? singleProject(cards)
  const onSort = (key: Sort['key']) =>
    setPicked(sort.key === key ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' } : startSort(key))
  const title = filters.state ? LIST_LABEL[filters.state] : 'Issues'
  return (
    <section aria-labelledby="flow-list" data-testid="flow-list" className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b pb-1.5">
        <h2 id="flow-list" className="text-sm font-medium text-muted-foreground">
          {title} <span className="tabular-nums">{cards.length}</span>
        </h2>
        {filters.state ? (
          <Link
            to="/"
            search={{ ...filters, state: undefined }}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Show all states
          </Link>
        ) : null}
        <Link
          to="/chain"
          search={project ? { project } : {}}
          className="ml-auto text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          See how these depend
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">No Issue matches this filter.</p>
      ) : (
        <IssueTable label={`${title} Issues`} cards={rows} sort={sort} onSort={onSort} now={now} />
      )}
    </section>
  )
}

/** The active filters as chips, each a link that clears its own. */
function chipsOf(filters: FlowFilters): FilterChip[] {
  const clear =
    (name: keyof FlowFilters): FilterChip['render'] =>
    (props) => <Link to="/" search={{ ...filters, [name]: undefined }} {...props} />
  const chips: FilterChip[] = []
  if (filters.state) chips.push({ key: 'state', label: `State: ${LIST_LABEL[filters.state]}`, render: clear('state') })
  if (filters.project) chips.push({ key: 'project', label: `Project: ${filters.project}`, render: clear('project') })
  if (filters.origin)
    chips.push({ key: 'origin', label: `Origin: ${originWord(filters.origin)}`, render: clear('origin') })
  return chips
}

const SELECT =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

/**
 * The home screen: what wants the owner, production, what shipped and the host with the queue's reason on top, then the
 * counts with their trend, the project digests, and the list of Issues a filter opens. It was Flow; `/flow` redirects here.
 */
function Overview() {
  const flow = useFlow()
  const digests = useProjectDigests()
  const { data, error } = flow
  const screen = useScreen(flow)
  const note = useScreenNote(screen, error)
  // the root route validates nothing, so an unknown `state` still reaches here from the raw URL: read it through the guard again
  const search = Route.useSearch()
  const filters: FlowFilters = { ...search, state: listStateOf(search.state) }
  const navigate = useNavigate({ from: Route.fullPath })
  const now = useNow(30_000)

  if (!data)
    return (
      <Page fluid>
        <PageHeader title="Overview" loading={screen === 'loading'} note={note} />
        {screen === 'loading' ? <FlowSkeleton /> : null}
      </Page>
    )

  const everything = countsOf(cardsOf(data))
  if (STATE_KEYS.every((key) => everything[key] === 0)) {
    return (
      <Page fluid>
        <PageHeader title="Overview" />
        <OverviewBand data={data} now={now} />
        <EmptyState title="Nothing in flight">Issues show here as they are filed and while they move.</EmptyState>
      </Page>
    )
  }

  const setFilter = (name: 'project' | 'origin', value: string) =>
    void navigate({ search: { ...filters, [name]: value || undefined }, replace: true })

  return (
    <Page fluid>
      <PageHeader title="Overview" note={flowNote(countsOf(cardsOf(data, filters)))} />
      <OverviewBand data={data} now={now} />
      <StatRow data={data} now={now} />
      <TrendChart />
      <DigestStrip digests={digests.data?.projects ?? []} now={now} project={filters.project} />
      <FlowSidebar data={data} filters={filters} />
      <ActiveFilters chips={chipsOf(filters)} />
      <div className="mb-4 flex flex-wrap gap-3 md:hidden">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Project
          <select
            className={SELECT}
            value={filters.project ?? ''}
            onChange={(e) => setFilter('project', e.target.value)}
          >
            <option value="">All projects</option>
            {projectsOf(data).map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Origin
          <select className={SELECT} value={filters.origin ?? ''} onChange={(e) => setFilter('origin', e.target.value)}>
            <option value="">All origins</option>
            {originsOf(data).map((origin) => (
              <option key={origin} value={origin}>
                {originWord(origin)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FlowList key={filters.state ?? 'all'} data={data} filters={filters} now={now} />
    </Page>
  )
}
