import { Popover } from '@base-ui/react/popover'
import { DotsThreeIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface MenuButtonProps {
  onClick: () => void
  /** The accessible name; default "More". */
  label?: string
  className?: string
}

/** The ⋯ button of a card or a row. It sits above the card's stretched link. */
export function MenuButton({ onClick, label = 'More', className }: MenuButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'relative z-10 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <DotsThreeIcon weight="bold" className="size-4" aria-hidden="true" />
    </button>
  )
}

export interface MenuPopoverProps {
  /** The accessible name of the ⋯ button ("Cost: what is counted"). */
  label: string
  /** The popover's heading. */
  title: string
  /** The words in the popover. */
  children: ReactNode
  className?: string
}

/** A ⋯ button that opens a small popover of words (click, Enter or Space; Escape closes it). */
export function MenuPopover({ label, title, children, className }: MenuPopoverProps) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        className={cn(
          'relative z-10 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted data-popup-open:text-foreground',
          className,
        )}
      >
        <DotsThreeIcon weight="bold" className="size-4" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="isolate z-50">
          <Popover.Popup
            className="max-w-xs rounded-lg bg-popover p-3 text-popover-foreground outline-none"
            style={{ boxShadow: 'var(--vx-shadow-overlay)' }}
          >
            <Popover.Title className="text-[length:var(--vx-text-sm)] font-semibold">{title}</Popover.Title>
            <Popover.Description className="mt-1 text-[length:var(--vx-text-sm)] text-muted-foreground">
              {children}
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
