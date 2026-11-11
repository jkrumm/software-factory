import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { FlowModel } from '@software-factory/contract'
import { CheckCircleIcon, HourglassIcon, QueueIcon, RocketLaunchIcon } from '@phosphor-icons/react'
import { type ReactNode, useState } from 'react'
import { FlowCardView } from '@/components/flow/card'
import { EmptyColumn } from '@/components/flow/empty'
import { FlowList } from '@/components/flow/list'
import { InfoHint, type InfoWord, StatCard } from '@/components/kit'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ActiveFilters, SidebarEntry, SidebarSection } from '@/components/sidebar'
import {
  boardColumns,
  boardNote,
  boardOf,
  COLUMN_KEYS,
  COLUMN_LABEL,
  type ColumnKey,
  columnKeyOf,
  countsOf,
  defaultTab,
  type FlowFilters,
  type OpenSplit,
  openSplits,
  originsOf,
  originWord,
  projectsOf,
  type FlowStat,
  statsOf,
  visibleColumns,
} from '@/lib/flow'
import { useMediaQuery } from '@/lib/media'
import { useNow } from '@/lib/now'
import { failureNote } from '@/lib/api'
import { useFlow } from '@/lib/queries'
import { cn } from '@/lib/utils'

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const Route = createFileRoute('/flow')({
  /** `project` and `origin` filter the board, `state` shows one column: `/flow?project=argo&state=working` is a linkable view. */
  validateSearch: (search: Record<string, unknown>): FlowFilters => {
    const project = text(search.project)
    const origin = text(search.origin)
    const state = columnKeyOf(search.state)
    return { ...(project ? { project } : {}), ...(origin ? { origin } : {}), ...(state ? { state } : {}) }
  },
  component: Flow,
})

function FlowSidebar({ data, filters }: { data: FlowModel; filters: FlowFilters }) {
  const projects = openSplits(data, 'repo')
  const origins = openSplits(data, 'origin')
  const entries = (
    name: 'project' | 'origin',
    values: readonly string[],
    splits: Record<string, OpenSplit>,
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
          render={(props) => (
            <Link to="/flow" search={{ ...filters, [name]: pressed ? undefined : value }} {...props} />
          )}
        />
      )
    })
  const all = (name: 'project' | 'origin') => (
    <SidebarEntry
      label="All"
      pressed={!filters[name]}
      render={(props) => <Link to="/flow" search={{ ...filters, [name]: undefined }} {...props} />}
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
  working: RocketLaunchIcon,
  waiting: HourglassIcon,
  queued: QueueIcon,
  settling: QueueIcon,
  watching: QueueIcon,
  shipped: CheckCircleIcon,
} as const

/** The four stat cards: factory-wide, each opens the column it counts. */
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
          subtitle={stat.subtitle}
          value={stat.value}
          delta={{ value: stat.delta, higherIsBetter: stat.higherIsBetter }}
          sub={stat.sub}
          series={stat.series ? { values: stat.series, labels: stat.labels } : undefined}
          bars={stat.bars}
          barLabels={stat.bars ? stat.labels : undefined}
          xLabels={stat.xLabels}
          footer={stat.footer}
          as={(props) => <Link to="/flow" search={{ state: stat.state }} {...props} />}
        />
      ))}
    </div>
  )
}

/** A column's label and count as the h2 (nothing else inside it), the word's InfoHint beside it, a hairline under. */
function ColumnHeader({ column, count, children }: { column: ColumnKey; count: number; children?: ReactNode }) {
  const word: InfoWord = column === 'closed' ? 'outcome' : column
  return (
    <div className="flex items-center gap-1 border-b pb-1.5">
      <h2 id={`flow-${column}`} className="text-sm font-medium text-muted-foreground">
        {COLUMN_LABEL[column]} <span className="tabular-nums">{count}</span>
      </h2>
      <InfoHint word={word} />
      {children}
    </div>
  )
}

const SELECT =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function Flow() {
  const { data, error, isPending } = useFlow()
  // the root route validates nothing, so an unknown `state` still reaches here from the raw URL: read it through the guard again
  const search = Route.useSearch()
  const filters: FlowFilters = { ...search, state: columnKeyOf(search.state) }
  const navigate = useNavigate({ from: Route.fullPath })
  const now = useNow(30_000)
  const wide = useMediaQuery('(min-width: 1024px)')
  const [picked, setPicked] = useState<ColumnKey | null>(null)

  if (!data)
    return (
      <Page wide>
        <PageHeader title="Flow" note={isPending ? 'Loading' : failureNote(error)} />
      </Page>
    )

  const everything = countsOf(boardOf(data))
  if (COLUMN_KEYS.every((key) => everything[key] === 0)) {
    return (
      <Page wide>
        <PageHeader title="Flow" />
        <EmptyState title="Nothing in flight">Issues show here as they are filed and while they move.</EmptyState>
      </Page>
    )
  }

  const board = boardOf(data, filters)
  const counts = countsOf(board)
  const setFilter = (name: 'project' | 'origin', value: string) =>
    void navigate({ search: { ...filters, [name]: value || undefined }, replace: true })
  const tab = picked ?? filters.state ?? defaultTab(counts)
  const columns = visibleColumns(filters.state)

  return (
    <Page full>
      <PageHeader title="Flow" note={boardNote(counts)} />
      <StatRow data={data} now={now} />
      <FlowSidebar data={data} filters={filters} />
      <ActiveFilters
        chips={(['project', 'origin'] as const).flatMap((name) => {
          const value = filters[name]
          if (!value) return []
          return [
            {
              key: name,
              label: `${name === 'project' ? 'Project' : 'Origin'}: ${name === 'origin' ? originWord(value) : value}`,
              render: (props) => <Link to="/flow" search={{ ...filters, [name]: undefined }} {...props} />,
            },
          ]
        })}
      />
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
      {wide && filters.state ? (
        <section aria-labelledby={`flow-${filters.state}`} className="flex min-h-0 flex-1 flex-col gap-3">
          <ColumnHeader column={filters.state} count={counts[filters.state]}>
            <Link
              to="/flow"
              search={{ ...filters, state: undefined }}
              className="ml-3 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Show all states
            </Link>
          </ColumnHeader>
          {board[filters.state].length === 0 ? (
            <EmptyColumn column={filters.state} />
          ) : (
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
              <ul
                aria-labelledby={`flow-${filters.state}`}
                className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] items-start gap-3"
              >
                {board[filters.state].map((card) => (
                  <li key={card.key}>
                    <FlowCardView card={card} now={now} showState={filters.state === 'closed'} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : wide ? (
        <div
          data-testid="flow-board"
          className="-mx-1 min-h-[28rem] flex-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
        >
          <div className="grid h-full gap-4" style={{ gridTemplateColumns: boardColumns(columns, counts) }}>
            {columns.map((key) => (
              <section key={key} aria-labelledby={`flow-${key}`} className="flex min-h-0 min-w-0 flex-col gap-2">
                <ColumnHeader column={key} count={counts[key]} />
                <FlowList
                  cards={board[key]}
                  now={now}
                  labelledBy={`flow-${key}`}
                  column={key}
                  showState={key === 'closed'}
                  className="min-h-0 flex-1"
                />
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <div role="tablist" aria-label="State" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {COLUMN_KEYS.map((key) => (
              <button
                key={key}
                id={`flow-tab-${key}`}
                type="button"
                role="tab"
                aria-selected={tab === key}
                aria-controls="flow-panel"
                onClick={() => setPicked(key)}
                className={cn(
                  'shrink-0 cursor-pointer rounded-full border px-3 py-1 text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  tab === key
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground',
                )}
              >
                {COLUMN_LABEL[key]} <span className="tabular-nums">{counts[key]}</span>
              </button>
            ))}
          </div>
          <div id="flow-panel" role="tabpanel" aria-labelledby={`flow-tab-${tab}`}>
            <FlowList
              key={tab}
              cards={board[tab]}
              now={now}
              labelledBy={`flow-tab-${tab}`}
              column={tab}
              showState={tab === 'closed'}
              className="max-h-[calc(100dvh-18rem)]"
            />
          </div>
        </div>
      )}
    </Page>
  )
}
