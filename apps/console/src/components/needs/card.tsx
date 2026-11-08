import type { NeedItem } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { issueNumber, originOf, waitingWords } from '@/lib/needs'
import { BodyOf } from './bodies'

/**
 * One thing that waits on the owner, expandable in place. Opening it (a click or the deep link) scrolls it into view and
 * puts focus on its header. The ids stay in the DOM keys, never on screen.
 */
export function NeedCard({
  item,
  open,
  onToggle,
  onSent,
}: {
  item: NeedItem
  open: boolean
  onToggle: () => void
  onSent: (message: string) => void
}) {
  const card = useRef<HTMLElement>(null)
  const header = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    card.current?.scrollIntoView({ block: 'start' })
    header.current?.focus({ preventScroll: true })
  }, [open])

  return (
    <article
      ref={card}
      data-open={open}
      className="scroll-mt-4 rounded-xl border bg-card text-card-foreground transition-colors has-[h3>button:hover]:bg-accent"
    >
      <h3>
        <button
          ref={header}
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="grid w-full gap-1 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="font-medium">{item.title}</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{originOf(item)}</span>
            <span>{waitingWords(item.ageMs)}</span>
            {item.stale ? <Badge variant="destructive">Stale</Badge> : null}
          </span>
          {open ? null : <span className={cn('line-clamp-2 text-sm text-muted-foreground')}>{item.summary}</span>}
        </button>
      </h3>
      {open ? (
        <div className="grid gap-4 border-t px-4 py-4">
          <BodyOf item={item} onSent={onSent} />
          {item.issue ? (
            <Link
              to="/issues/$id"
              params={{ id: issueNumber(item.issue) }}
              className="w-fit text-sm text-primary underline underline-offset-4"
            >
              Open Issue
            </Link>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
