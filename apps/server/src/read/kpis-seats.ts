import type { SQL } from 'bun'
import * as z from 'zod'
import {
  judgeLightGate,
  KPI_SEATS,
  type MoveUpBound,
  moveUpBound,
  SEAT_DELIVERY_DEFINITIONS,
  type SeatDelivery,
  type SeatKpiRow,
  type SeatKpis,
  TRIPWIRE_DAYS,
  TRIPWIRE_MIN_WATCHES,
  TRIPWIRE_POINTS,
} from '@software-factory/contract'
import { costOfAttempts, keyOf } from './kpis-attempts.ts'
import { percentile, per, windowOf } from './stats.ts'
import { USAGE_TIMEOUT_MS } from './usage.ts'

type Seat = (typeof KPI_SEATS)[number]
type CostOf = ((issues: readonly string[]) => Promise<number | null>) | null

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
 * The first verification of each Issue. For light it counts what finished on the seat only: a first watch of a ship by the
 * light lead. An Issue moved up for another reason shipped nothing on the seat, so it has no pass to count and no failure;
 * a move-up on a first watch that regressed has the regressed watch. The move-ups themselves are priced in their own
 * figure (`delivery`), not read as failed passes.
 */
function firstPass(facts: readonly Fact[], light = false): { rate: number | null; watches: number } {
  const outcomes = facts.flatMap((fact) => {
    if (light && fact.first_watch_light !== true) return []
    return fact.first_watch === null ? [] : [fact.first_watch]
  })
  return {
    rate: per(outcomes.filter((outcome) => outcome === 'passed').length, outcomes.length),
    watches: outcomes.length,
  }
}

async function rowOf(seat: Seat, facts: readonly Fact[], total: number, cost: CostOf): Promise<SeatKpiRow> {
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

const AttemptFact = z.object({
  issue_id: z.string(),
  attempt: z.coerce.number().int(),
  /** the light rule that seated the attempt; null on any other seat */
  rule: z.string().nullable(),
  /** ms from the attempt's start to its move-up; null when it was not moved up */
  moved_after_ms: z.coerce.number().nullable(),
})
type AttemptFact = z.infer<typeof AttemptFact>

/** Every attempt of the Issues (`lead_started`), with the rule that seated it and how long it ran before a move-up. */
async function attemptsOf(sql: SQL, issues: readonly string[]): Promise<AttemptFact[]> {
  if (issues.length === 0) return []
  const rows: unknown[] = await sql`
    SELECT l.issue_id, (l.payload->>'attempt')::int AS attempt, l.payload->'seat'->>'rule' AS rule,
      (SELECT extract(epoch FROM m.at - l.at) * 1000 FROM factory.issue_events m
        WHERE m.issue_id = l.issue_id AND m.kind = 'moved_up' AND m.result = 'applied'
          AND (m.payload->>'attempt')::int = (l.payload->>'attempt')::int
        ORDER BY m.version LIMIT 1) AS moved_after_ms
    FROM factory.issue_events l
    WHERE l.kind = 'lead_started' AND l.result = 'applied' AND l.issue_id = ANY(${sql.array([...issues], 'TEXT')})`
  return rows.map((row) => AttemptFact.parse(row))
}

/** The mean of the values; null with none. */
const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

/** A follow-up cost needs this many lead attempts after a move-up to stand on its own; fewer use the lead row's mean. */
const MIN_FOLLOW_UPS = 3

/**
 * What one seat delivered, in the four figures: the first pass of what finished on it, the move-up share (with what the
 * moved-up attempts cost in dollars and minutes), regressions per Issue and cost per Issue with every attempt counted.
 */
function deliveryOf(
  seat: 'light' | 'lead',
  facts: readonly Fact[],
  priced: number | null,
  moved: { cost: number | null; ms: number | null },
): SeatDelivery {
  const pass = firstPass(facts, seat === 'light')
  const movedUp = seat === 'light' ? facts.filter((fact) => fact.moved_up).length : 0
  const regressions = facts.reduce((sum, fact) => sum + fact.regressions, 0)
  return {
    issues: facts.length,
    finishedWatches: pass.watches,
    finishedPassRate: pass.rate,
    movedUp,
    movedUpShare: seat === 'light' ? per(movedUp, facts.length) : null,
    movedUpCost: seat === 'light' && moved.cost !== null && facts.length > 0 ? moved.cost / facts.length : null,
    movedUpMs: seat === 'light' ? moved.ms : null,
    regressions,
    regressionsPerIssue: per(regressions, facts.length),
    cost: priced,
    costPerIssue: priced === null ? null : per(priced, facts.length),
  }
}

/**
 * The light seat's and the lead row's four figures over the facts' Issues, and the move-up bound from the per-attempt
 * dollars of the same Issues (`moveUpBound`): light attempts, the lead row's attempts on Issues that started there, and
 * the lead attempts that followed a move-up. A cost the usage schema cannot give leaves the figure and the bound null.
 */
async function readDelivery(
  sql: SQL,
  facts: readonly Fact[],
  options: { cost: CostOf; usageTimeoutMs: number },
): Promise<{ light: SeatDelivery; lead: SeatDelivery; bound: MoveUpBound | null }> {
  const lightFacts = facts.filter((fact) => fact.seat === 'light')
  const leadFacts = facts.filter((fact) => fact.seat === 'lead')
  const attempts = await attemptsOf(
    sql,
    [...lightFacts, ...leadFacts].map((fact) => fact.issue_id),
  )
  const lightIssues = new Set(lightFacts.map((fact) => fact.issue_id))
  const cost = await costOfAttempts(sql, attempts, options.usageTimeoutMs)
  const dollars = (list: readonly AttemptFact[]): number[] | null =>
    cost === null ? null : list.map((a) => cost.get(keyOf(a.issue_id, a.attempt)) ?? 0)
  const onLight = attempts.filter((a) => a.rule !== null)
  const onLead = attempts.filter((a) => a.rule === null && !lightIssues.has(a.issue_id))
  const followUps = attempts.filter((a) => a.rule === null && lightIssues.has(a.issue_id))
  const movedOnes = onLight.filter((a) => a.moved_after_ms !== null)
  const movedDollars = dollars(movedOnes)
  const lightDollars = dollars(onLight)
  const leadDollars = dollars(onLead)
  const followDollars = dollars(followUps)
  const leadMean = leadDollars === null ? null : mean(leadDollars)
  const { lightAttempt, followUpAttempt } = {
    lightAttempt: lightDollars === null ? null : mean(lightDollars),
    followUpAttempt: followDollars !== null && followDollars.length >= MIN_FOLLOW_UPS ? mean(followDollars) : leadMean,
  }
  const share = moveUpBound({ lightAttempt, leadAttempt: leadMean, followUpAttempt })
  const bound =
    share === null || lightAttempt === null || leadMean === null || followUpAttempt === null
      ? null
      : { lightAttempt, leadAttempt: leadMean, followUpAttempt, share }
  const priced = async (list: readonly Fact[]) =>
    options.cost ? options.cost(list.map((fact) => fact.issue_id)) : null
  return {
    light: deliveryOf('light', lightFacts, await priced(lightFacts), {
      cost: movedDollars === null ? null : movedDollars.reduce((sum, value) => sum + value, 0),
      ms: mean(movedOnes.flatMap((a) => (a.moved_after_ms === null ? [] : [a.moved_after_ms]))),
    }),
    lead: deliveryOf('lead', leadFacts, await priced(leadFacts), { cost: null, ms: null }),
    bound,
  }
}

/** The tripwire over the last `TRIPWIRE_DAYS` days: the four figures of each seat, the bound and the verdict. */
async function tripwireOf(
  sql: SQL,
  options: { now: Date; cost: CostOf; usageTimeoutMs: number },
): Promise<SeatKpis['tripwire']> {
  const recent = await factsOf(sql, windowOf(options.now, TRIPWIRE_DAYS), options.now)
  const { light, lead, bound } = await readDelivery(sql, recent, options)
  const verdict = judgeLightGate({ light, lead, bound: bound?.share ?? null })
  return {
    points: TRIPWIRE_POINTS,
    days: TRIPWIRE_DAYS,
    minWatches: TRIPWIRE_MIN_WATCHES,
    light,
    lead,
    bound,
    ...verdict,
  }
}

/**
 * The tripwire over the last `TRIPWIRE_DAYS` days, read for the starts: `met` says whether triage's `small` starts on the
 * light seat now (only a measured pass opens it), `bound.share` is the move-up share a hygiene class stays under.
 */
export async function readTripwire(
  sql: SQL,
  options: { now: Date; cost: CostOf; usageTimeoutMs?: number },
): Promise<SeatKpis['tripwire']> {
  return tripwireOf(sql, { ...options, usageTimeoutMs: options.usageTimeoutMs ?? USAGE_TIMEOUT_MS })
}

/**
 * The seat table of the Improve screen: the window's Issues by the seat their first lead ran on, the light seat's four
 * figures beside the lead row's, and the tripwire for triage's `small` (`domains/leads/light.ts`) over the last
 * `TRIPWIRE_DAYS` days, whatever window the page shows.
 */
export async function readSeatKpis(
  sql: SQL,
  w: Window,
  options: { now: Date; cost: CostOf; usageTimeoutMs?: number },
): Promise<Omit<SeatKpis, 'attemptSeats'>> {
  const usageTimeoutMs = options.usageTimeoutMs ?? USAGE_TIMEOUT_MS
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
  const { bound: _bound, ...delivery } = await readDelivery(sql, facts, { cost: options.cost, usageTimeoutMs })
  return {
    rows,
    movedUpShare: light ? per(light.movedUp, light.issues) : null,
    delivery: { ...delivery, definitions: { ...SEAT_DELIVERY_DEFINITIONS } },
    tripwire: await tripwireOf(sql, { now: options.now, cost: options.cost, usageTimeoutMs }),
  }
}
