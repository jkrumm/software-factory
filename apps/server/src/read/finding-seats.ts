import type { SQL } from 'bun'
import * as z from 'zod'
import { type ClassStart, type FindingClass, judgeClassSeat } from '@software-factory/contract'
import { per } from './stats.ts'

type Seat = NonNullable<FindingClass['seat']>

const Row = z.object({
  class: z.string(),
  /** the first lead of the Issue started on the light seat (the rule seated it) */
  light: z.boolean(),
  moved_up: z.boolean(),
  first_watch: z.string().nullable(),
  /** watch 1 shipped from an attempt the light rule seated */
  first_watch_light: z.boolean().nullable(),
})
type Row = z.infer<typeof Row>

/** Every hygiene Issue whose first lead started, newest first within its class. */
async function rowsOf(sql: SQL): Promise<Row[]> {
  const rows: unknown[] = await sql`
    SELECT lf.class, (fl.payload->'seat'->>'rule') IS NOT NULL AS light,
      EXISTS (
        SELECT 1 FROM factory.issue_events m
        WHERE m.issue_id = lf.issue_id AND m.kind = 'moved_up' AND m.result = 'applied') AS moved_up,
      (SELECT w.answer FROM factory.quality_watches w
        WHERE w.issue_id = lf.issue_id AND w.watch = 1 AND w.answer IN ('passed', 'regressed')) AS first_watch,
      (SELECT EXISTS (
          SELECT 1 FROM factory.issue_events l
          WHERE l.issue_id = lf.issue_id AND l.kind = 'lead_started' AND l.result = 'applied'
            AND (l.payload->>'attempt')::int = w.attempt AND l.payload->'seat'->>'rule' IS NOT NULL)
        FROM factory.quality_watches w WHERE w.issue_id = lf.issue_id AND w.watch = 1) AS first_watch_light
    FROM factory.loop_findings lf
    JOIN LATERAL (
      SELECT e.at, e.payload FROM factory.issue_events e
      WHERE e.issue_id = lf.issue_id AND e.kind = 'lead_started' AND e.result = 'applied'
      ORDER BY e.version LIMIT 1) fl ON true
    WHERE lf.loop = 'hygiene'
    ORDER BY lf.class, fl.at DESC, lf.issue_id DESC`
  return rows.map((row) => Row.parse(row))
}

function seatOf(rows: readonly Row[], bound: number | null): Seat {
  const starts: ClassStart[] = rows.map((row) => ({ light: row.light, movedUp: row.moved_up }))
  const verdict = judgeClassSeat(starts, bound)
  const light = rows.filter((row) => row.light)
  const watches = light.filter((row) => row.first_watch_light === true && row.first_watch !== null)
  return {
    starts: light.length,
    movedUp: light.filter((row) => row.moved_up).length,
    finishedWatches: watches.length,
    finishedPassRate: per(watches.filter((row) => row.first_watch === 'passed').length, watches.length),
    windowStarts: verdict.starts,
    windowMovedUp: verdict.movedUp,
    windowShare: verdict.share,
    out: verdict.out,
    why: verdict.why,
  }
}

/** Where each hygiene class's Issues start, by class (the loop's own class name), against the move-up bound (null: none is out). */
export async function readClassSeats(sql: SQL, bound: number | null): Promise<Map<string, Seat>> {
  const byClass = new Map<string, Row[]>()
  for (const row of await rowsOf(sql)) byClass.set(row.class, [...(byClass.get(row.class) ?? []), row])
  return new Map([...byClass].map(([name, rows]) => [name, seatOf(rows, bound)]))
}

/** The hygiene classes whose next Issue starts on the standard lead. */
export async function readClassesOut(sql: SQL, bound: number | null): Promise<ReadonlySet<string>> {
  const seats = await readClassSeats(sql, bound)
  return new Set([...seats].filter(([, seat]) => seat.out).map(([name]) => name))
}
