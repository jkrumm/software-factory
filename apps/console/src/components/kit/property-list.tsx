import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PropertyListProps {
  /** A missing value (`null`, `undefined`, an empty string) reads "None". */
  items: { label: ReactNode; value?: ReactNode }[]
  className?: string
}

const missing = (value: ReactNode): boolean => value === null || value === undefined || value === '' || value === false

/** A definition list: a small muted label above its value, three columns from 40 rem. */
export function PropertyList({ items, className }: PropertyListProps) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-4 min-[40rem]:grid-cols-3', className)}>
      {items.map(({ label, value }, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 text-[length:var(--vx-text-sm)] wrap-break-word">
            {missing(value) ? <span className="text-muted-foreground">None</span> : value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
