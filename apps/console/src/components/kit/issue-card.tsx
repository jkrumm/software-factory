import type { Icon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { CardLink, isLinked, LINKED_CARD } from './card-link'
import { Age, type IssueViewProps, IssueNumber, ProjectChip, ReasonLine } from './issue-parts'
import { KindIcon } from './kind-badge'
import { Lozenge } from './lozenge'
import { MenuButton } from './menu-button'

export type IssueCardProps = Omit<IssueViewProps, 'since'> & {
  /** When it entered its state (ISO). `null`: the card has no age (a plan row) and none is shown. */
  since: string | null
  /** The origin as its word, muted in the header. Omitted: none. */
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
  /** This is the Issue open beside the board (the peek): the shell takes the next surface step. */
  selected?: boolean
  /** The Chain's node: a two-line title and a one-line reason, so the card fits a fixed, shorter height. */
  compact?: boolean
}

/**
 * One Issue as a card, built like a StatCard: the shell (`bg-card`) holds the header (kind icon, project, number,
 * origin word, the Lozenge unless `showState` is false) and the footer (the reason, the age in mono; none when `since`
 * is null); the title sits alone in the body, one surface step below. With `href` or `as` the whole card is the link
 * (the title carries it, stretched over the card).
 */
export function IssueCard({
  title,
  project,
  projectAs,
  kind,
  number,
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
  compact,
  selected,
  onMenu,
  href,
  as,
  className,
}: IssueCardProps) {
  const linked = isLinked({ href, as })
  const hasFooter = Boolean(reason) || since !== null
  return (
    <article
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative flex min-w-0 flex-col gap-1 rounded-xl bg-card p-1 text-card-foreground',
        linked && LINKED_CARD,
        selected && 'bg-accent',
        className,
      )}
      style={{ boxShadow: raised ? 'var(--vx-shadow-raised)' : 'var(--vx-shadow-card)' }}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pt-2 pb-1">
        <KindIcon kind={kind} />
        <ProjectChip project={project} as={projectAs} />
        {number == null ? null : <IssueNumber number={number} />}
        {origin ? <span className="text-xs text-muted-foreground">{origin}</span> : null}
        {showState || onMenu ? (
          <div className="relative ml-auto flex h-6 items-center justify-end">
            {showState ? (
              <span
                className={cn('transition-opacity', onMenu && 'group-focus-within:opacity-0 group-hover:opacity-0')}
              >
                <Lozenge state={state}>{stateLabel}</Lozenge>
              </span>
            ) : null}
            {onMenu ? (
              <MenuButton
                onClick={onMenu}
                label={`${title} options`}
                className={cn(
                  'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
                  showState && 'absolute right-0',
                )}
              />
            ) : null}
          </div>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 rounded-lg bg-background px-2.5 py-2.5">
        <h3
          title={title}
          className={cn(
            'min-w-0 text-[length:var(--vx-text-sm)] leading-snug font-medium wrap-anywhere',
            compact ? 'line-clamp-2' : 'line-clamp-3',
          )}
        >
          <CardLink href={href} as={as}>
            {title}
          </CardLink>
        </h3>
      </div>
      {hasFooter ? (
        <footer className={cn('flex gap-3 px-2.5', reason ? 'items-start pt-1.5 pb-2' : 'items-center pt-0.5 pb-1.5')}>
          {reason ? (
            <ReasonLine
              state={state}
              reason={reason}
              icon={reasonIcon}
              title={reasonTitle}
              className={cn('min-w-0 flex-1', compact ? '[&>span]:line-clamp-1' : '[&>span]:line-clamp-2')}
            />
          ) : (
            <span className="flex-1" />
          )}
          {since === null ? null : <Age since={since} now={now} className={cn('shrink-0', reason && 'mt-0.5')} />}
        </footer>
      ) : null}
    </article>
  )
}
