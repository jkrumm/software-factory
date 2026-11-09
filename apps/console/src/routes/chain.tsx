import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { Schedule } from '@/components/chain/schedule'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ActiveFilters, SidebarEntry, SidebarSection } from '@/components/sidebar'
import { type ChainFilters, chainCounts, chainOf, isolatedNote, projectsOf } from '@/lib/chain'
import { failureNote } from '@/lib/api'
import { useChain } from '@/lib/queries'

// xyflow and dagre are their own chunk: the other screens do not carry them
const ChainGraph = lazy(() => import('@/components/chain/graph'))

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const Route = createFileRoute('/chain')({
  /** `project` keeps that project's nodes and the nodes they are joined to: `/chain?project=argo` is a linkable view. */
  validateSearch: (search: Record<string, unknown>): ChainFilters => {
    const project = text(search.project)
    return project ? { project } : {}
  },
  component: Chain,
})

const SELECT =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function Chain() {
  const { data, error, isPending } = useChain()
  const filters = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  if (!data)
    return (
      <Page wide>
        <PageHeader title="Chain" note={isPending ? 'Loading' : failureNote(error)} />
      </Page>
    )

  const view = chainOf(data, filters)
  const projects = [...new Set([...projectsOf(data), ...(filters.project ? [filters.project] : [])])].sort()
  const counts = chainCounts(data)
  const waiting = view.edges.filter((edge) => !edge.closed).length
  const scheduled = data.nodes.filter((node) => node.notBefore && (!filters.project || node.repo === filters.project))
  const isolated = filters.project ? (counts.projects[filters.project]?.isolated ?? 0) : counts.isolated
  const note = `${waiting} blocked, ${view.edges.length - waiting} done${isolated > 0 ? `. ${isolatedNote(isolated)}` : ''}`

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
      {view.edges.length === 0 ? (
        <EmptyState title="No dependencies">
          {filters.project
            ? `${filters.project} has no Issue or plan row that waits or is waited for.`
            : 'Issues and plan rows that wait for another show here, blocker to dependent.'}
        </EmptyState>
      ) : (
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading</p>}>
          <ChainGraph view={view} resetKey={filters.project ?? ''} />
        </Suspense>
      )}
      {scheduled.length > 0 ? <Schedule nodes={scheduled} /> : null}
    </Page>
  )
}
