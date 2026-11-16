import { Link } from '@tanstack/react-router'
import type { WorkWord } from '@software-factory/contract'
import { workSplitWords } from '@/lib/flow'
import { LANGUAGE } from '@/lib/language.gen'
import { useFlow } from '@/lib/queries'
import { cn } from '@/lib/utils'

const COUNTS = [
  { key: 'running', label: 'Running' },
  { key: 'paused', label: 'Paused' },
  { key: 'ready', label: 'Ready' },
  { key: 'held', label: 'Held' },
  { key: 'checking', label: 'Checking' },
] as const satisfies readonly { key: WorkWord; label: string }[]

/**
 * Running, Paused, Ready, Held and Checking Issues, counted once for the whole console (`FlowModel.work`): each a link to Flow
 * filtered to that word. The lamp is lit on Running only, steady, while a lead runs. Checking comes last and quieter.
 */
export function Counts() {
  const work = useFlow().data?.work
  return (
    <nav
      aria-label="Issues in flight"
      className="no-scrollbar flex min-w-0 flex-1 basis-0 items-center gap-x-0.5 overflow-x-auto sm:gap-x-1 min-[1280px]:flex-none min-[1280px]:basis-auto min-[1280px]:overflow-visible"
    >
      {COUNTS.map(({ key, label }) => {
        const count = work?.[key]
        const split = work ? workSplitWords(work, key) : ''
        return (
          <Link
            key={key}
            title={`${count ?? '-'} ${label}. ${LANGUAGE[key]}${split ? ` ${label} by what holds it: ${split}.` : ''}`}
            to="/flow"
            search={{ state: key } as never}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1 text-xs sm:gap-1.5 sm:px-1.5 whitespace-nowrap text-muted-foreground tabular-nums outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
              key === 'checking' && 'opacity-70',
            )}
          >
            {/* only Running has a lamp; the slot is kept on all five so the figures line up */}
            <span
              aria-hidden="true"
              className={cn(
                'size-2 rounded-full max-sm:hidden',
                key === 'running' && count ? 'bg-good' : 'bg-transparent',
              )}
            />
            <span className="min-w-[1ch] text-right text-[13px] font-semibold text-foreground">{count ?? '-'}</span>{' '}
            {label.toLowerCase()}
          </Link>
        )
      })}
    </nav>
  )
}
