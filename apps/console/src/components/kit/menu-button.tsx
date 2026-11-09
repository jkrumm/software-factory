import { DotsThreeIcon } from '@phosphor-icons/react'
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
