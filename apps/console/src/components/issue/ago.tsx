import { agoWords } from '@/lib/issue'
import { cn } from '@/lib/utils'

/** A time as "5 min ago" with the absolute time on hover; `now` is the page's one clock. */
export function Ago({ iso, now, className }: { iso: string; now: number; className?: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString('en-GB')} className={cn('tabular-nums', className)}>
      {agoWords(iso, now)}
    </time>
  )
}
