import { CaretLineLeftIcon, CaretLineRightIcon, TextAaIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { READING_LABEL, READING_SIZES, type ReadingSize } from '@/lib/reading'
import { cn } from '@/lib/utils'

/**
 * The sizes of the artifact page's panes, in px. Contents never narrows below the width where a 12-character word fits
 * unbroken (about 100 px of text at the entries' size, plus the padding); Comments never below a readable comment line;
 * the document never below a column that still holds a table.
 */
export const PANE = {
  document: 420,
  contentsMin: 176,
  contentsDefault: 240,
  commentsMin: 288,
  commentsDefault: 384,
  commentsDefaultWide: 480,
  rail: 40,
} as const

/** The key under which a browser remembers the panes' sizes; the layout of two panes and of three are kept apart. */
export const PANES_KEY = 'console-artifact-panes'

/** A pane's own control: it folds the pane into its rail. */
export function CollapseButton({
  label,
  onClick,
  side,
}: {
  label: string
  onClick: () => void
  side: 'left' | 'right'
}) {
  const Icon = side === 'left' ? CaretLineLeftIcon : CaretLineRightIcon
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 text-muted-foreground"
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}

/** A collapsed pane: a narrow strip with its name written upright, one click from open. */
export function Rail({
  label,
  count,
  icon,
  onExpand,
  className,
}: {
  label: string
  count?: number
  icon: ReactNode
  onExpand: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={`Show ${label}`}
      title={`Show ${label}`}
      onClick={onExpand}
      className={cn(
        'flex h-full w-full cursor-pointer flex-col items-center gap-3 py-4 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      {icon}
      <span className="font-heading text-sm font-semibold tracking-tight [writing-mode:vertical-rl]">
        {label}
        {count === undefined ? null : <span className="ms-2 font-normal tabular-nums">{count}</span>}
      </span>
    </button>
  )
}

/** The reading size as three steps in the header: smaller, default, larger. */
export function ReadingSizeControl({ size, onChange }: { size: ReadingSize; onChange: (next: ReadingSize) => void }) {
  return (
    <div role="group" aria-label="Reading size" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      <TextAaIcon aria-hidden="true" className="mx-1 size-3.5 text-muted-foreground" />
      {READING_SIZES.map((step) => (
        <button
          key={step}
          type="button"
          aria-label={READING_LABEL[step]}
          aria-pressed={step === size}
          title={READING_LABEL[step]}
          onClick={() => onChange(step)}
          className="inline-flex h-6 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs"
        >
          <span
            aria-hidden="true"
            className={cn(
              'font-semibold leading-none',
              step === 'smaller' ? 'text-[11px]' : step === 'default' ? 'text-[14px]' : 'text-[17px]',
            )}
          >
            A
          </span>
        </button>
      ))}
    </div>
  )
}
