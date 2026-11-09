import type { Icon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { CardLink, isLinked, LINKED_CARD } from './card-link'
import { AgeColumn, type IssueViewProps, ProjectChip, ReasonLine } from './issue-parts'
import { KindBadge } from './kind-badge'
import { Lozenge } from './lozenge'

export type IssueCardProps = Omit<IssueViewProps, 'since'> & {
  /** When it entered its state (ISO). `null`: the card has no age (a plan row) and the column is left out. */
  since: string | null
  /** The origin as its word, muted in the chip row. Omitted: none. */
  origin?: string
  /** Leave the Lozenge out where the surrounding column already names the state. Default true. */
  showState?: boolean
  /** The Lozenge's words where the state's own word is not the one to show. */
  stateLabel?: string
  /** The reason line's icon where the state's icon is not the one to show. */
  reasonIcon?: Icon
  /** The reason line's hover text where it is not the reason itself. */
  reasonTitle?: string
  /** The raised shadow step (a card on a canvas step, such as the chain's) instead of the card step. */
  raised?: boolean
}

/**
 * One Issue as a card: clamped title, then a chip row (KindBadge, project, the Lozenge unless `showState` is false, the
 * origin word), the reason with its icon, the age right-aligned in mono (none when `since` is null). With `href` or `as` the whole card is the link (the title carries it, stretched over the card).
 */
export function IssueCard({
  title,
  project,
  projectAs,
  kind,
  state,
  reason,
  since,
  now,
  origin,
  showState = true,
  stateLabel,
  reasonIcon,
  reasonTitle,
  raised,
  onMenu,
  href,
  as,
  className,
}: IssueCardProps) {
  const linked = isLinked({ href, as })
  return (
    <article
      className={cn(
        'group relative flex min-w-0 flex-col gap-2 rounded-xl bg-card p-3 text-card-foreground',
        linked && cn(LINKED_CARD, 'has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50'),
        className,
      )}
      style={{ boxShadow: raised ? 'var(--vx-shadow-raised)' : 'var(--vx-shadow-card)' }}
    >
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[length:var(--vx-text-md)] leading-snug font-medium">
          <CardLink href={href} as={as}>
            {title}
          </CardLink>
        </h3>
        {since === null ? null : <AgeColumn since={since} now={now} onMenu={onMenu} title={title} className="w-20" />}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <KindBadge kind={kind} />
        <ProjectChip project={project} as={projectAs} />
        {showState ? <Lozenge state={state}>{stateLabel}</Lozenge> : null}
        {origin ? <span className="text-xs text-muted-foreground">{origin}</span> : null}
      </div>
      {reason ? <ReasonLine state={state} reason={reason} icon={reasonIcon} title={reasonTitle} /> : null}
    </article>
  )
}
