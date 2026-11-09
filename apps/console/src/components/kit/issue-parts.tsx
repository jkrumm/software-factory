import { CheckCircleIcon, ClockIcon, HourglassIcon, type Icon, QueueIcon } from '@phosphor-icons/react'
import { ageWords } from '@/lib/age'
import { cn } from '@/lib/utils'
import type { CardLinkProps } from './card-link'
import type { IssueKind } from './kind-badge'
import type { LozengeState } from './lozenge'
import { MenuButton } from './menu-button'

/** What IssueCard and IssueRow show; shaped from `FlowCard` (`lib/flow.ts`) plus the kind and the state. */
export interface IssueViewProps extends CardLinkProps {
  title: string
  /** The project (repo) as a chip. */
  project: string
  kind: IssueKind
  state: LozengeState
  /** The wait or queue reason, or a closed Issue's outcome; none: no line. */
  reason?: string | null
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

export function ReasonLine({ state, reason, className }: { state: LozengeState; reason: string; className?: string }) {
  const ReasonIcon = REASON_ICON[state]
  return (
    <p
      className={cn(
        'flex min-w-0 items-start gap-1.5 text-[length:var(--vx-text-sm)] text-muted-foreground',
        className,
      )}
    >
      <ReasonIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{reason}</span>
    </p>
  )
}

export function ProjectChip({ project }: { project: string }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-xs text-muted-foreground">
      {project}
    </span>
  )
}

/** The fixed right column: the age in mono, swapped for the ⋯ button on hover or focus. The absolute time is the title. */
export function AgeColumn({
  since,
  now,
  onMenu,
  title,
}: Pick<IssueViewProps, 'since' | 'now' | 'onMenu'> & { title: string }) {
  return (
    <div className="relative flex h-6 w-24 shrink-0 items-center justify-end">
      <time
        dateTime={since}
        title={new Date(since).toLocaleString()}
        className={cn(
          'font-mono text-xs tabular-nums text-muted-foreground transition-opacity',
          onMenu && 'group-focus-within:opacity-0 group-hover:opacity-0',
        )}
      >
        {ageWords(Math.max(0, now - Date.parse(since)))}
      </time>
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
