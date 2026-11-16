import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The look of a project's tables: a card step with hairlines between rows, scrolling inside itself when too narrow. */
export const TH = 'px-3 py-2 text-left text-xs font-medium text-muted-foreground'
export const TD = 'px-3 py-2 align-top'
export const NUM = 'text-right tabular-nums'
export const LINK =
  'rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:underline'

export function Table({ label, head, children }: { label: string; head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-card" style={{ boxShadow: 'var(--vx-shadow-card)' }}>
      <table aria-label={label} className="w-full text-[length:var(--vx-text-sm)]">
        <thead>
          <tr className="border-b">{head}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  )
}

/** Machine words (commands, probe names, shas): mono, breaking anywhere. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-xs wrap-anywhere', className)}>{children}</span>
}

/** One quiet sentence where a list has nothing to show. */
export function None({ children }: { children: ReactNode }) {
  return <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">{children}</p>
}
