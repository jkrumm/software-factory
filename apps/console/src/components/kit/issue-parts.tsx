import { CheckCircleIcon, ClockIcon, HourglassIcon, type Icon, QueueIcon } from '@phosphor-icons/react'
import { ageWords } from '@/lib/age'
import { cn } from '@/lib/utils'
import type { CardLinkProps, LinkRender } from './card-link'
import type { IssueKind } from './kind-badge'
import type { LozengeState } from './lozenge'
import { MenuButton } from './menu-button'

/** What IssueCard and IssueRow show; shaped from `FlowCard` (`lib/flow.ts`) plus the kind and the state. */
export interface IssueViewProps extends CardLinkProps {
  title: string
  /** The project (repo) as a chip. */
  project: string
  /** Renders the project chip as a link (a router link, like `as`). Omitted: plain text. */
  projectAs?: LinkRender
  kind: IssueKind
  state: LozengeState
  /** The wait or queue reason, or a closed Issue's outcome; none: no line. */
  reason?: string | null
  /** The Issue's number, shown as `#657` in mono. Omitted or null (a plan row): none. */
  number?: number | null
  /** When it entered its state (ISO). */
  since: string
  /** The clock the age is read against (ms), so a screen has one `now`. */
  now: number
  /** The ⋯ button, revealed on hover and focus. Omitted: no button. */
  onMenu?: () => void
  className?: string
}

const REASON_ICON: Record<LozengeState, Icon> = {
  settling: ClockIcon,
  queued: QueueIcon,
  working: ClockIcon,
  waiting: HourglassIcon,
  watching: ClockIcon,
  closed: CheckCircleIcon,
  done: CheckCircleIcon,
  dropped: CheckCircleIcon,
  healed: CheckCircleIcon,
  cancelled: CheckCircleIcon,
}

export function ReasonLine({
  state,
  reason,
  icon,
  title,
  className,
}: {
  state: LozengeState
  reason: string
  icon?: Icon
  title?: string
  className?: string
}) {
  const ReasonIcon = icon ?? REASON_ICON[state]
  return (
    <p
      className={cn(
        'flex min-w-0 items-start gap-1.5 text-[length:var(--vx-text-sm)] text-muted-foreground',
        className,
      )}
    >
      <ReasonIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0" title={title ?? reason}>
        {reason}
      </span>
    </p>
  )
}

const CHIP = 'inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-xs text-muted-foreground'

/**
 * The project as a chip. With `as` (a router link, as for a card) it is a link that sits above the card's stretched
 * link; without, plain text.
 */
export function ProjectChip({ project, as }: { project: string; as?: LinkRender }) {
  if (!as) return <span className={CHIP}>{project}</span>
  return as({
    className: cn(
      CHIP,
      'relative z-10 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
    ),
    children: project,
  })
}

/** The age as a mono `<time>`; the absolute time is its title. */
export function Age({ since, now, className }: { since: string; now: number; className?: string }) {
  return (
    <time
      dateTime={since}
      title={new Date(since).toLocaleString()}
      className={cn('font-mono text-xs tabular-nums text-muted-foreground', className)}
    >
      {ageWords(Math.max(0, now - Date.parse(since)))}
    </time>
  )
}

/** The Issue number in mono. */
export function IssueNumber({ number, className }: { number: number; className?: string }) {
  return <span className={cn('font-mono text-xs tabular-nums text-foreground', className)}>#{number}</span>
}

/** The fixed right column: the age in mono, swapped for the ⋯ button on hover or focus. The absolute time is the title. */
export function AgeColumn({
  since,
  now,
  onMenu,
  title,
  className,
}: Pick<IssueViewProps, 'since' | 'now' | 'onMenu'> & { title: string; className?: string }) {
  return (
    <div className={cn('relative flex h-6 w-24 shrink-0 items-center justify-end', className)}>
      <Age
        since={since}
        now={now}
        className={cn('transition-opacity', onMenu && 'group-focus-within:opacity-0 group-hover:opacity-0')}
      />
      {onMenu ? (
        <MenuButton
          onClick={onMenu}
          label={`${title} options`}
          className="absolute right-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        />
      ) : null}
    </div>
  )
}
