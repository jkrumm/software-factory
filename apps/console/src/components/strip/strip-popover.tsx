import { type ReactNode, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export const TRIGGER =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-accent data-popup-open:text-foreground'

const POPUP = 'data-strip-popup'
const CLOSE_REFOCUS_MS = 400

/**
 * A strip item that opens a popover on hover (short delay), on keyboard focus and on click or tap; Esc closes it. A
 * mouse click focuses without opening twice: only `:focus-visible` (the keyboard) opens on focus.
 */
export function StripPopover({
  label,
  trigger,
  className,
  triggerClassName,
  align,
  children,
}: {
  /** The trigger's accessible name. */
  label: string
  trigger: ReactNode
  /** Width of the popup. */
  className: string
  triggerClassName?: string
  align?: 'start' | 'end'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Closing hands focus back to the trigger, which must not open it again.
  const closedAt = useRef(0)
  const change = (next: boolean) => {
    if (!next) closedAt.current = Date.now()
    setOpen(next)
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger
        openOnHover
        delay={200}
        closeDelay={150}
        aria-label={label}
        className={cn(TRIGGER, triggerClassName)}
        onFocus={(event) => {
          if (Date.now() - closedAt.current < CLOSE_REFOCUS_MS) return
          if (event.currentTarget.matches(':focus-visible')) setOpen(true)
        }}
        onBlur={(event) => {
          const next = event.relatedTarget
          if (next instanceof Element && next.closest(`[${POPUP}]`)) return
          change(false)
        }}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent {...{ [POPUP]: '' }} align={align} className={className}>
        {children}
      </PopoverContent>
    </Popover>
  )
}
