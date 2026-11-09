import { NEED_KINDS, type NeedItem } from '@software-factory/contract'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { InfoHint } from '@/components/kit'
import { NeedCard } from '@/components/needs/card'
import { SinceBand } from '@/components/needs/since-band'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ActiveFilters, type FilterChip, SidebarEntry, SidebarSection } from '@/components/sidebar'
import { failureNote } from '@/lib/api'
import { KIND_LABEL, kindCounts, needsNote, projectCounts, projectsOfNeeds, visibleNeeds } from '@/lib/needs'
import { useNow } from '@/lib/now'
import { useIssueCards, useNeeds } from '@/lib/queries'

interface NeedsSearch {
  item?: string
  kind?: NeedItem['kind']
  project?: string
}

/** The words an InfoHint defines for a kind's heading; Reviews need none. */
const KIND_HINT = { decision: 'decision', errand: 'errand', held_signal: 'held signal' } as const

const SELECT =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

export const Route = createFileRoute('/needs-you')({
  /**
   * `item` is the deep link of one item: `/needs-you?item=<key>`, also where `/checkpoints/<key>` lands. `kind` shows one
   * kind and `project` one project (the repo, or "App feedback"); both are linkable.
   */
  validateSearch: (search: Record<string, unknown>): NeedsSearch => {
    const kind = NEED_KINDS.find((k) => k === search.kind)
    return {
      ...(typeof search.item === 'string' && search.item !== '' ? { item: search.item } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof search.project === 'string' && search.project !== '' ? { project: search.project } : {}),
    }
  },
  component: NeedsYou,
})

function NeedsYou() {
  const { data, error, isPending, dataUpdatedAt } = useNeeds()
  const { item: openId, kind: rawKind, project } = Route.useSearch()
  // an unknown `kind` still reaches here from the raw URL (the root route validates nothing)
  const only = NEED_KINDS.find((k) => k === rawKind)
  const navigate = useNavigate({ from: Route.fullPath })
  const now = useNow(30_000)
  const cards = useIssueCards(true)
  const [sent, setSent] = useState<string | null>(null)
  // a snapshot restored from storage may be older than the item: say it is settled only on data fetched since the page opened
  const openedAt = useRef(Date.now())

  const filters: NeedsSearch = { ...(only ? { kind: only } : {}), ...(project ? { project } : {}) }
  const select = (id: string | undefined) => {
    setSent(null)
    void navigate({ search: { ...(id ? { item: id } : {}), ...filters }, replace: true })
  }
  const onSent = (message: string) => {
    setSent(message)
    void navigate({ search: filters, replace: true })
  }
  const setFilter = (name: 'kind' | 'project', value: string) =>
    void navigate({
      search: { ...(openId ? { item: openId } : {}), ...filters, [name]: value || undefined },
      replace: true,
    })

  if (!data)
    return (
      <Page wide>
        <PageHeader title="Needs you" note={isPending ? 'Loading' : failureNote(error)} />
        <SinceBand now={now} />
      </Page>
    )

  const total = data.items.length
  const unknown = openId !== undefined && dataUpdatedAt >= openedAt.current && !data.items.some((i) => i.id === openId)
  const notice = unknown ? (
    <p role="status" className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      That one is already settled.{' '}
      <Link to="/needs-you" search={{}} className="underline underline-offset-4">
        Back to the list
      </Link>
    </p>
  ) : sent ? (
    <p role="status" className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      {sent}
    </p>
  ) : null

  if (total === 0) {
    return (
      <Page wide>
        <PageHeader title="Needs you" />
        <SinceBand now={now} />
        {notice}
        <EmptyState title="Nothing waits on you">The factory will say here when it needs a decision.</EmptyState>
      </Page>
    )
  }

  const titles = new Map((cards.data?.issues ?? []).map((card) => [card.ref, card.title]))
  const visible = visibleNeeds(data.items, filters, openId)
  const kinds = kindCounts(data.items, project)
  const projects = projectCounts(data.items, only)
  const projectNames = projectsOfNeeds(data.items, project)
  const chips: FilterChip[] = [
    ...(only
      ? [
          {
            key: 'kind',
            label: `Kind: ${KIND_LABEL[only]}`,
            render: (props: Parameters<FilterChip['render']>[0]) => (
              <Link to="/needs-you" search={project ? { project } : {}} {...props} />
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
              <Link to="/needs-you" search={only ? { kind: only } : {}} {...props} />
            ),
          },
        ]
      : []),
  ]
  return (
    <Page wide>
      <PageHeader
        title="Needs you"
        note={needsNote(visible.length, total, only !== undefined || project !== undefined)}
      />
      <SinceBand now={now} />
      <SidebarSection title="Kinds">
        <SidebarEntry
          label="All"
          pressed={!only}
          render={(props) => <Link to="/needs-you" search={{ ...(project ? { project } : {}) }} {...props} />}
        />
        {NEED_KINDS.map((kind) => (
          <SidebarEntry
            key={kind}
            label={KIND_LABEL[kind]}
            count={kinds[kind]}
            pressed={only === kind}
            render={(props) => (
              <Link
                to="/needs-you"
                search={{ ...(project ? { project } : {}), ...(only === kind ? {} : { kind }) }}
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
          render={(props) => <Link to="/needs-you" search={{ ...(only ? { kind: only } : {}) }} {...props} />}
        />
        {projectNames.map((name) => (
          <SidebarEntry
            key={name}
            label={name}
            count={projects[name] ?? 0}
            pressed={project === name}
            render={(props) => (
              <Link
                to="/needs-you"
                search={{ ...(only ? { kind: only } : {}), ...(project === name ? {} : { project: name }) }}
                {...props}
              />
            )}
          />
        ))}
      </SidebarSection>
      <ActiveFilters chips={chips} />
      <div className="mb-4 flex flex-wrap gap-3 md:hidden">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Kind
          <select className={SELECT} value={only ?? ''} onChange={(e) => setFilter('kind', e.target.value)}>
            <option value="">All kinds</option>
            {NEED_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Project
          <select className={SELECT} value={project ?? ''} onChange={(e) => setFilter('project', e.target.value)}>
            <option value="">All projects</option>
            {projectNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {notice}
      {only || project ? (
        <p className="mb-4 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>
            Showing {visible.length} of {total}
          </span>
          <span aria-hidden>&middot;</span>
          <span>
            {[only ? `Kind: ${KIND_LABEL[only]}` : null, project ? `Project: ${project}` : null]
              .filter(Boolean)
              .join(', ')}
          </span>
          <span aria-hidden>&middot;</span>
          <Link to="/needs-you" search={{}} className="underline underline-offset-4 hover:text-foreground">
            Clear filters
          </Link>
        </p>
      ) : null}
      {visible.length === 0 ? (
        <EmptyState
          title={project ? 'Nothing matches these filters.' : 'Nothing of this kind waits.'}
          action={
            <Link to="/needs-you" search={{}} className="text-sm underline underline-offset-4">
              Show everything that waits
            </Link>
          }
        />
      ) : null}
      <div className="grid gap-8">
        {NEED_KINDS.map((kind) => {
          const items = visible.filter((i) => i.kind === kind)
          if (items.length === 0) return null
          return (
            <section key={kind} aria-labelledby={`needs-${kind}`} className="grid gap-3">
              <div className="flex items-center gap-1">
                <h2 id={`needs-${kind}`} className="text-sm font-medium text-muted-foreground">
                  {KIND_LABEL[kind]} <span className="tabular-nums">{items.length}</span>
                </h2>
                {kind === 'review' ? null : <InfoHint word={KIND_HINT[kind]} />}
              </div>
              {items.map((i) => (
                <NeedCard
                  key={i.id}
                  item={i}
                  issueTitle={i.issue ? (titles.get(i.issue) ?? null) : null}
                  open={openId === i.id}
                  onToggle={() => select(openId === i.id ? undefined : i.id)}
                  onSent={onSent}
                />
              ))}
            </section>
          )
        })}
      </div>
    </Page>
  )
}
