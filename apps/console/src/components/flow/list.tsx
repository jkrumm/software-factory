import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { ColumnKey, FlowCard } from '@/lib/flow'
import { cn } from '@/lib/utils'
import { FlowCardView } from './card'
import { EmptyColumn } from './empty'

/** A virtualised scroll list of cards: only the visible ones are in the DOM. Keyed by Issue, so an update re-renders in place. */
export function FlowList({
  cards,
  now,
  labelledBy,
  column,
  showState,
  className,
}: {
  cards: FlowCard[]
  now: number
  labelledBy: string
  /** which column or tab this is, for what its empty state says */
  column: ColumnKey
  showState?: boolean
  className?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (index) => cards[index]?.key ?? index,
  })

  if (cards.length === 0) return <EmptyColumn column={column} />
  return (
    <div ref={scroller} data-testid="flow-scroll" className={cn('-mx-1 overflow-y-auto px-1', className)}>
      <ul aria-labelledby={labelledBy} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const card = cards[row.index]
          if (!card) return null
          return (
            <li
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              className="absolute top-0 left-0 w-full pb-2"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <FlowCardView card={card} now={now} showState={showState} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
