import { ChatCircleDotsIcon, PushPinIcon, PushPinSlashIcon, StackIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Ago } from '@/components/issue/ago'
import { CardLink, LINKED_CARD } from '@/components/kit/card-link'
import { Button } from '@/components/ui/button'
import { pinCollection } from '@/lib/api'
import type { ArtifactRow, Collection, CollectionEntry, Hidden } from '@/lib/artifacts'
import { ARTIFACT_KIND_LABEL } from '@/lib/needs'
import { cn } from '@/lib/utils'

const pages = (n: number): string => `${n} ${n === 1 ? 'page' : 'pages'}`

/** The owner's pin and unpin of a collection; the list refetches when it lands, and a refusal shows beside the button. */
export function PinButton({ collection, className }: { collection: Collection; className?: string }) {
  const queryClient = useQueryClient()
  const pinned = collection.pinnedAt !== null
  const write = useMutation({
    mutationFn: () => pinCollection(collection.id, !pinned),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['artifact-collections'] }),
  })
  const Pin = pinned ? PushPinSlashIcon : PushPinIcon
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={write.isPending}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${collection.title}`}
        onClick={() => write.mutate()}
        className={cn('relative z-10 text-muted-foreground', className)}
      >
        <Pin aria-hidden="true" />
        {pinned ? 'Unpin' : 'Pin'}
      </Button>
      {write.error ? (
        <span role="alert" className="text-xs text-destructive">
          {write.error.message}
        </span>
      ) : null}
    </>
  )
}

/** A figure with its label, in the card's inset body. */
function Figure({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[length:var(--vx-text-display)] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-1.5 text-[length:var(--vx-text-sm)] text-muted-foreground">{label}</p>
    </div>
  )
}

/**
 * A pinned collection, the way Flow's StatCard is built: the shell holds the header (an icon tile, the title, its project,
 * Unpin) and the footer (the last change); the body one surface step below holds the page count and the open comments.
 * The whole card opens the collection.
 */
export function CollectionCard({ entry, now }: { entry: CollectionEntry; now: number }) {
  const { collection } = entry
  const open = collection.openComments
  return (
    <article
      data-collection={collection.title}
      className={cn(
        'group relative flex min-w-0 flex-col gap-1 rounded-xl bg-card p-1 text-card-foreground',
        LINKED_CARD,
      )}
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <header className="flex items-start gap-3 px-2.5 pt-2 pb-1">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <StackIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            title={collection.title}
            className="line-clamp-2 text-[length:var(--vx-text-md)] leading-tight font-semibold tracking-tight"
          >
            <CardLink
              as={(props) => (
                <Link to="/artifacts/collections/$id" params={{ id: collection.id }} data-keynav="" {...props} />
              )}
            >
              {collection.title}
            </CardLink>
          </h3>
          <p className="truncate text-xs text-muted-foreground">{collection.repo}</p>
        </div>
        <PinButton collection={collection} />
      </header>
      <div className="flex flex-1 items-end gap-8 rounded-lg bg-background px-4 py-3.5">
        <Figure value={collection.memberCount} label={collection.memberCount === 1 ? 'page' : 'pages'} />
        <Figure value={open} label={open === 1 ? 'open comment' : 'open comments'} />
      </div>
      <footer className="flex items-center justify-between gap-3 px-2.5 pt-1 pb-2 text-xs text-muted-foreground">
        <span>Last change</span>
        {collection.lastChange ? <Ago iso={collection.lastChange} now={now} className="font-mono" /> : <span>–</span>}
      </footer>
    </article>
  )
}

const ROW_LINK =
  '-mx-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md px-2 py-2.5 outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50'

const HIDDEN_WORDS: Record<Hidden, string> = {
  closed: 'Issue closed',
  superseded: 'Replaced by a newer copy',
}

/** One artifact as a row: its kind, title, Issue and project, and age. `tag` marks the overview page or a page Show all brought back. */
export function ArtifactRowLink({ row, now, tag }: { row: ArtifactRow; now: number; tag?: string | null | undefined }) {
  const { artifact, issue, issueTitle, project: repo, linked } = row
  return (
    <Link to="/artifacts/$id" params={{ id: artifact.id }} data-keynav="" className={ROW_LINK}>
      <span className="w-20 shrink-0 text-xs text-muted-foreground">
        {ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">
          {artifact.title}
          {tag ? (
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
              {tag}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {issue ? `Issue ${issue}` : 'No Issue'}
          {issueTitle ? `: ${issueTitle}` : ''}
          {repo ? ` · ${repo}` : ''}
          {linked.length > 0 ? ` · ${issue ? 'also ' : ''}${linked.map((n) => `Issue ${n}`).join(', ')}` : ''}
        </span>
      </span>
      <Ago iso={artifact.createdAt} now={now} className="font-mono text-xs text-muted-foreground" />
    </Link>
  )
}

export const hiddenTag = (hidden: Hidden | null): string | null => (hidden ? HIDDEN_WORDS[hidden] : null)

/** An unpinned collection among the rest: one row that opens it, with Pin beside. */
export function CollectionRow({ entry, now }: { entry: CollectionEntry; now: number }) {
  const { collection } = entry
  return (
    <div className="flex items-center gap-2" data-collection={collection.title}>
      <Link
        to="/artifacts/collections/$id"
        params={{ id: collection.id }}
        data-keynav=""
        className={cn(ROW_LINK, 'min-w-0 flex-1')}
      >
        <span className="w-20 shrink-0 text-xs text-muted-foreground">Collection</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{collection.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {pages(collection.memberCount)}
            {collection.openComments > 0 ? (
              <>
                {' · '}
                <ChatCircleDotsIcon className="inline size-3 align-[-1px]" aria-hidden="true" />{' '}
                {collection.openComments} open
              </>
            ) : null}
          </span>
        </span>
        {collection.lastChange ? (
          <Ago iso={collection.lastChange} now={now} className="font-mono text-xs text-muted-foreground" />
        ) : null}
      </Link>
      <PinButton collection={collection} />
    </div>
  )
}
