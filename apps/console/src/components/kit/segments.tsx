import { cn } from '@/lib/utils'

const SEGMENT =
  'h-7 cursor-pointer rounded-md px-2.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50'

export interface SegmentsProps<T extends string> {
  /** The group's accessible name ("Window"). */
  label: string
  choices: readonly { key: T; label: string; /** a hover title: what the choice keeps */ hint?: string }[]
  value: T
  onChange: (key: T) => void
  className?: string
}

/** A segmented control: one pressed button per choice, never a link (the choice is the screen's own state, not the URL's). */
export function Segments<T extends string>({ label, choices, value, onChange, className }: SegmentsProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap gap-1 rounded-lg bg-muted p-0.5', className)}>
      {choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          aria-pressed={choice.key === value}
          title={choice.hint}
          onClick={() => onChange(choice.key)}
          className={cn(
            SEGMENT,
            choice.key === value
              ? 'bg-background font-medium text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {choice.label}
        </button>
      ))}
    </div>
  )
}
