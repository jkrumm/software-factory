import { Fold } from '@/components/kit/fold'
import type { TocItem } from '@/lib/artifact'
import { cn } from '@/lib/utils'

/** The headings as a list that jumps to each; the section the reader is in is marked. Indented by level, the shallowest flush. */
function TocList({
  items,
  section,
  onJump,
}: {
  items: readonly TocItem[]
  section: string | null
  onJump: (id: string) => void
}) {
  const top = Math.min(...items.map((item) => item.level))
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            aria-current={item.id === section ? 'location' : undefined}
            onClick={() => onJump(item.id)}
            style={{ paddingInlineStart: `${0.5 + (item.level - top) * 0.75}rem` }}
            className={cn(
              'w-full cursor-pointer rounded-md py-1 pe-2 text-left text-[length:var(--vx-text-sm)] leading-5 text-muted-foreground transition-colors outline-none [overflow-wrap:anywhere] hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
              item.id === section && 'bg-muted font-semibold text-foreground',
            )}
          >
            {item.text}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The table of contents as a column of its own, on a wide screen: it scrolls apart from the document and the comments. */
export function TocColumn(props: { items: readonly TocItem[]; section: string | null; onJump: (id: string) => void }) {
  return (
    <nav aria-label="Contents" className="flex min-h-0 min-w-0 flex-col bg-muted/40">
      <h2 className="px-4 pt-4 pb-3 font-heading text-base font-semibold tracking-tight">Contents</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {props.items.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">This document has no headings.</p>
        ) : (
          <TocList {...props} />
        )}
      </div>
    </nav>
  )
}

/** The table of contents on a narrower screen: a collapsible bar under the header, closed until it is wanted. */
export function TocBar(props: { items: readonly TocItem[]; section: string | null; onJump: (id: string) => void }) {
  if (props.items.length === 0) return null
  return (
    <nav aria-label="Contents" className="px-4 pt-1 pb-2 md:px-8">
      <Fold title="Contents" count={props.items.length}>
        <div className="max-h-72 overflow-y-auto">
          <TocList {...props} />
        </div>
      </Fold>
    </nav>
  )
}
