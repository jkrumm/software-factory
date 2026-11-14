import { NEED_KINDS, type NeedItem } from '@software-factory/contract'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { InfoHint, type InfoWord } from '@/components/kit'
import { Desk, PushToMacbook } from '@/components/needs/desk'
import { NeedCard } from '@/components/needs/card'
import { SinceBand } from '@/components/needs/since-band'
import { NeedsSkeleton } from '@/components/skeletons'
import { EmptyState, Page, PageHeader } from '@/components/page'
import { ActiveFilters, type FilterChip, SidebarEntry, SidebarSection } from '@/components/sidebar'
import {
  KIND_LABEL,
  kindCounts,
  needsNote,
  needsTitle,
  projectCounts,
  projectsOfNeeds,
  visibleNeeds,
} from '@/lib/needs'
import { useNow } from '@/lib/now'
import { useOpenIssueCards, useNeeds } from '@/lib/queries'
import { useScreen, useScreenNote } from '@/lib/screen'

interface NeedsSearch {
  item?: string
  kind?: NeedItem['kind']
  project?: string
  /** `desk`: Back at desk, the open Errands grouped by what the hands must do */
  mode?: 'desk'
}

/** The words an InfoHint defines for a kind's heading and its sidebar entry. */
const KIND_HINT = {
  review: 'review',
  decision: 'decision',
  errand: 'errand',
  held_signal: 'held signal',
  long_wait: 'long wait',
} as const satisfies Record<NeedItem['kind'], InfoWord>

const SELECT =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

export const Route = createFileRoute('/needs-you')({
  /**
   * `item` is the deep link of one item: `/needs-you?item=<key>`, also where `/checkpoints/<key>` lands. `kind` shows one
   * kind and `project` one project (the repo, or "App feedback"); both are linkable. `mode=desk` is Back at desk.
   */
  validateSearch: (search: Record<string, unknown>): NeedsSearch => {
    const kind = NEED_KINDS.find((k) => k === search.kind)
    return {
      ...(typeof search.item === 'string' && search.item !== '' ? { item: search.item } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof search.project === 'string' && search.project !== '' ? { project: search.project } : {}),
      ...(search.mode === 'desk' ? { mode: 'desk' as const } : {}),
    }
  },
  component: NeedsYou,
})

function NeedsYou() {
  const needs = useNeeds()
  const { data, error, dataUpdatedAt } = needs
  const screen = useScreen(needs)
  const note = useScreenNote(screen, error)
  const { item: openId, kind: rawKind, project, mode } = Route.useSearch()
  const desk = mode === 'desk'
  // an unknown `kind` still reaches here from the raw URL (the root route validates nothing)
  const only = NEED_KINDS.find((k) => k === rawKind)
  const navigate = useNavigate({ from: Route.fullPath })
  const now = useNow(30_000)
  const cards = useOpenIssueCards()
  const [sent, setSent] = useState<string | null>(null)
  // a snapshot restored from storage may be older than the item: say it is settled only on data fetched since the page opened
  const openedAt = useRef(Date.now())

  // the tab says how many wait: every need on the list, the Errands at the desk
  const waiting = data ? data.items.filter((i) => !desk || i.kind === 'errand').length : 0
  useEffect(() => {
    document.title = needsTitle(waiting, desk)
    return () => {
      document.title = 'Software Factory'
    }
  }, [waiting, desk])

  const filters: NeedsSearch = { ...(only ? { kind: only } : {}), ...(project ? { project } : {}) }
  const onSent = (message: string) => {
    setSent(message)
    void navigate({ search: { ...filters, ...(desk ? { mode: 'desk' as const } : {}) }, replace: true })
  }
  const setFilter = (name: 'kind' | 'project', value: string) =>
    void navigate({
      search: { ...(openId ? { item: openId } : {}), ...filters, [name]: value || undefined },
      replace: true,
    })

  if (!data)
    return (
      <Page wide>
        <PageHeader title="Needs you" loading={screen === 'loading'} note={note} />
        <SinceBand now={now} />
        {screen === 'loading' ? <NeedsSkeleton /> : null}
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

  const errandCount = data.items.filter((i) => i.kind === 'errand').length
  const modes = (
    <nav aria-label="View" className="mb-4 flex items-center gap-4 text-sm">
      <Link
        to="/needs-you"
        search={{}}
        aria-current={desk ? undefined : 'page'}
        className={
          desk ? 'text-muted-foreground underline-offset-4 hover:underline' : 'font-medium underline underline-offset-4'
        }
      >
        Everything ({total})
      </Link>
      <Link
        to="/needs-you"
        search={{ mode: 'desk' }}
        aria-current={desk ? 'page' : undefined}
        className={
          desk ? 'font-medium underline underline-offset-4' : 'text-muted-foreground underline-offset-4 hover:underline'
        }
      >
        Back at desk ({errandCount})
      </Link>
    </nav>
  )
  if (desk) {
    return (
      <Page wide>
        <PageHeader title="Back at desk" note="What needs your hands, by where they must be." />
        {modes}
        {notice}
        <PushToMacbook items={data.items} onSent={onSent} />
        {errandCount === 0 ? (
          <EmptyState title="Nothing needs your hands">
            An errand shows here when it needs a device or a portal.
          </EmptyState>
        ) : (
          <Desk items={data.items} onSent={onSent} />
        )}
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
      {modes}
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
            hint={KIND_HINT[kind]}
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
      <PushToMacbook items={data.items} onSent={onSent} />
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
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
        {NEED_KINDS.map((kind) => {
          const items = visible.filter((i) => i.kind === kind)
          if (items.length === 0) return null
          return (
            <section
              key={kind}
              aria-labelledby={`needs-${kind}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3"
            >
              <div className="flex items-center gap-1">
                <h2 id={`needs-${kind}`} className="text-sm font-medium text-muted-foreground">
                  {KIND_LABEL[kind]} <span className="tabular-nums">{items.length}</span>
                </h2>
                <InfoHint word={KIND_HINT[kind]} />
              </div>
              {items.map((i) => (
                <NeedCard
                  key={i.id}
                  item={i}
                  issueTitle={i.issue ? (titles.get(i.issue) ?? null) : null}
                  open={openId === i.id}
                  search={{ ...(openId === i.id ? {} : { item: i.id }), ...filters }}
                  onVisit={() => setSent(null)}
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
