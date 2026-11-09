import { Link } from '@tanstack/react-router'
import { useFlow } from '@/lib/queries'
import { cn } from '@/lib/utils'

const COUNTS = [
  { state: 'working', label: 'working' },
  { state: 'waiting', label: 'waiting' },
  { state: 'queued', label: 'queued' },
] as const

/**
 * Working, waiting and queued, as the Flow model counts them: each a link to Flow filtered to that state. The lamp is lit
 * on Working only, steady, while a lead runs.
 */
export function Counts() {
  const states = useFlow().data?.states
  return (
    <nav aria-label="Issues in flight" className="flex shrink-0 items-center gap-x-1">
      {COUNTS.map(({ state, label }) => {
        const count = states?.[state].count
        return (
          <Link
            key={state}
            to="/flow"
            // The Flow route takes `state` (working|waiting|queued|...) from the sidebar change; `never` types both before and after it.
            search={{ state } as never}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {/* the lamp's place is kept when it is dark, so the row does not shift */}
            {state === 'working' ? (
              <span aria-hidden="true" className={cn('size-2 rounded-full', count ? 'bg-good' : 'bg-transparent')} />
            ) : null}
            <span className="min-w-[1ch] text-right text-[13px] font-semibold text-foreground">{count ?? '-'}</span>{' '}
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
