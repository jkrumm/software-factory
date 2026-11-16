import { ArrowLeftIcon } from '@phosphor-icons/react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import { ArtifactRowLink, hiddenTag, PinButton } from '@/components/collection'
import { Ago } from '@/components/issue/ago'
import { Skeleton } from '@/components/kit/skeleton'
import { EmptyState, Page } from '@/components/page'
import { entriesOf, hiddenRows, rowsOf } from '@/lib/artifacts'
import { useNow } from '@/lib/now'
import { useArtifactList, useCollectionList, useIssueCards } from '@/lib/queries'

export const Route = createFileRoute('/artifacts/collections/$id')({ component: CollectionPage })

/** A collection: its overview page first, then every other page, oldest first. */
function CollectionPage() {
  const { id } = Route.useParams()
  const collections = useCollectionList()
  const list = useArtifactList()
  const cards = useIssueCards(true)
  const now = useNow(30_000)
  const rows = useMemo(
    () => (list.data ? rowsOf(list.data.artifacts, cards.data?.issues ?? []) : []),
    [list.data, cards.data],
  )
  const hidden = useMemo(() => hiddenRows(rows), [rows])
  const entry = useMemo(
    () => entriesOf(collections.data?.collections ?? [], rows).find((e) => e.collection.id === id),
    [collections.data, rows, id],
  )

  if (!collections.data || !list.data) {
    return (
      <Page>
        <div aria-busy aria-label="Loading the collection" className="grid gap-2">
          <Skeleton height={32} width={240} />
          {Array.from({ length: 6 }, (_, row) => (
            <Skeleton key={row} height={44} rounded="rounded-md" />
          ))}
        </div>
      </Page>
    )
  }
  if (!entry) {
    return (
      <Page>
        <EmptyState title="No such collection">
          It may have been renamed or removed. Back to the artifacts to find it.
        </EmptyState>
      </Page>
    )
  }
  const { collection, members } = entry
  const lead = members.find((row) => row.artifact.id === collection.lead)
  const rest = members.filter((row) => row !== lead)
  const ordered = lead ? [lead, ...rest] : rest
  return (
    <Page>
      <Link
        to="/artifacts"
        className="mb-4 inline-flex items-center gap-1.5 text-[length:var(--vx-text-sm)] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        Artifacts
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{collection.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {collection.repo} · {collection.memberCount} {collection.memberCount === 1 ? 'page' : 'pages'}
            {collection.openComments > 0
              ? ` · ${collection.openComments} open ${collection.openComments === 1 ? 'comment' : 'comments'}`
              : ''}
            {collection.lastChange ? (
              <>
                {' · changed '}
                <Ago iso={collection.lastChange} now={now} />
              </>
            ) : null}
          </p>
        </div>
        <PinButton collection={collection} />
      </header>
      {ordered.length === 0 ? (
        <EmptyState title="No page yet">Add pages with `factory artifact collection-edit`.</EmptyState>
      ) : (
        <ul aria-label="Pages" className="flex flex-col text-[length:var(--vx-text-sm)]">
          {ordered.map((row) => (
            <li key={row.artifact.id} className="not-first:border-t">
              <ArtifactRowLink
                row={row}
                now={now}
                tag={row === lead ? 'Overview' : hiddenTag(hidden.get(row.artifact.id) ?? null)}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  )
}
