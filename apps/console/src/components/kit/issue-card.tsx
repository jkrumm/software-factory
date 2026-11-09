import { cn } from '@/lib/utils'
import { CardLink, isLinked, LINKED_CARD } from './card-link'
import { AgeColumn, type IssueViewProps, ProjectChip, ReasonLine } from './issue-parts'
import { KindBadge } from './kind-badge'
import { Lozenge } from './lozenge'

export interface IssueCardProps extends IssueViewProps {
  /** The origin as its word, muted in the chip row. Omitted: none. */
  origin?: string
  /** Leave the Lozenge out where the surrounding column already names the state. Default true. */
  showState?: boolean
}

/**
 * One Issue as a card: clamped title, then a chip row (KindBadge, project, the Lozenge unless `showState` is false, the
 * origin word), the reason with its icon, the age right-aligned in mono. With `href` or `as` the whole card is the link (the title carries it, stretched over the card).
 */
export function IssueCard({
  title,
  project,
  kind,
  state,
  reason,
  since,
  now,
  origin,
  showState = true,
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
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[length:var(--vx-text-md)] leading-snug font-medium">
          <CardLink href={href} as={as}>
            {title}
          </CardLink>
        </h3>
        <AgeColumn since={since} now={now} onMenu={onMenu} title={title} className="w-20" />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <KindBadge kind={kind} />
        <ProjectChip project={project} />
        {showState ? <Lozenge state={state} /> : null}
        {origin ? <span className="text-xs text-muted-foreground">{origin}</span> : null}
      </div>
      {reason ? <ReasonLine state={state} reason={reason} /> : null}
    </article>
  )
}
