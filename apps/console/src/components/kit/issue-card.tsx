import { cn } from '@/lib/utils'
import { CardLink, isLinked, LINKED_CARD } from './card-link'
import { AgeColumn, type IssueViewProps, ProjectChip, ReasonLine } from './issue-parts'
import { KIND_ICON } from './kind-badge'
import { Lozenge } from './lozenge'

export type IssueCardProps = IssueViewProps

/**
 * One Issue as a card: kind icon, clamped title, project chip, Lozenge, the reason with its icon, the age in a fixed
 * right column. With `href` or `as` the whole card is the link (the title carries it, stretched over the card).
 */
export function IssueCard({
  title,
  project,
  kind,
  state,
  reason,
  since,
  now,
  onMenu,
  href,
  as,
  className,
}: IssueCardProps) {
  const KindIcon = KIND_ICON[kind]
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
        <KindIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={kind} role="img" />
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[length:var(--vx-text-md)] leading-snug font-medium">
          <CardLink href={href} as={as}>
            {title}
          </CardLink>
        </h3>
        <AgeColumn since={since} now={now} onMenu={onMenu} title={title} />
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <ProjectChip project={project} />
        <Lozenge state={state} />
      </div>
      {reason ? <ReasonLine state={state} reason={reason} className="pl-6" /> : null}
    </article>
  )
}
