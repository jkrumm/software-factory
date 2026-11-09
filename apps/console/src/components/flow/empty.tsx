import { COLUMN_EMPTY } from '@/lib/column-empty'
import type { ColumnKey } from '@/lib/flow'

/** An empty column or tab: what is missing and what puts a card there, left-aligned under the column's heading. */
export function EmptyColumn({ column }: { column: ColumnKey }) {
  const { title, cause } = COLUMN_EMPTY[column]
  return (
    <div className="grid gap-1 px-1 py-3 text-sm">
      <p className="font-medium">{title}</p>
      <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">{cause}</p>
    </div>
  )
}
