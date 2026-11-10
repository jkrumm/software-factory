import { Popover } from '@base-ui/react/popover'
import type { Icon } from '@phosphor-icons/react'
import { type ReactNode, useRef, useState } from 'react'
import { ageWords } from '@/lib/age'
import { cn } from '@/lib/utils'
import { TONE_TEXT, TONE_TINT, type Tone } from './tone'

export interface SinceRowProps {
  /** What happened, as an icon; painted in `tone` on its 12 % tint. */
  icon: Icon
  tone: Tone
  /** The outcome as a short phrase ("Shipped and verified"): the icon's accessible name and a line of the popover. */
  outcome: string
  /** One sentence for the popover: what happened to it. */
  happened: string
  /** The full title; the row clamps it to one line, the popover shows it whole. */
  title: string
  /** The Issue's number, shown `#657` in mono. None for a signal that never became an Issue. */
  number?: string | null
  /** The project (repo); none for what no repo owns. */
  project?: string | null
  /** When it happened (ISO). */
  at: string
  /** The clock the age is read against (ms), so a screen has one `now`. */
  now: number
  /** The popover's side; a phone has no room beside the row. Default `right`. */
  side?: 'right' | 'bottom'
  /** The popover's links (the Issue, its evidence), rendered under the facts. */
  children?: ReactNode
  className?: string
}

/** "Tue, Nov 10, 22:39": 24-hour like the band's own clock, the month as a word so no locale reads 11/10 as October. */
const absolute = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

/**
 * One thing that happened, as a compact line: its icon, the Issue number, the title clamped to one line, the project and
 * the age; no box. Hovering or focusing it with the keyboard opens a popover to its side with the full title, what
 * happened, the outcome and the links (the keyboard reaches the popover with Tab); a tap opens it on a touch screen.
 */
export function SinceRow({
  icon: Glyph,
  tone,
  outcome,
  happened,
  title,
  number,
  project,
  at,
  now,
  side = 'right',
  children,
  className,
}: SinceRowProps) {
  const [open, setOpen] = useState(false)
  // Escape closes the popover while the row keeps focus (or gets it back): that focus must not open it again
  const dismissed = useRef(false)
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        dismissed.current = !next && details.reason === 'escape-key'
        setOpen(next)
      }}
    >
      <Popover.Trigger
        openOnHover
        delay={120}
        closeDelay={80}
        // a keyboard arrival opens it as hover does; a pointer press is left to the click, which toggles
        onFocus={(event) => {
          if (!dismissed.current && event.currentTarget.matches(':focus-visible')) setOpen(true)
        }}
        onBlur={() => {
          dismissed.current = false
        }}
        className={cn(
          '@container grid w-full min-w-0 cursor-pointer grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1.5 py-1 text-left text-[length:var(--vx-text-sm)] transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-accent',
          className,
        )}
      >
        <span
          role="img"
          aria-label={outcome}
          className={cn('grid size-5 place-items-center rounded-sm', TONE_TINT[tone], TONE_TEXT[tone])}
        >
          <Glyph className="size-3.5" aria-hidden="true" />
        </span>
        <span className="w-9 font-mono text-xs text-muted-foreground tabular-nums">
          {number ? `#${number}` : '\u2013'}
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{title}</span>
          {project ? (
            <span className="hidden max-w-24 shrink-0 truncate text-xs text-muted-foreground @min-[20rem]:inline">
              {project}
            </span>
          ) : null}
        </span>
        <time
          dateTime={at}
          title={absolute(at)}
          className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {ageWords(now - Date.parse(at))}
        </time>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="start" sideOffset={8} collisionPadding={8} className="isolate z-50">
          <Popover.Popup
            // the row keeps focus: Tab moves on down the list, and into the popover's links when it is open
            initialFocus={false}
            className="w-80 max-w-[calc(100vw-1rem)] rounded-lg bg-popover p-3 text-popover-foreground outline-none"
            style={{ boxShadow: 'var(--vx-shadow-overlay)' }}
          >
            <Popover.Title className="text-[length:var(--vx-text-md)] font-semibold tracking-tight wrap-break-word">
              {title}
            </Popover.Title>
            <Popover.Description render={<dl />} className="mt-3 grid gap-2.5 text-[length:var(--vx-text-sm)]">
              <Fact label="What happened">{happened}</Fact>
              <Fact label="Outcome">
                <span className={cn('rounded-md px-1.5', TONE_TINT[tone], TONE_TEXT[tone])}>{outcome}</span>
              </Fact>
              {project ? <Fact label="Project">{project}</Fact> : null}
              <Fact label="When">
                {ageWords(now - Date.parse(at))}
                <span className="text-muted-foreground"> &middot; {absolute(at)}</span>
              </Fact>
            </Popover.Description>
            {children ? <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">{children}</div> : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 wrap-break-word">{children}</dd>
    </div>
  )
}
