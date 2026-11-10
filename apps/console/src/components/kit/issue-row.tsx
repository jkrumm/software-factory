import { cn } from '@/lib/utils'
import { CardLink, isLinked, LINKED_CARD } from './card-link'
import { AgeColumn, type IssueViewProps, IssueNumber, ProjectChip, ReasonLine } from './issue-parts'
import { KindIcon } from './kind-badge'
import { Lozenge } from './lozenge'

export type IssueRowProps = IssueViewProps

/** The dense one-line Issue for lists. A hairline sits between rows (put them in one parent), no box. */
export function IssueRow({
  title,
  project,
  kind,
  number,
  state,
  reason,
  since,
  now,
  onMenu,
  href,
  as,
  className,
}: IssueRowProps) {
  const linked = isLinked({ href, as })
  return (
    <div
      className={cn(
        'group relative flex min-h-9 flex-wrap items-center gap-3 px-3 py-1.5 text-[length:var(--vx-text-sm)] not-first:border-t',
        linked && LINKED_CARD,
        className,
      )}
    >
      <KindIcon kind={kind} />
      <span className="hidden w-12 shrink-0 min-[40rem]:block">
        {number == null ? null : <IssueNumber number={number} />}
      </span>
      <span className="min-w-0 flex-1 font-medium min-[40rem]:line-clamp-1">
        <CardLink href={href} as={as}>
          {title}
        </CardLink>
      </span>
      <span className="hidden w-20 shrink-0 min-[40rem]:block">
        <ProjectChip project={project} />
      </span>
      <span className="shrink-0 min-[40rem]:w-24">
        <Lozenge state={state} />
      </span>
      <div className="hidden shrink-0 min-[64rem]:block min-[64rem]:w-80 min-[90rem]:w-[28rem]">
        {reason ? <ReasonLine state={state} reason={reason} className="[&>span]:truncate" /> : null}
      </div>
      <AgeColumn since={since} now={now} onMenu={onMenu} title={title} />
      {reason ? (
        <ReasonLine state={state} reason={reason} className="basis-full pl-8 text-xs min-[64rem]:hidden" />
      ) : null}
    </div>
  )
}
