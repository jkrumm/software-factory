import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import { ArtifactRowLink, CollectionCard, CollectionRow, hiddenTag } from '@/components/collection'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { Fold } from '@/components/kit/fold'
import { Skeleton } from '@/components/kit/skeleton'
import { ActiveFilters, type FilterChip, SidebarEntry, SidebarSection } from '@/components/sidebar'
import {
  ARTIFACT_KINDS,
  type ArtifactFilters,
  artifactsNote,
  entriesOf,
  hiddenRows,
  kindCounts,
  listedRows,
  projectCounts,
  projectsOfRows,
  rowsOf,
  shelfOf,
} from '@/lib/artifacts'
import { ARTIFACT_KIND_LABEL } from '@/lib/needs'
import { useNow } from '@/lib/now'
import { useArtifactList, useCollectionList, useIssueCards } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/artifacts/')({
  /** `kind` shows one kind, `project` one project and `all` the pages the default view leaves out: `/artifacts?kind=report` is a linkable view. */
  validateSearch: (search: Record<string, unknown>): ArtifactFilters => {
    const kind = ARTIFACT_KINDS.find((k) => k === search.kind)
    return {
      ...(kind ? { kind } : {}),
      ...(typeof search.project === 'string' && search.project !== '' ? { project: search.project } : {}),
      ...(search.all === true || search.all === 'true' || search.all === 1 || search.all === '1' ? { all: true } : {}),
    }
  },
  component: Artifacts,
})

/** The switch that brings back the Specs and Decisions of closed Issues and the copies a newer page replaced. */
function ShowAll({ on, search }: { on: boolean; search: ArtifactFilters }) {
  return (
    <Link
      to="/artifacts"
      search={{ ...search, ...(on ? { all: undefined } : { all: true }) }}
      role="switch"
      aria-checked={on}
      className="mb-4 inline-flex cursor-pointer items-center gap-2 rounded-md text-[length:var(--vx-text-sm)] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none',
          on ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'size-4 rounded-full bg-background transition-transform motion-reduce:transition-none',
            on ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
      Show all
    </Link>
  )
}

function Artifacts() {
  const list = useArtifactList()
  const collectionList = useCollectionList()
  const cards = useIssueCards(true)
  const screen = useScreen(list)
  const note = useScreenNote(screen, list.error)
  const { kind, project, all } = Route.useSearch()
  const now = useNow(30_000)
  const rows = useMemo(
    () => (list.data ? rowsOf(list.data.artifacts, cards.data?.issues ?? []) : []),
    [list.data, cards.data],
  )
  const hidden = useMemo(() => hiddenRows(rows), [rows])
  const listed = useMemo(() => listedRows(rows, all === true), [rows, all])
  const entries = useMemo(() => entriesOf(collectionList.data?.collections ?? [], rows), [collectionList.data, rows])

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
  const searchOf = (extra: ArtifactFilters = {}): ArtifactFilters => ({ ...filters, ...(all ? { all } : {}), ...extra })
  const shelf = shelfOf(entries, listed, filters, hidden)
  const kinds = kindCounts(listed, project)
  const projects = projectCounts(listed, kind)
  const filtered = Boolean(kind || project)
  const shown = shelf.groups.reduce((n, group) => n + group.items.length, 0) + shelf.pinned.length
  const left = all ? 0 : hidden.size
  const chips: FilterChip[] = [
    ...(kind
      ? [
          {
            key: 'kind',
            label: `Kind: ${ARTIFACT_KIND_LABEL[kind]}`,
            render: (props: Parameters<FilterChip['render']>[0]) => (
              <Link to="/artifacts" search={{ ...(project ? { project } : {}), ...(all ? { all } : {}) }} {...props} />
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
              <Link to="/artifacts" search={{ ...(kind ? { kind } : {}), ...(all ? { all } : {}) }} {...props} />
            ),
          },
        ]
      : []),
  ]

  return (
    <Page>
      <PageHeader title="Artifacts" note={artifactsNote(shown, listed.length, filtered, left)} />
      <SidebarSection title="Kinds">
        <SidebarEntry
          label="All"
          pressed={!kind}
          render={(props) => <Link to="/artifacts" search={searchOf({ kind: undefined })} {...props} />}
        />
        {ARTIFACT_KINDS.map((k) => (
          <SidebarEntry
            key={k}
            label={ARTIFACT_KIND_LABEL[k] ?? k}
            count={kinds[k]}
            pressed={kind === k}
            render={(props) => (
              <Link to="/artifacts" search={searchOf({ kind: kind === k ? undefined : k })} {...props} />
            )}
          />
        ))}
      </SidebarSection>
      <SidebarSection title="Projects">
        <SidebarEntry
          label="All"
          pressed={!project}
          render={(props) => <Link to="/artifacts" search={searchOf({ project: undefined })} {...props} />}
        />
        {projectsOfRows(listed, project).map((name) => (
          <SidebarEntry
            key={name}
            label={name}
            count={projects[name] ?? 0}
            pressed={project === name}
            render={(props) => (
              <Link to="/artifacts" search={searchOf({ project: project === name ? undefined : name })} {...props} />
            )}
          />
        ))}
      </SidebarSection>
      <ActiveFilters chips={chips} />
      <ShowAll on={all === true} search={filters} />
      {shelf.pinned.length > 0 ? (
        <section aria-label="Pinned collections" className="mb-8">
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {shelf.pinned.map((entry) => (
              <li key={entry.collection.id} className="flex">
                <div className="flex w-full flex-col">
                  <CollectionCard entry={entry} now={now} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {shelf.groups.length === 0 && shelf.pinned.length === 0 ? (
        <EmptyState title="Nothing matches">
          No artifact has this kind in this project. Remove a filter to see the rest.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-1" aria-label="Artifacts by project" role="group">
          {shelf.groups.map(({ project: name, items }) => (
            <Fold key={`${name}-${filtered}`} title={name} count={items.length} defaultOpen={filtered}>
              <ul className="flex flex-col text-[length:var(--vx-text-sm)]">
                {items.map((item) => (
                  <li
                    key={item.kind === 'collection' ? item.entry.collection.id : item.row.artifact.id}
                    className="not-first:border-t"
                  >
                    {item.kind === 'collection' ? (
                      <CollectionRow entry={item.entry} now={now} />
                    ) : (
                      <ArtifactRowLink row={item.row} now={now} tag={hiddenTag(item.hidden)} />
                    )}
                  </li>
                ))}
              </ul>
            </Fold>
          ))}
        </div>
      )}
    </Page>
  )
}
