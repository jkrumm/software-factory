import { CaretRightIcon } from '@phosphor-icons/react'
import { type ReactNode, useId, useState } from 'react'
import { cn } from '@/lib/utils'

export interface FoldProps {
  title: string
  /** Shown beside the title. */
  count?: number
  /** Controlled: with `open`, the parent owns the state and hears `onOpenChange`. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Uncontrolled: the state it starts in. */
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

/** A full-width header button with a caret that turns when open, a count, and `aria-expanded`. */
export function Fold({ title, count, open, onOpenChange, defaultOpen = false, children, className }: FoldProps) {
  const [inner, setInner] = useState(defaultOpen)
  const panel = useId()
  const isOpen = open ?? inner
  const toggle = () => {
    if (open === undefined) setInner(!isOpen)
    onOpenChange?.(!isOpen)
  }
  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panel}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-md border-b py-2 text-left text-[length:var(--vx-text-md)] font-semibold tracking-tight transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <CaretRightIcon
          weight="bold"
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            isOpen && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {count === undefined ? null : (
          <span className="shrink-0 text-[length:var(--vx-text-sm)] font-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </button>
      <div id={panel} hidden={!isOpen} className="pt-3">
        {children}
      </div>
    </div>
  )
}
