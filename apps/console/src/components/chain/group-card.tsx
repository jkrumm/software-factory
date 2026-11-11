import { ArrowsOutSimpleIcon, CheckCircleIcon, ClockIcon, StackIcon } from '@phosphor-icons/react'
import { ProjectChip } from '@/components/kit/issue-parts'
import { type ChainGroup, STEP_CAP } from '@/lib/chain-collapse'
import { dateWords, utcWords } from '@/lib/chain'
import { cn } from '@/lib/utils'

/** What a group is called: its members counted, in the words of what they are. */
export function groupTitle(group: Pick<ChainGroup, 'bucket' | 'members'>): string {
  const count = group.members.length
  if (group.bucket === 'done') return `${count} closed Issues`
  return `${count} plan rows`
}

/** Where a group's members stand, as one line. */
export function groupReason(group: Pick<ChainGroup, 'bucket' | 'step'>): string {
  if (group.bucket === 'done') return 'Done, no longer block'
  if (group.bucket === 'ready') return 'Ready to file, past the first 20'
  const step = group.step ?? 1
  if (step === 1) return 'Wait for open Issues to close'
  return `${step >= STEP_CAP ? `${STEP_CAP} or more` : step} steps from filing`
}

/**
 * Several nodes of one project folded into one card of the node's size. The whole card is a button: it opens the group
 * in place. The earliest date among its rows sits in the footer.
 */
export function GroupCard({ group, onOpen }: { group: ChainGroup; onOpen: (id: string) => void }) {
  const title = groupTitle(group)
  const done = group.bucket === 'done'
  const Icon = done ? CheckCircleIcon : StackIcon
  return (
    <article
      className={cn(
        'chain-card group relative flex h-full min-w-0 flex-col gap-1 overflow-hidden rounded-xl bg-card p-1 text-card-foreground',
        'cursor-pointer transition-colors hover:bg-accent has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-ring/60',
        !done && 'border border-dashed border-muted-foreground/50',
      )}
      style={{ boxShadow: 'var(--vx-shadow-raised)' }}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pt-2 pb-1">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <ProjectChip project={group.repo || 'No project'} />
        <span className="text-xs text-muted-foreground">{done ? 'Closed' : 'Not filed yet'}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 rounded-lg bg-background px-2.5 py-2.5">
        <h3 className="min-w-0 text-[length:var(--vx-text-sm)] leading-snug font-medium">
          <button
            type="button"
            data-testid="chain-group-open"
            aria-expanded={false}
            className="outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-['']"
            onClick={() => onOpen(group.id)}
          >
            {title}
          </button>
        </h3>
        {group.earliest ? (
          <p className="text-xs text-muted-foreground">
            Earliest{' '}
            <time dateTime={group.earliest} title={utcWords(group.earliest)} className="font-mono tabular-nums">
              {dateWords(group.earliest)}
            </time>
          </p>
        ) : null}
      </div>
      <footer className="flex items-center gap-3 px-2.5 pt-1.5 pb-2">
        <p className="flex min-w-0 flex-1 items-start gap-1.5 text-[length:var(--vx-text-sm)] text-muted-foreground">
          <ClockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 line-clamp-1" title={groupReason(group)}>
            {groupReason(group)}
          </span>
        </p>
        <span
          className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium text-foreground transition-colors group-hover:bg-accent group-hover:text-accent-foreground"
          aria-hidden="true"
        >
          <ArrowsOutSimpleIcon className="size-3.5" />
          Open
        </span>
      </footer>
    </article>
  )
}
