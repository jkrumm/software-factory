import type { SQL } from 'bun'
import * as z from 'zod'
import { FIX_CLASSES, type FixCommitsModel } from '@software-factory/contract'

const WEEKS = 4
const WEEK_MS = 7 * 24 * 3_600_000

const Grouped = z.object({ class: z.string(), n: z.coerce.number().int() })
const Total = z.object({ n: z.coerce.number().int(), repos: z.coerce.number().int() })

/** Fix commits per class in the last four weeks; week i is the trailing window [now - 7(i+1) days, now - 7i days). */
export async function readFixCommits(sql: SQL, input: { now: Date }): Promise<FixCommitsModel> {
  const weeks: FixCommitsModel['weeks'] = []
  for (let i = 0; i < WEEKS; i++) {
    const to = new Date(input.now.getTime() - i * WEEK_MS)
    const from = new Date(to.getTime() - WEEK_MS)
    const rows: unknown[] = await sql`
      SELECT class, count(*) AS n FROM factory.fix_commits
      WHERE committed_at >= ${from} AND committed_at < ${to} GROUP BY class`
    const byClass: Record<string, number> = Object.fromEntries(FIX_CLASSES.map((c) => [c.key, 0]))
    for (const raw of rows) {
      const row = Grouped.parse(raw)
      byClass[row.class] = row.n
    }
    weeks.push({
      from: from.toISOString(),
      to: to.toISOString(),
      total: Object.values(byClass).reduce((a, b) => a + b, 0),
      byClass,
    })
  }
  const oldest = new Date(input.now.getTime() - WEEKS * WEEK_MS)
  const [window] = await sql`
    SELECT count(*) AS n, count(DISTINCT repo) AS repos FROM factory.fix_commits
    WHERE committed_at >= ${oldest} AND committed_at < ${input.now}`
  const [ever] = await sql`SELECT count(*) AS n, 0 AS repos FROM factory.fix_commits`
  return {
    measured: Total.parse(ever).n > 0,
    classes: FIX_CLASSES.map((c) => ({ key: c.key, meaning: c.meaning })),
    weeks,
    repos: Total.parse(window).repos,
  }
}
