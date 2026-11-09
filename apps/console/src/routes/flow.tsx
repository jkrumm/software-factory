import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { FlowModel } from '@software-factory/contract'
import { useState } from 'react'
import { FlowCardView } from '@/components/flow/card'
import { FlowList } from '@/components/flow/list'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { SidebarEntry, SidebarSection } from '@/components/sidebar'
import {
  boardNote,
  boardOf,
  COLUMN_KEYS,
  COLUMN_LABEL,
  type ColumnKey,
  columnKeyOf,
  countsOf,
  defaultTab,
  facetCounts,
  type FlowFilters,
  originsOf,
  originWord,
  projectsOf,
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
  const projects = facetCounts(data, 'repo')
  const origins = facetCounts(data, 'origin')
  const entries = (
    name: 'project' | 'origin',
    values: readonly string[],
    counts: Record<string, number>,
    word: (value: string) => string,
  ) =>
    values.map((value) => {
      const pressed = filters[name] === value
      return (
        <SidebarEntry
          key={value}
          label={word(value)}
          count={counts[value] ?? 0}
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
    <Page wide>
      <PageHeader title="Flow" note={boardNote(counts)} />
      <FlowSidebar data={data} filters={filters} />
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
        <section aria-labelledby={`flow-${filters.state}`} className="grid gap-3">
          <div className="flex items-baseline gap-3">
            <h2 id={`flow-${filters.state}`} className="text-sm font-medium text-muted-foreground">
              {COLUMN_LABEL[filters.state]} <span className="tabular-nums">{counts[filters.state]}</span>
            </h2>
            <Link
              to="/flow"
              search={{ ...filters, state: undefined }}
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Show all states
            </Link>
          </div>
          {board[filters.state].length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">Nothing here</p>
          ) : (
            <ul
              aria-labelledby={`flow-${filters.state}`}
              className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] items-start gap-3"
            >
              {board[filters.state].map((card) => (
                <li key={card.key}>
                  <FlowCardView card={card} now={now} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : wide ? (
        <div className="flex items-start gap-4 overflow-x-auto pb-2">
          {columns.map((key) => (
            <section key={key} aria-labelledby={`flow-${key}`} className="flex w-72 shrink-0 flex-col gap-2">
              <h2 id={`flow-${key}`} className="text-sm font-medium text-muted-foreground">
                {COLUMN_LABEL[key]} <span className="tabular-nums">{counts[key]}</span>
              </h2>
              <FlowList
                cards={board[key]}
                now={now}
                labelledBy={`flow-${key}`}
                className="max-h-[calc(100dvh-14rem)]"
              />
            </section>
          ))}
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
              className="max-h-[calc(100dvh-18rem)]"
            />
          </div>
        </div>
      )}
    </Page>
  )
}
