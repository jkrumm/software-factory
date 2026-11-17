import type { SQL } from 'bun'
import * as z from 'zod'
import {
  KPI_SEATS,
  LIGHT_FROM_TRIAGE_SMALL,
  type SeatKpiRow,
  type SeatKpis,
  TRIPWIRE_DAYS,
  TRIPWIRE_POINTS,
} from '@software-factory/contract'
import { percentile, per, windowOf } from './stats.ts'

type Seat = (typeof KPI_SEATS)[number]

interface Window {
  from: Date
  to: Date
}

const Fact = z.object({
  issue_id: z.string(),
  seat: z.enum(KPI_SEATS),
  moved_up: z.boolean(),
  first_watch: z.string().nullable(),
  /** watch 1 shipped from an attempt the light rule seated */
  first_watch_light: z.boolean().nullable(),
  regressions: z.coerce.number().int(),
  refusals: z.coerce.number().int(),
  cycle_ms: z.coerce.number().nullable(),
  working_ms: z.coerce.number(),
})
type Fact = z.infer<typeof Fact>

/**
 * The Issues whose first lead started in the window, each with the seat that first lead ran on (`light` when the light
 * rule seated it, `filed` when the Issue was filed or seated with a seat, else `lead`) and what became of it, up to `now`.
 */
async function factsOf(sql: SQL, w: Window, now: Date): Promise<Fact[]> {
  const rows: unknown[] = await sql`
    WITH first AS (
      SELECT DISTINCT ON (e.issue_id) e.issue_id, e.at, e.payload->'seat'->>'rule' AS rule
      FROM factory.issue_events e
      WHERE e.kind = 'lead_started' AND e.result = 'applied' AND e.issue_id IN (
        SELECT s.issue_id FROM factory.issue_events s
        WHERE s.kind = 'lead_started' AND s.result = 'applied' AND s.at >= ${w.from} AND s.at < ${w.to})
      ORDER BY e.issue_id, e.version),
    cohort AS (
      SELECT f.issue_id,
        CASE
          WHEN f.rule IS NOT NULL THEN 'light'
          WHEN fl.payload ? 'seat' OR EXISTS (
            SELECT 1 FROM factory.issue_events x
            WHERE x.issue_id = f.issue_id AND x.kind = 'seated' AND x.result = 'applied') THEN 'filed'
          ELSE 'lead'
        END AS seat,
        fl.at AS filed_at
      FROM first f JOIN factory.issue_events fl ON fl.issue_id = f.issue_id AND fl.version = 1
      WHERE f.at >= ${w.from} AND f.at < ${w.to})
    SELECT c.issue_id, c.seat,
      EXISTS (
        SELECT 1 FROM factory.issue_events m
        WHERE m.issue_id = c.issue_id AND m.kind = 'moved_up' AND m.result = 'applied') AS moved_up,
      (SELECT w.answer FROM factory.quality_watches w
        WHERE w.issue_id = c.issue_id AND w.watch = 1 AND w.answer IN ('passed', 'regressed')) AS first_watch,
      (SELECT EXISTS (
          SELECT 1 FROM factory.issue_events l
          WHERE l.issue_id = c.issue_id AND l.kind = 'lead_started' AND l.result = 'applied'
            AND (l.payload->>'attempt')::int = w.attempt AND l.payload->'seat'->>'rule' IS NOT NULL)
        FROM factory.quality_watches w WHERE w.issue_id = c.issue_id AND w.watch = 1) AS first_watch_light,
      (SELECT count(*) FROM factory.quality_watches w
        WHERE w.issue_id = c.issue_id AND w.answer = 'regressed') AS regressions,
      (SELECT count(*) FROM factory.quality_ships q
        WHERE q.issue_id = c.issue_id AND q.result = 'refused') AS refusals,
      (SELECT extract(epoch FROM x.at - c.filed_at) * 1000 FROM factory.issue_events x
        WHERE x.issue_id = c.issue_id AND x.result = 'applied' AND x.to_state = 'closed'
        ORDER BY x.version DESC LIMIT 1) AS cycle_ms,
      (SELECT coalesce(sum(extract(epoch FROM coalesce(t.nxt, ${now}) - t.at)) * 1000, 0) FROM (
        SELECT x.to_state, x.at, lead(x.at) OVER (ORDER BY x.version) AS nxt
        FROM factory.issue_events x WHERE x.issue_id = c.issue_id AND x.result = 'applied') t
        WHERE t.to_state = 'working') AS working_ms
    FROM cohort c`
  return rows.map((row) => Fact.parse(row))
}

/**
 * The first verification of each Issue. For light, a moved-up Issue whose first watch the light lead did not ship counts
 * as a failed first verification: the light seat did not get it through, and the tripwire must not read the lead's pass
 * as light's.
 */
function firstPass(facts: readonly Fact[], light = false): { rate: number | null; watches: number } {
  const outcomes = facts.flatMap((fact) => {
    if (light && fact.moved_up && fact.first_watch_light !== true) return ['regressed']
    return fact.first_watch === null ? [] : [fact.first_watch]
  })
  return {
    rate: per(outcomes.filter((outcome) => outcome === 'passed').length, outcomes.length),
    watches: outcomes.length,
  }
}

async function rowOf(
  seat: Seat,
  facts: readonly Fact[],
  total: number,
  cost: ((issues: readonly string[]) => Promise<number | null>) | null,
): Promise<SeatKpiRow> {
  const pass = firstPass(facts, seat === 'light')
  const priced = cost ? await cost(facts.map((fact) => fact.issue_id)) : null
  return {
    seat,
    issues: facts.length,
    share: per(facts.length, total),
    movedUp: seat === 'light' ? facts.filter((fact) => fact.moved_up).length : 0,
    firstWatches: pass.watches,
    firstPassRate: pass.rate,
    regressions: facts.reduce((sum, fact) => sum + fact.regressions, 0),
    refusals: facts.reduce((sum, fact) => sum + fact.refusals, 0),
    cycleP50Ms: percentile(
      facts.flatMap((fact) => (fact.cycle_ms === null ? [] : [fact.cycle_ms])),
      0.5,
    ),
    workingP50Ms: percentile(
      facts.map((fact) => fact.working_ms),
      0.5,
    ),
    costPerIssue: priced === null ? null : per(priced, facts.length),
  }
}

/**
 * The seat table of the Improve screen: the window's Issues by the seat their first lead ran on, and the tripwire for
 * triage's `small` (`domains/leads/light.ts`) over the last `TRIPWIRE_DAYS` days, whatever window the page shows.
 */
export async function readSeatKpis(
  sql: SQL,
  w: Window,
  options: { now: Date; cost: ((issues: readonly string[]) => Promise<number | null>) | null },
): Promise<Omit<SeatKpis, 'attemptSeats'>> {
  const facts = await factsOf(sql, w, options.now)
  const rows: SeatKpiRow[] = []
  for (const seat of KPI_SEATS) {
    rows.push(
      await rowOf(
        seat,
        facts.filter((fact) => fact.seat === seat),
        facts.length,
        options.cost,
      ),
    )
  }
  const light = rows.find((row) => row.seat === 'light')
  const recent = await factsOf(sql, windowOf(options.now, TRIPWIRE_DAYS), options.now)
  const lightPass = firstPass(
    recent.filter((fact) => fact.seat === 'light'),
    true,
  )
  const leadPass = firstPass(recent.filter((fact) => fact.seat === 'lead'))
  return {
    rows,
    movedUpShare: light ? per(light.movedUp, light.issues) : null,
    tripwire: {
      on: LIGHT_FROM_TRIAGE_SMALL,
      points: TRIPWIRE_POINTS,
      days: TRIPWIRE_DAYS,
      light: lightPass.rate,
      lead: leadPass.rate,
      lightWatches: lightPass.watches,
      leadWatches: leadPass.watches,
      met:
        lightPass.rate === null || leadPass.rate === null
          ? null
          : (leadPass.rate - lightPass.rate) * 100 <= TRIPWIRE_POINTS,
    },
  }
}
