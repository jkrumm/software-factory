import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Ago } from '@/components/issue/ago'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ActiveFilters, type FilterChip, SidebarEntry, SidebarSection } from '@/components/sidebar'
import { Skeleton } from '@/components/kit/skeleton'
import {
  ARTIFACT_KINDS,
  type ArtifactFilters,
  artifactsNote,
  kindCounts,
  projectCounts,
  projectsOfRows,
  rowsOf,
  visibleRows,
} from '@/lib/artifacts'
import { ARTIFACT_KIND_LABEL } from '@/lib/needs'
import { useNow } from '@/lib/now'
import { useArtifactList, useIssueCards } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'

export const Route = createFileRoute('/artifacts/')({
  /** `kind` shows one kind and `project` one project: `/artifacts?kind=report` is a linkable view. */
  validateSearch: (search: Record<string, unknown>): ArtifactFilters => {
    const kind = ARTIFACT_KINDS.find((k) => k === search.kind)
    return {
      ...(kind ? { kind } : {}),
      ...(typeof search.project === 'string' && search.project !== '' ? { project: search.project } : {}),
    }
  },
  component: Artifacts,
})

const ROW_LINK =
  '-mx-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md px-2 py-2.5 outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50'

function Artifacts() {
  const list = useArtifactList()
  const cards = useIssueCards(true)
  const screen = useScreen(list)
  const note = useScreenNote(screen, list.error)
  const { kind, project } = Route.useSearch()
  const now = useNow(30_000)
  const rows = useMemo(
    () => (list.data ? rowsOf(list.data.artifacts, cards.data?.issues ?? []) : []),
    [list.data, cards.data],
  )

  if (!list.data)
    return (
      <Page>
        <PageHeader title="Artifacts" loading={screen === 'loading'} note={note} />
        {screen === 'loading' ? (
          <div aria-busy aria-label="Loading the artifacts" className="grid gap-2">
            {Array.from({ length: 6 }, (_, row) => (
              <Skeleton key={row} height={44} rounded="rounded-md" />
            ))}
          </div>
        ) : null}
      </Page>
    )

  if (rows.length === 0)
    return (
      <Page>
        <PageHeader title="Artifacts" />
        <EmptyState title="No artifact yet">
          A Spec, Concept or Report shows here as soon as a lead hands one over.
        </EmptyState>
      </Page>
    )

  const filters: ArtifactFilters = { ...(kind ? { kind } : {}), ...(project ? { project } : {}) }
  const visible = visibleRows(rows, filters)
  const kinds = kindCounts(rows, project)
  const projects = projectCounts(rows, kind)
  const chips: FilterChip[] = [
    ...(kind
      ? [
          {
            key: 'kind',
            label: `Kind: ${ARTIFACT_KIND_LABEL[kind]}`,
            render: (props: Parameters<FilterChip['render']>[0]) => (
              <Link to="/artifacts" search={project ? { project } : {}} {...props} />
            ),
          },
        ]
      : []),
    ...(project
      ? [
          {
            key: 'project',
            label: `Project: ${project}`,
            render: (props: Parameters<FilterChip['render']>[0]) => (
              <Link to="/artifacts" search={kind ? { kind } : {}} {...props} />
            ),
          },
        ]
      : []),
  ]

  return (
    <Page>
      <PageHeader title="Artifacts" note={artifactsNote(visible.length, rows.length, chips.length > 0)} />
      <SidebarSection title="Kinds">
        <SidebarEntry
          label="All"
          pressed={!kind}
          render={(props) => <Link to="/artifacts" search={project ? { project } : {}} {...props} />}
        />
        {ARTIFACT_KINDS.map((k) => (
          <SidebarEntry
            key={k}
            label={ARTIFACT_KIND_LABEL[k] ?? k}
            count={kinds[k]}
            pressed={kind === k}
            render={(props) => (
              <Link
                to="/artifacts"
                search={{ ...(project ? { project } : {}), ...(kind === k ? {} : { kind: k }) }}
                {...props}
              />
            )}
          />
        ))}
      </SidebarSection>
      <SidebarSection title="Projects">
        <SidebarEntry
          label="All"
          pressed={!project}
          render={(props) => <Link to="/artifacts" search={kind ? { kind } : {}} {...props} />}
        />
        {projectsOfRows(rows, project).map((name) => (
          <SidebarEntry
            key={name}
            label={name}
            count={projects[name] ?? 0}
            pressed={project === name}
            render={(props) => (
              <Link
                to="/artifacts"
                search={{ ...(kind ? { kind } : {}), ...(project === name ? {} : { project: name }) }}
                {...props}
              />
            )}
          />
        ))}
      </SidebarSection>
      <ActiveFilters chips={chips} />
      {visible.length === 0 ? (
        <EmptyState title="Nothing matches">
          No artifact has this kind in this project. Remove a filter to see the rest.
        </EmptyState>
      ) : (
        <ul className="flex flex-col text-[length:var(--vx-text-sm)]">
          {visible.map(({ artifact, issue, issueTitle, project: repo, linked }) => (
            <li key={artifact.id} className="not-first:border-t">
              <Link to="/artifacts/$id" params={{ id: artifact.id }} className={ROW_LINK}>
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{artifact.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {issue ? `Issue ${issue}` : 'No Issue'}
                    {issueTitle ? `: ${issueTitle}` : ''}
                    {repo ? ` · ${repo}` : ''}
                    {linked.length > 0 ? ` · ${issue ? 'also ' : ''}${linked.map((n) => `Issue ${n}`).join(', ')}` : ''}
                  </span>
                </span>
                <Ago iso={artifact.createdAt} now={now} className="font-mono text-xs text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  )
}
