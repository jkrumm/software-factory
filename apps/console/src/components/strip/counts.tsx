import { Link } from '@tanstack/react-router'
import { flowCounts } from '@/lib/flow'
import { LANGUAGE } from '@/lib/language.gen'
import { useFlow } from '@/lib/queries'
import { cn } from '@/lib/utils'

const COUNTS = [
  { state: 'working', label: 'working' },
  { state: 'waiting', label: 'waiting' },
  { state: 'queued', label: 'queued' },
] as const

/**
 * Working, waiting and queued Issues, counted once for the whole console (`flowCounts`): each a link to Flow's list of the Issues it counts. The lamp is lit
 * on Working only, steady, while a lead runs.
 */
export function Counts() {
  const data = useFlow().data
  const counts = data ? flowCounts(data) : undefined
  return (
    <nav aria-label="Issues in flight" className="flex shrink-0 items-center gap-x-1">
      {COUNTS.map(({ state, label }) => {
        const count = counts?.[state]
        return (
          <Link
            key={state}
            title={`${count ?? '-'} ${label}. ${LANGUAGE[state]}`}
            to="/flow"
            // The Flow route takes `state` (working|waiting|queued|closed): the list of the Issues this count counts.
            search={{ state } as never}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {/* only Working has a lamp; the slot is kept on all three so the figures line up */}
            <span
              aria-hidden="true"
              className={cn('size-2 rounded-full', state === 'working' && count ? 'bg-good' : 'bg-transparent')}
            />
            <span className="min-w-[1ch] text-right text-[13px] font-semibold text-foreground">{count ?? '-'}</span>{' '}
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
