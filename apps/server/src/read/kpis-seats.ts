import type { SQL } from 'bun'
import * as z from 'zod'
import {
  judgeLightGate,
  KPI_SEATS,
  moveSignOf,
  type MoveStepKpis,
  type MoveUpBound,
  moveUpBound,
  moveUpTimeBound,
  regressionGap,
  SEAT_DELIVERY_DEFINITIONS,
  type SeatDelivery,
  type SeatKpiRow,
  type SeatKpis,
  TRIPWIRE_CONFIDENCE,
  TRIPWIRE_MAX_DAYS,
  TRIPWIRE_MIN_WATCHES,
  TRIPWIRE_POINTS,
  TRIPWIRE_TARGET_WATCHES,
  tripwireFrom,
} from '@software-factory/contract'
import { boundedRead } from './bounded.ts'
import { percentile, per, windowOf } from './stats.ts'
import { USAGE_TIMEOUT_MS } from './usage.ts'

type Seat = (typeof KPI_SEATS)[number]
type CostOf = ((issues: readonly string[]) => Promise<number | null>) | null
type Step = 'light' | 'lead'

interface Window {
  from: Date
  to: Date
}

const Fact = z.object({
  issue_id: z.string(),
  seat: z.enum(KPI_SEATS),
  /** the tier and effort the first lead ran on: what a filed row is split by */
  tier: z.string().nullable(),
  effort: z.string().nullable(),
  moved_up: z.boolean(),
  /** the first lead ran on the lead row under a filed seat that asked for the move-up (`moveUp`) */
  lead_move_up: z.boolean(),
  /** when the Issue's first lead started */
  started_at: z.coerce.date(),
  first_watch: z.string().nullable(),
  /** watch 1 shipped from an attempt the light rule seated */
  first_watch_light: z.boolean().nullable(),
  /** watch 1 shipped from an attempt that ran under a move-up seat (`lead_move_up`) */
  first_watch_move_up: z.boolean().nullable(),
  regressions: z.coerce.number().int(),
  refusals: z.coerce.number().int(),
  cycle_ms: z.coerce.number().nullable(),
  working_ms: z.coerce.number(),
})
export type Fact = z.infer<typeof Fact>

/** A move-up of an Issue: `move_to` is null on the light step and `strong` on the lead row's. */
const MoveFact = z.object({
  issue_id: z.string(),
  move_to: z.string().nullable(),
  why: z.string().nullable(),
  /** a watch of a later attempt than the moved one ended regressed */
  regressed_after: z.boolean(),
  state: z.string(),
  outcome: z.string().nullable(),
})
type MoveFact = z.infer<typeof MoveFact>

/** The tier and effort a filed row is split by; null on the light and lead rows. */
interface Pair {
  tier: string | null
  effort: string | null
}
const NO_PAIR: Pair = { tier: null, effort: null }

const onLightSeat = (fact: Fact): boolean => fact.first_watch_light === true
const anySeat = (): boolean => true
const stepOf = (move: MoveFact): Step => (move.move_to === 'strong' ? 'lead' : 'light')

/**
 * The Issues whose first lead started in the window, each with the seat that first lead ran on (`light` when the light
 * rule seated it, `filed` when the Issue was filed or seated with a seat, else `lead`) and what became of it, up to `now`.
 */
export async function factsOf(sql: SQL, w: Window, now: Date): Promise<Fact[]> {
  const rows: unknown[] = await sql`
    WITH first AS (
      SELECT DISTINCT ON (e.issue_id) e.issue_id, e.at, e.payload->'seat'->>'rule' AS rule,
        e.payload->'seat'->>'tier' AS tier, e.payload->'seat'->>'effort' AS effort,
        coalesce((e.payload->'seat'->>'role') = 'lead' AND (e.payload->'seat'->>'moveUp') = 'true', false) AS lead_move_up
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
        f.tier, f.effort, f.lead_move_up,
        fl.at AS filed_at, f.at AS started_at
      FROM first f JOIN factory.issue_events fl ON fl.issue_id = f.issue_id AND fl.version = 1
      WHERE f.at >= ${w.from} AND f.at < ${w.to})
    SELECT c.issue_id, c.seat, c.tier, c.effort, c.lead_move_up, c.started_at,
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
      (SELECT EXISTS (
          SELECT 1 FROM factory.issue_events l
          WHERE l.issue_id = c.issue_id AND l.kind = 'lead_started' AND l.result = 'applied'
            AND (l.payload->>'attempt')::int = w.attempt
            AND coalesce((l.payload->'seat'->>'role') = 'lead' AND (l.payload->'seat'->>'moveUp') = 'true', false))
        FROM factory.quality_watches w WHERE w.issue_id = c.issue_id AND w.watch = 1) AS first_watch_move_up,
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

/** The applied move-ups of the Issues, the light step's (no `to`) and the lead row's (`to` 'strong'), with what became of each Issue. */
async function movesOf(sql: SQL, issues: readonly string[]): Promise<MoveFact[]> {
  if (issues.length === 0) return []
  const rows: unknown[] = await sql`
    SELECT m.issue_id, m.payload->>'to' AS move_to, m.payload->>'why' AS why,
      EXISTS (
        SELECT 1 FROM factory.quality_watches w
        WHERE w.issue_id = m.issue_id AND w.answer = 'regressed' AND w.attempt > (m.payload->>'attempt')::int) AS regressed_after,
      i.state, i.outcome
    FROM factory.issue_events m JOIN factory.issues i ON i.id = m.issue_id
    WHERE m.kind = 'moved_up' AND m.result = 'applied' AND (m.payload->>'to' IS NULL OR m.payload->>'to' = 'strong')
      AND m.issue_id = ANY(${sql.array([...issues], 'TEXT')})
    ORDER BY m.issue_id, m.version`
  return rows.map((row) => MoveFact.parse(row))
}

/**
 * One move-up step over the Issues: `moved` the Issues whose first move of the step is in them, by the sign that move's
 * `why` names, and where each ended. A step moves an Issue once; a later move of the same step is not counted.
 */
function stepFiguresOf(moves: readonly MoveFact[], step: Step): MoveStepKpis {
  const firsts = new Map<string, MoveFact>()
  for (const move of moves) {
    if (stepOf(move) !== step || firsts.has(move.issue_id)) continue
    firsts.set(move.issue_id, move)
  }
  const list = [...firsts.values()]
  const signs = list.map((move) => moveSignOf(move.why ?? ''))
  const count = (sign: string) => signs.filter((value) => value === sign).length
  return {
    moved: list.length,
    bySign: {
      outOfDepth: count('outOfDepth'),
      regressed: count('regressed'),
      stalled: count('stalled'),
      refusedShips: count('refusedShips'),
    },
    outcomes: {
      done: list.filter((move) => move.outcome === 'done').length,
      dropped: list.filter((move) => move.outcome === 'dropped' || move.outcome === 'cancelled').length,
      regressedAfter: list.filter((move) => move.regressed_after).length,
      open: list.filter((move) => move.state !== 'closed').length,
    },
  }
}

/**
 * The first verification of each Issue, over the Issues the `onSeat` test keeps. For light that is a first watch of a ship by
 * the light lead only: an Issue moved up for another reason shipped nothing on the seat, so it has no pass to count and no
 * failure; a move-up on a first watch that regressed has the regressed watch. The move-ups themselves are priced in their own
 * figure (`delivery`), not read as failed passes.
 */
function firstPass(facts: readonly Fact[], onSeat: (fact: Fact) => boolean): { rate: number | null; watches: number } {
  const outcomes = facts.flatMap((fact) => {
    if (!onSeat(fact)) return []
    return fact.first_watch === null ? [] : [fact.first_watch]
  })
  return {
    rate: per(outcomes.filter((outcome) => outcome === 'passed').length, outcomes.length),
    watches: outcomes.length,
  }
}

async function rowOf(seat: Seat, facts: readonly Fact[], total: number, cost: CostOf, pair: Pair): Promise<SeatKpiRow> {
  const pass = firstPass(facts, seat === 'light' ? onLightSeat : anySeat)
  const priced = cost ? await cost(facts.map((fact) => fact.issue_id)) : null
  return {
    seat,
    tier: pair.tier,
    effort: pair.effort,
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

/** The filed Issues split by the tier and effort their first lead ran on: one group per pair, in pair order. */
function pairsOf(facts: readonly Fact[]): (Pair & { facts: Fact[] })[] {
  const groups = new Map<string, Pair & { facts: Fact[] }>()
  for (const fact of facts) {
    const groupKey = `${fact.tier ?? ''} ${fact.effort ?? ''}`
    const group = groups.get(groupKey) ?? { tier: fact.tier, effort: fact.effort, facts: [] }
    group.facts.push(fact)
    groups.set(groupKey, group)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group)
}

const AttemptFact = z.object({
  issue_id: z.string(),
  attempt: z.coerce.number().int(),
  /** the light rule that seated the attempt; null on any other seat */
  rule: z.string().nullable(),
  /** the attempt ran under a move-up seat: a filed lead-row seat that asked for the move-up (`moveUp`) */
  move_up: z.boolean(),
  /** ms from the attempt's start to its move-up; null when it was not moved up */
  moved_after_ms: z.coerce.number().nullable(),
})
type AttemptFact = z.infer<typeof AttemptFact>

/** Every attempt of the Issues (`lead_started`), with the rule that seated it and how long it ran before a move-up. */
async function attemptsOf(sql: SQL, issues: readonly string[]): Promise<AttemptFact[]> {
  if (issues.length === 0) return []
  const rows: unknown[] = await sql`
    SELECT l.issue_id, (l.payload->>'attempt')::int AS attempt, l.payload->'seat'->>'rule' AS rule,
      coalesce((l.payload->'seat'->>'role') = 'lead' AND (l.payload->'seat'->>'moveUp') = 'true', false) AS move_up,
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
  facts: readonly Fact[],
  options: {
    /** whether a first watch counts: it shipped on the seat */
    onSeat: (fact: Fact) => boolean
    /** whether the Issue moved up off the seat; null on a seat that cannot move up */
    movedUp: ((fact: Fact) => boolean) | null
    priced: number | null
    /** dollars the moved-up attempts cost (null while unmeasured) and their mean ms before the move */
    moved: { cost: number | null; ms: number | null }
  },
): SeatDelivery {
  const pass = firstPass(facts, options.onSeat)
  const movedUp = options.movedUp ? facts.filter(options.movedUp).length : 0
  const regressions = facts.reduce((sum, fact) => sum + fact.regressions, 0)
  const { cost, ms } = options.moved
  return {
    issues: facts.length,
    finishedWatches: pass.watches,
    finishedPassRate: pass.rate,
    movedUp,
    movedUpShare: options.movedUp ? per(movedUp, facts.length) : null,
    movedUpCost: options.movedUp && cost !== null && facts.length > 0 ? cost / facts.length : null,
    movedUpMs: options.movedUp ? ms : null,
    regressions,
    regressionsPerIssue: per(regressions, facts.length),
    cost: options.priced,
    costPerIssue: options.priced === null ? null : per(options.priced, facts.length),
  }
}

/**
 * The light seat's, the lead row's and the lead row's move-up seat's four figures over the facts' Issues, and the move-up
 * bound from the per-attempt dollars of the same Issues (`moveUpBound`): light attempts, the lead row's attempts on Issues that
 * started there, and the lead attempts that followed a move-up. A cost the usage schema cannot give leaves the figure and the
 * bound null. The same break-even in minutes (`moveUpTimeBound`) reads three medians: the working ms of light Issues that did
 * not move up, the ms the moved-up attempts ran before they moved, and the lead row's working ms per Issue.
 */
async function readDelivery(
  sql: SQL,
  facts: readonly Fact[],
  options: { cost: CostOf; usageTimeoutMs: number },
): Promise<{ light: SeatDelivery; lead: SeatDelivery; leadMoveUp: SeatDelivery; bound: MoveUpBound | null }> {
  const lightFacts = facts.filter((fact) => fact.seat === 'light')
  const leadFacts = facts.filter((fact) => fact.seat === 'lead')
  const moveUpFacts = facts.filter((fact) => fact.lead_move_up)
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
  const movedMs = percentile(
    movedOnes.flatMap((a) => (a.moved_after_ms === null ? [] : [a.moved_after_ms])),
    0.5,
  )
  const leadMs = percentile(
    leadFacts.map((fact) => fact.working_ms),
    0.5,
  )
  // with no light Issue that did not move up, light has shown no saving: it reads as no faster than the lead row (bound 0)
  const lightFinishMs =
    percentile(
      lightFacts.filter((fact) => !fact.moved_up).map((fact) => fact.working_ms),
      0.5,
    ) ?? (movedMs === null ? null : leadMs)
  const timeShare = moveUpTimeBound({ lightFinishMs, movedMs, leadMs })
  const time =
    timeShare === null || lightFinishMs === null || movedMs === null || leadMs === null
      ? null
      : { lightFinishMs, movedMs, leadMs, share: timeShare }
  const bound =
    share === null || lightAttempt === null || leadMean === null || followUpAttempt === null
      ? null
      : {
          lightAttempt,
          leadAttempt: leadMean,
          followUpAttempt,
          share,
          time,
        }
  const priced = async (list: readonly Fact[]) =>
    options.cost ? options.cost(list.map((fact) => fact.issue_id)) : null
  // the lead row's move-up seat: its own attempts, the ones that moved up with their cost and their minutes before the move
  const moveUpIssues = moveUpFacts.map((fact) => fact.issue_id)
  const moveUpAttempts = await attemptsOf(sql, moveUpIssues)
  const moveUpCost = await costOfAttempts(sql, moveUpAttempts, options.usageTimeoutMs)
  const movedUpAttempts = moveUpAttempts.filter((a) => a.move_up && a.moved_after_ms !== null)
  const strongMoved = new Set(
    (await movesOf(sql, moveUpIssues)).filter((move) => stepOf(move) === 'lead').map((move) => move.issue_id),
  )
  const lightMoved = {
    cost: movedDollars === null ? null : movedDollars.reduce((sum, value) => sum + value, 0),
    ms: mean(movedOnes.flatMap((a) => (a.moved_after_ms === null ? [] : [a.moved_after_ms]))),
  }
  return {
    light: deliveryOf(lightFacts, {
      onSeat: onLightSeat,
      movedUp: (fact) => fact.moved_up,
      priced: await priced(lightFacts),
      moved: lightMoved,
    }),
    lead: deliveryOf(leadFacts, {
      onSeat: anySeat,
      movedUp: null,
      priced: await priced(leadFacts),
      moved: { cost: null, ms: null },
    }),
    leadMoveUp: deliveryOf(moveUpFacts, {
      onSeat: (fact) => fact.first_watch_move_up === true,
      movedUp: (fact) => strongMoved.has(fact.issue_id),
      priced: await priced(moveUpFacts),
      moved: {
        cost:
          moveUpCost === null
            ? null
            : movedUpAttempts.reduce((sum, a) => sum + (moveUpCost.get(keyOf(a.issue_id, a.attempt)) ?? 0), 0),
        ms: mean(movedUpAttempts.flatMap((a) => (a.moved_after_ms === null ? [] : [a.moved_after_ms]))),
      },
    }),
    bound,
  }
}

/**
 * The tripwire over its window (`tripwireFrom`: `TRIPWIRE_DAYS`, reaching back until light has `TRIPWIRE_TARGET_WATCHES` finished
 * first watches, at most `TRIPWIRE_MAX_DAYS`): the four figures of each seat, the bound, the gaps and the verdict.
 */
async function tripwireOf(
  sql: SQL,
  options: { now: Date; cost: CostOf; usageTimeoutMs: number },
): Promise<SeatKpis['tripwire']> {
  const longest = await factsOf(sql, windowOf(options.now, TRIPWIRE_MAX_DAYS), options.now)
  const from = tripwireFrom({
    now: options.now,
    watchAts: longest
      .filter((fact) => fact.seat === 'light' && fact.first_watch_light === true && fact.first_watch !== null)
      .map((fact) => fact.started_at),
  })
  const recent = longest.filter((fact) => fact.started_at >= from)
  const { light, lead, bound } = await readDelivery(sql, recent, options)
  const { passGap, ...verdict } = judgeLightGate({ light, lead, bound: bound?.share ?? null })
  const regressions = regressionGap({ light, lead })
  return {
    points: TRIPWIRE_POINTS,
    days: Math.ceil((options.now.getTime() - from.getTime()) / 86_400_000),
    from: from.toISOString(),
    confidence: TRIPWIRE_CONFIDENCE,
    targetWatches: TRIPWIRE_TARGET_WATCHES,
    minWatches: TRIPWIRE_MIN_WATCHES,
    passGap,
    regressionGap: regressions && { perIssue: regressions.gap, lower: regressions.lower },
    light,
    lead,
    bound,
    ...verdict,
  }
}

/**
 * The tripwire over its window (`TRIPWIRE_DAYS`, longer until light has `TRIPWIRE_TARGET_WATCHES` finished first watches), read for the starts: `met` says whether triage's `small` starts on the
 * light seat now (only a measured pass opens it), `bound.share` is the dollar break-even of a move-up.
 */
export async function readTripwire(
  sql: SQL,
  options: { now: Date; cost: CostOf; usageTimeoutMs?: number },
): Promise<SeatKpis['tripwire']> {
  return tripwireOf(sql, { ...options, usageTimeoutMs: options.usageTimeoutMs ?? USAGE_TIMEOUT_MS })
}

/**
 * The seat table of the Improve screen: the window's Issues by the seat their first lead ran on (a filed seat one row per tier
 * and effort), the light seat's four figures beside the lead row's and the move-up seat's, the move-up steps, and the tripwire
 * for triage's `small` (`domains/leads/light.ts`) over the last window above, whatever window the page shows.
 */
export async function readSeatKpis(
  sql: SQL,
  w: Window,
  options: { now: Date; cost: CostOf; usageTimeoutMs?: number },
): Promise<SeatKpis> {
  const usageTimeoutMs = options.usageTimeoutMs ?? USAGE_TIMEOUT_MS
  const facts = await factsOf(sql, w, options.now)
  const rows: SeatKpiRow[] = []
  for (const seat of KPI_SEATS) {
    const inSeat = facts.filter((fact) => fact.seat === seat)
    if (seat !== 'filed') {
      rows.push(await rowOf(seat, inSeat, facts.length, options.cost, NO_PAIR))
      continue
    }
    for (const group of pairsOf(inSeat)) {
      rows.push(await rowOf('filed', group.facts, facts.length, options.cost, group))
    }
  }
  const light = rows.find((row) => row.seat === 'light')
  const { bound: _bound, ...delivery } = await readDelivery(sql, facts, { cost: options.cost, usageTimeoutMs })
  const moves = await movesOf(
    sql,
    facts.map((fact) => fact.issue_id),
  )
  return {
    rows,
    movedUpShare: light ? per(light.movedUp, light.issues) : null,
    steps: { light: stepFiguresOf(moves, 'light'), lead: stepFiguresOf(moves, 'lead') },
    delivery: { ...delivery, definitions: { ...SEAT_DELIVERY_DEFINITIONS } },
    tripwire: await tripwireOf(sql, { now: options.now, cost: options.cost, usageTimeoutMs }),
  }
}

const Claude = z.object({ issue_id: z.string(), attempt: z.coerce.number().int(), claude: z.string() })
const Session = z.object({ id: z.union([z.string(), z.number(), z.bigint()]), claude: z.string() })
const Spend = z.object({ id: z.coerce.string(), cost: z.coerce.number() })

const keyOf = (issue: string, attempt: number): string => `${issue}#${attempt}`

/**
 * Dollars per attempt, by the Claude sessions its hooks reported (with their subagents, `<session>:<agent>`), priced from
 * the `usage` schema another component owns in this database. A session usage tagged with an Issue's number but no hook
 * ever reported belongs to no attempt and is not counted here. Null (never zero) when the schema cannot be read, the role
 * may not read it or a statement ran past the timeout.
 */
async function costOfAttempts(
  sql: SQL,
  attempts: readonly { issue_id: string; attempt: number }[],
  timeoutMs: number,
): Promise<Map<string, number> | null> {
  if (attempts.length === 0) return new Map()
  const wanted = new Set(attempts.map((a) => keyOf(a.issue_id, a.attempt)))
  try {
    return await boundedRead(sql, timeoutMs, async (tx) => {
      const [row] =
        await tx`SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS present`
      if (!z.object({ present: z.boolean() }).parse(row).present) return null
      const issues = [...new Set(attempts.map((a) => a.issue_id))]
      const reported = z.array(Claude).parse(
        await tx`
          SELECT DISTINCT issue_id, attempt, payload->>'claudeSessionId' AS claude FROM factory.lead_hook_events
          WHERE issue_id = ANY(${tx.array(issues, 'TEXT')}) AND payload->>'claudeSessionId' IS NOT NULL`,
      )
      const attemptOf = new Map<string, string>()
      for (const r of reported) {
        const key = keyOf(r.issue_id, r.attempt)
        if (wanted.has(key) && !attemptOf.has(r.claude)) attemptOf.set(r.claude, key)
      }
      const cost = new Map<string, number>([...wanted].map((key) => [key, 0]))
      if (attemptOf.size === 0) return cost
      const sessions = z.array(Session).parse(
        await tx`
          SELECT s.id, split_part(s.source_session_id, ':', 1) AS claude FROM usage.sessions s
          WHERE split_part(s.source_session_id, ':', 1) = ANY(${tx.array([...attemptOf.keys()], 'TEXT')})`,
      )
      if (sessions.length === 0) return cost
      const owner = new Map(sessions.map((s) => [String(s.id), attemptOf.get(s.claude)]))
      const spend = z.array(Spend).parse(
        await tx`
          SELECT r.session_id AS id, sum(r.cost_usd)::float8 AS cost FROM usage.records_unique r
          WHERE r.session_id = ANY(${tx.array(
            sessions.map((s) => s.id),
            'BIGINT',
          )})
          GROUP BY r.session_id`,
      )
      for (const s of spend) {
        const key = owner.get(s.id)
        if (key !== undefined) cost.set(key, (cost.get(key) ?? 0) + s.cost)
      }
      return cost
    })
  } catch {
    return null
  }
}

/** Dollars per Issue over every attempt of it (`costOfAttempts`): null when the usage schema cannot be read. */
export async function costOfIssueAttempts(
  sql: SQL,
  issues: readonly string[],
  timeoutMs = USAGE_TIMEOUT_MS,
): Promise<Map<string, number> | null> {
  const attempts = await attemptsOf(sql, issues)
  const cost = await costOfAttempts(sql, attempts, timeoutMs)
  if (cost === null) return null
  const perIssue = new Map<string, number>(issues.map((issue): [string, number] => [issue, 0]))
  for (const attempt of attempts) {
    const key = keyOf(attempt.issue_id, attempt.attempt)
    perIssue.set(attempt.issue_id, (perIssue.get(attempt.issue_id) ?? 0) + (cost.get(key) ?? 0))
  }
  return perIssue
}
