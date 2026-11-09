import type { NeedItem } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { InfoHint, Lozenge } from '@/components/kit'
import { issueNumber, metaParts, projectOf, summaryLine } from '@/lib/needs'
import { cn } from '@/lib/utils'
import { BodyOf } from './bodies'

const LINK =
  'relative z-10 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50'

/** The project as a chip that opens Flow filtered to it; an item that names none shows the word, plain. */
export function ProjectChip({ item }: { item: Pick<NeedItem, 'repo'> }) {
  const chip =
    'inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-xs text-muted-foreground transition-colors'
  if (item.repo === null) return <span className={chip}>{projectOf(item)}</span>
  return (
    <Link
      to="/flow"
      search={{ project: item.repo }}
      className={cn(
        chip,
        'relative z-10 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
      )}
    >
      {item.repo}
    </Link>
  )
}

/**
 * One thing that waits on the owner, expandable in place. The project leads, then the title, a link to the item's deep
 * link (`?item=<id>`; open, the same page without it, so a click closes the card, and the router marks it
 * `aria-current="page"`). Closed, the whole card is the click
 * target (the title link is stretched over it, the other links stay above). Opening it (a click or the deep link)
 * scrolls it into view and puts focus on its title. The ids stay in the DOM keys, never on screen.
 */
export function NeedCard({
  item,
  issueTitle,
  open,
  search,
  onVisit,
  onSent,
}: {
  item: NeedItem
  /** the Issue's title where the Issue is known */
  issueTitle: string | null
  open: boolean
  /** the search of the title link: the page's filters, plus `item` while the card is closed */
  search: { item?: string; kind?: NeedItem['kind']; project?: string }
  /** the title link was followed */
  onVisit: () => void
  onSent: (message: string) => void
}) {
  const card = useRef<HTMLElement>(null)
  const header = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (!open) return
    card.current?.scrollIntoView({ block: 'start' })
    header.current?.focus({ preventScroll: true })
  }, [open])

  const summary = summaryLine(item, issueTitle)
  const meta = metaParts(item)
  return (
    <article
      ref={card}
      data-open={open}
      className={cn(
        'relative scroll-mt-4 rounded-xl border bg-card text-card-foreground transition-colors',
        !open && 'has-[h3>a:hover]:bg-accent',
      )}
    >
      <div className="grid gap-1.5 px-4 py-3">
        <div className="flex items-start gap-2">
          <span className="flex h-6 items-center">
            <ProjectChip item={item} />
          </span>
          <h3 className="min-w-0 flex-1 text-[15px] font-medium">
            <Link
              ref={header}
              to="/needs-you"
              search={search}
              replace
              onClick={onVisit}
              className={cn(
                'cursor-pointer rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                !open && 'after:absolute after:inset-0 after:rounded-xl',
              )}
            >
              {item.title}
            </Link>
          </h3>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="relative z-10">
            {meta.lead}{' '}
            <time
              className="font-mono tabular-nums"
              dateTime={item.since}
              title={new Date(item.since).toLocaleString()}
            >
              {meta.age}
            </time>
          </span>
          {item.stale ? (
            <span className="relative z-10 inline-flex items-center gap-0.5">
              <Lozenge state="waiting">Stale</Lozenge>
              <InfoHint word="stale" className="-my-1" />
            </span>
          ) : null}
          {item.issue ? (
            <Link to="/issues/$id" params={{ id: issueNumber(item.issue) }} className={cn(LINK, 'min-w-0 truncate')}>
              {issueTitle ?? 'Open Issue'}
            </Link>
          ) : null}
        </p>
        {open || summary === null ? null : <p className="line-clamp-2 text-sm text-muted-foreground">{summary}</p>}
      </div>
      {open ? (
        <div className="grid gap-4 border-t px-4 py-4">
          <BodyOf item={item} issueTitle={issueTitle} onSent={onSent} />
        </div>
      ) : null}
    </article>
  )
}
