import type { SQL } from 'bun'
import * as z from 'zod'

const Row = z.object({
  operation: z.string(),
  caller: z.string(),
  status: z.coerce.number().int(),
  fields: z.array(z.string()),
  n: z.coerce.number().int(),
})

/** The refusals of one operation and status in a window, with who was refused and which fields a validation named. */
export interface RefusedOperation {
  operation: string
  status: number
  count: number
  /** callers, most refused first */
  callers: { caller: string; count: number }[]
  /** field names a 422 named, most named first */
  fields: { field: string; count: number }[]
}

const tally = (counts: Map<string, number>, key: string, n: number): void => {
  counts.set(key, (counts.get(key) ?? 0) + n)
}

const ranked = (counts: Map<string, number>): [string, number][] =>
  [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))

/** Every 4xx the API answered in the window (`factory.api_refusals`), grouped by operation and status; most refused first. */
export async function readApiRefusals(sql: SQL, window: { from: Date; to: Date }): Promise<RefusedOperation[]> {
  const rows: unknown[] = await sql`
    SELECT operation, caller, status, fields, count(*) AS n FROM factory.api_refusals
    WHERE at >= ${window.from} AND at < ${window.to} GROUP BY operation, caller, status, fields`
  const grouped = new Map<
    string,
    { operation: string; status: number; callers: Map<string, number>; fields: Map<string, number>; count: number }
  >()
  for (const raw of rows) {
    const row = Row.parse(raw)
    const key = `${row.operation}:${row.status}`
    const one = grouped.get(key) ?? {
      operation: row.operation,
      status: row.status,
      callers: new Map(),
      fields: new Map(),
      count: 0,
    }
    one.count += row.n
    tally(one.callers, row.caller, row.n)
    for (const field of row.fields) tally(one.fields, field, row.n)
    grouped.set(key, one)
  }
  return [...grouped.values()]
    .map((one) => ({
      operation: one.operation,
      status: one.status,
      count: one.count,
      callers: ranked(one.callers).map(([caller, count]) => ({ caller, count })),
      fields: ranked(one.fields).map(([field, count]) => ({ field, count })),
    }))
    .sort(
      (a, b) =>
        b.count - a.count || (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : a.status - b.status),
    )
}
