import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { Schedule } from '@/components/chain/schedule'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ActiveFilters, SidebarEntry, SidebarSection } from '@/components/sidebar'
import { type ChainFilters, chainCounts, chainOf, isolatedNote, projectsOf } from '@/lib/chain'
import { ChainSkeleton } from '@/components/skeletons'
import { failureNote } from '@/lib/api'
import { collapseOf, toggled } from '@/lib/chain-collapse'
import { useScreen } from '@/lib/screen'
import { chainQuery, queryClient, useChain } from '@/lib/queries'

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const Route = createFileRoute('/chain')({
  /** `project` keeps that project's nodes and the nodes they are joined to: `/chain?project=argo` is a linkable view. */
  validateSearch: (search: Record<string, unknown>): ChainFilters => {
    const project = text(search.project)
    return project ? { project } : {}
  },
  /**
   * xyflow and dagre are their own chunk, the other screens do not carry them. The loader fetches it (and the chain)
   * ahead of the paint: the router runs it on hover and focus of the sidebar link, and `main.tsx` preloads the route
   * when the page is idle, so the first paint finds the graph's code already evaluated.
   */
  loader: () => {
    void queryClient.prefetchQuery(chainQuery)
    return import('@/components/chain/graph')
  },
  component: Chain,
})

const SELECT =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function Chain() {
  const chain = useChain()
  const { data, error } = chain
  const screen = useScreen(chain)
  const filters = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { default: ChainGraph } = Route.useLoaderData()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [opened, setOpened] = useState<string | null>(null)
  const open = useCallback((id: string) => {
    setExpanded((now) => toggled(now, id))
    setOpened(id)
  }, [])
  const whole = useMemo(() => (data ? chainOf(data, filters) : null), [data, filters])
  const view = useMemo(() => (whole ? collapseOf(whole, expanded) : null), [whole, expanded])
  // the rows of the group opened last, for the graph to bring into view; what no longer exists in the view is none
  const focus = useMemo(() => {
    if (!whole || !opened || !expanded.has(opened)) return []
    const group = collapseOf(whole).groups.find((candidate) => candidate.id === opened)
    return group ? group.members.map((member) => member.id) : []
  }, [whole, opened, expanded])

  if (!data || !whole || !view)
    return (
      <Page full>
        <PageHeader
          title="Chain"
          compact
          loading={screen === 'loading'}
          note={screen === 'failed' ? failureNote(error) : undefined}
        />
        {screen === 'loading' ? <ChainSkeleton /> : null}
      </Page>
    )

  const projects = [...new Set([...projectsOf(data), ...(filters.project ? [filters.project] : [])])].sort()
  const counts = chainCounts(data)
  const waiting = whole.edges.filter((edge) => !edge.closed).length
  const scheduled = data.nodes.filter((node) => node.notBefore && (!filters.project || node.repo === filters.project))
  const isolated = filters.project ? (counts.projects[filters.project]?.isolated ?? 0) : counts.isolated
  const folded =
    view.groups.length > 0
      ? `. ${view.folded} of ${whole.nodes.length} nodes are folded into ${view.groups.length} groups`
      : ''
  const note = `${waiting} blocked, ${whole.edges.length - waiting} done${folded}${isolated > 0 ? `. ${isolatedNote(isolated)}` : ''}`

  return (
    <Page full>
      <PageHeader title="Chain" note={note} compact />
      <SidebarSection title="Projects">
        <SidebarEntry
          label="All"
          pressed={!filters.project}
          render={(props) => <Link to="/chain" search={{}} {...props} />}
        />
        {projects.map((repo) => (
          <SidebarEntry
            key={repo}
            label={repo}
            count={counts.projects[repo]?.drawn ?? 0}
            pressed={filters.project === repo}
            render={(props) => (
              <Link to="/chain" search={filters.project === repo ? {} : { project: repo }} {...props} />
            )}
          />
        ))}
      </SidebarSection>
      <ActiveFilters
        chips={
          filters.project
            ? [
                {
                  key: 'project',
                  label: `Project: ${filters.project}`,
                  render: (props) => <Link to="/chain" search={{}} {...props} />,
                },
              ]
            : []
        }
      />
      {expanded.size > 0 || view.groups.length > 0 ? (
        <div className="mb-3 flex min-h-7 items-center gap-3 text-sm text-muted-foreground">
          {expanded.size === 0 ? <span>Groups open on a click</span> : null}
          {expanded.size > 0 ? (
            <>
              <span>
                {expanded.size} {expanded.size === 1 ? 'group is' : 'groups are'} open
              </span>
              <button
                type="button"
                className="h-7 rounded-lg bg-accent px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => {
                  setExpanded(new Set())
                  setOpened(null)
                }}
              >
                Fold all
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3 md:hidden">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Project
          <select
            className={SELECT}
            value={filters.project ?? ''}
            onChange={(e) => void navigate({ search: { project: e.target.value || undefined }, replace: true })}
          >
            <option value="">All projects</option>
            {projects.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </label>
      </div>
      {whole.edges.length === 0 ? (
        <EmptyState title="No dependencies">
          {filters.project
            ? `${filters.project} has no Issue or plan row that waits or is waited for.`
            : 'Issues and plan rows that wait for another show here, blocker to dependent.'}
        </EmptyState>
      ) : (
        <ChainGraph view={view} resetKey={filters.project ?? ''} onOpen={open} focus={focus} />
      )}
      {scheduled.length > 0 ? <Schedule nodes={scheduled} /> : null}
    </Page>
  )
}
