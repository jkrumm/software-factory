import type { SQL } from 'bun'
import * as z from 'zod'
import { HISTORY_WINDOWS, type Kpi, type KpiModel, type KpiPart, type SpecSource } from '@software-factory/contract'
import { AUTO_RUN_NOTE_PATTERN } from '../kernel/auto-run.ts'
import { boundedRead } from './bounded.ts'
import { MIN_SAMPLES, percentile, per, shareOf, windowOf } from './stats.ts'
import { catalogFields, type CatalogField } from './kpi-fields.ts'
import { specSourceSql } from './spec-screen.ts'
import { QUEUE_GROUPS, hoursByKind, queuedHours } from './queue-time.ts'
import { flowFigures, regressionParts } from './kpis-flow.ts'
import { costBySeat, USAGE_TIMEOUT_MS, type SeatCost } from './usage.ts'

/** The owner's actions on an Issue that the factory should have settled; the events that count are these kinds. */
export const TOUCH_EVENTS = ['noted', 'woken', 'cancelled', 'reopened'] as const

/** The kinds of avoidable touch in words: the parts of `avoidable_touches` and the friction loop's `touch:<kind>` counts. */
export const TOUCH_LABELS: Readonly<Record<string, string>> = {
  decision_answered: 'Decisions the owner answered that were not worth asking',
  noted: 'Notes the owner sent to a lead',
  woken: 'Waits the owner woke by hand',
  cancelled: 'Issues the owner cancelled',
  reopened: 'Issues the owner reopened',
}

/**
 * The owner events that count as touches, of the given kinds. The orchestrator has its own actor, so it is excluded by
 * construction. A `noted` event counts only when it is a note the owner sent with `issue note`
 * (`noted:issue_<n>:owner:<call>`). The `via` guard keeps an old orchestrator client that still sends the owner's token
 * (and `--via orchestrator`) out of the count; it can go once the orchestrator's token is in use everywhere.
 * The first note of a filing, an Errand done and a verdict note are the owner's request or answer, not a touch.
 * `avoidableTouches` and the touch evidence of `readFrictionEvidence` both use this predicate; the count then collapses a burst
 * of one kind within `TOUCH_BURST_MS` into one action, while the evidence lists every Issue touched.
 */
export const ownerTouch = (sql: SQL, kinds: readonly string[]) => sql`
  actor = 'owner' AND result = 'applied' AND kind IN ${sql([...kinds])}
  AND (kind <> 'noted' OR (key ~ '^noted:issue_[0-9]+:owner:' AND payload->>'via' IS DISTINCT FROM 'orchestrator'))`

/**
 * The orchestrator's steering events, of the given kinds: its own actor, and the legacy rows from before it had a token
 * (the owner's actor with `via: orchestrator`, as `issue note` sent them), so history reads continuously. Reported beside
 * the owner's touches, never in them. A `noted` event counts only when sent by `issue note`
 * (`noted:issue_<n>:orchestrator:<call>`), not the first note of a filing.
 */
export const orchestratorSteer = (sql: SQL, kinds: readonly string[]) => sql`
  result = 'applied' AND kind IN ${sql([...kinds])} AND (
    (actor = 'orchestrator' AND (kind <> 'noted' OR key ~ '^noted:issue_[0-9]+:orchestrator:'))
    OR (actor = 'owner' AND payload->>'via' = 'orchestrator'
        AND (kind <> 'noted' OR key ~ '^noted:issue_[0-9]+:owner:'))
  )`

const Count = z.object({ n: z.coerce.number().int() })
const Duration = z.object({ ms: z.coerce.number() })

export interface Window {
  from: Date
  to: Date
}

const one = async (rows: Promise<unknown[]>): Promise<number> => Count.parse((await rows)[0]).n

/**
 * The owner's own verdicts on a Concept, Spec or Report: one the factory gave for him (a wait that ran out, `verdict_given`
 * by actor `factory`), one his delegate gave (`by` orchestrator, until he replaces it) and a withdrawal (`no_longer_applies`) are not his. Shared by the verdict KPI and the retro's taste.
 */
export const ownerVerdict = (sql: SQL, w: Window) => sql`
  v.verdict IN ('looks_good', 'with_notes', 'changes') AND v.at >= ${w.from} AND v.at < ${w.to} AND v.by <> 'orchestrator'
  AND NOT EXISTS (
    SELECT 1 FROM factory.issue_events e
    WHERE e.key = 'verdict_given:' || v.artifact_id || ':' || v.revision AND e.actor = 'factory')`

/**
 * The owner's own verdicts on an ask: a Concept or a Spec (a Report is for information and asks nothing). `v` is the verdict
 * row, `a` its artifact.
 */
export const askVerdict = (sql: SQL, w: Window) => sql`${ownerVerdict(sql, w)} AND a.kind IN ('concept', 'spec')`

/**
 * A verdict that changed nothing: Looks good with no note (a stored `with_notes` reads as Looks good) and no comment of his on
 * that revision. The lead applies a note and every comment, so either one is a word he had to say.
 */
export const verdictChangedNothing = (sql: SQL) => sql`
  v.verdict IN ('looks_good', 'with_notes') AND COALESCE(btrim(v.note), '') = ''
  AND NOT EXISTS (
    SELECT 1 FROM factory.annotations n
    WHERE n.artifact_id = v.artifact_id AND n.revision = v.revision AND n.author = 'owner')`

/** The Decisions the owner himself answered in the window (`d`); the Judge's, a default's and his delegate's answers are not his. */
export const ownerDecision = (sql: SQL, w: Window) =>
  sql`d.settled_by = 'owner' AND d.answered_at >= ${w.from} AND d.answered_at < ${w.to}`

/** A Decision answered with the lead's recommendation and nothing else: an answer is an option or his own words, and his words differ. */
export const decisionChangedNothing = (sql: SQL) => sql`lower(btrim(d.answer)) = lower(btrim(d.recommendation))`

const ASK_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['spec', 'Spec verdicts that changed nothing'],
  ['concept', 'Concept verdicts that changed nothing'],
  ['decision', 'Decision answers that took the recommendation'],
]
const ASK_SOURCES: Record<SpecSource, string> = {
  filer: 'Specs the filer made owed that changed nothing',
  triage: 'Specs triage made owed that changed nothing',
  replan: 'Replan Specs that changed nothing',
  lead: 'Specs a lead judged due that changed nothing',
}

/**
 * The owner's own answers in the window that asked him something (verdicts on a Concept or Spec, Decisions he answered) and
 * how many of them changed nothing: `n` and `count` over all of them, and the same per kind and, for Specs, per who made the
 * Spec owed. Each part is a share of its own group's answers.
 */
async function askAnswers(sql: SQL, w: Window): Promise<{ n: number; count: number; parts: KpiPart[] }> {
  const rows: unknown[] = await sql`
    SELECT 'kind:' || a.kind AS key, count(*) AS n, count(*) FILTER (WHERE ${verdictChangedNothing(sql)}) AS nothing
    FROM factory.verdicts v JOIN factory.artifacts a ON a.id = v.artifact_id
    WHERE ${askVerdict(sql, w)} GROUP BY a.kind
    UNION ALL
    SELECT 'source:' || ${specSourceSql(sql)}, count(*), count(*) FILTER (WHERE ${verdictChangedNothing(sql)})
    FROM factory.verdicts v JOIN factory.artifacts a ON a.id = v.artifact_id AND a.kind = 'spec'
    LEFT JOIN factory.spec_screens s ON s.artifact_id = v.artifact_id AND s.revision = v.revision
    WHERE ${ownerVerdict(sql, w)} GROUP BY 1
    UNION ALL
    SELECT 'kind:decision', count(*), count(*) FILTER (WHERE ${decisionChangedNothing(sql)})
    FROM factory.decisions d WHERE ${ownerDecision(sql, w)}`
  const found = new Map(
    rows.map((raw) => {
      const row = z.object({ key: z.string(), n: z.coerce.number().int(), nothing: z.coerce.number().int() }).parse(raw)
      return [row.key, row] as const
    }),
  )
  const part = (key: string, label: string): KpiPart[] => {
    const row = found.get(key)
    return row && row.n > 0 ? [{ key, label, value: row.nothing / row.n, unit: 'share' }] : []
  }
  const kinds = ASK_KINDS.map(([kind]) => found.get(`kind:${kind}`))
  return {
    n: kinds.reduce((sum, row) => sum + (row?.n ?? 0), 0),
    count: kinds.reduce((sum, row) => sum + (row?.nothing ?? 0), 0),
    parts: [
      ...ASK_KINDS.flatMap(([kind, label]) => part(`kind:${kind}`, label)),
      ...Object.entries(ASK_SOURCES).flatMap(([source, label]) => part(`source:${source}`, label)),
    ],
  }
}

/**
 * Errands that reached the owner in the window, by what they need. One that reached him before `need` was stored counts under
 * none of the four (the total still has it).
 */
async function errandsReached(sql: SQL, w: Window) {
  const [row] = await sql`
    SELECT count(*) AS n,
      count(*) FILTER (WHERE need = 'secret') AS secret, count(*) FILTER (WHERE need = 'hands') AS hands,
      count(*) FILTER (WHERE need = 'place') AS place, count(*) FILTER (WHERE need = 'approval') AS approval
    FROM factory.errands WHERE reached_owner_at >= ${w.from} AND reached_owner_at < ${w.to}`
  return z
    .object({
      n: z.coerce.number().int(),
      secret: z.coerce.number().int(),
      hands: z.coerce.number().int(),
      place: z.coerce.number().int(),
      approval: z.coerce.number().int(),
    })
    .parse(row)
}

/**
 * Errands and requests a rule refused at the raise in the window (`errand_refusals`: nothing else of them is stored), and
 * those raised (the rows of `errands`): the share the rules turn away before the owner or an Issue waits on it.
 */
async function errandRaises(sql: SQL, w: Window) {
  const [row] = await sql`
    SELECT
      (SELECT count(*) FROM factory.errand_refusals WHERE at >= ${w.from} AND at < ${w.to}) AS refused,
      (SELECT count(*) FROM factory.errands WHERE raised_at >= ${w.from} AND raised_at < ${w.to}) AS raised`
  return z.object({ refused: z.coerce.number().int(), raised: z.coerce.number().int() }).parse(row)
}

/**
 * The Errands that reached the owner in the window or that his MacBook ran by itself in it, and how many of those ran by
 * themselves. An `ask-human` request is pushed at once and can close before the screen has reached it, so the run is counted
 * by its close and not only by a reach.
 */
async function errandsAutoRun(sql: SQL, w: Window) {
  const [row] = await sql`
    SELECT count(*) AS n, count(*) FILTER (WHERE auto) AS auto FROM (
      SELECT closed_by = 'orchestrator' AND done_note ~ ${AUTO_RUN_NOTE_PATTERN} AND done_at >= ${w.from} AND done_at < ${w.to} AS auto,
        reached_owner_at >= ${w.from} AND reached_owner_at < ${w.to} AS reached
      FROM factory.errands) e
    WHERE auto OR reached`
  return z.object({ n: z.coerce.number().int(), auto: z.coerce.number().int() }).parse(row)
}

/** Issues filed in the window: what every per-Issue figure divides by. */
export const issuesFiled = (sql: SQL, w: Window): Promise<number> =>
  one(
    sql`SELECT count(*) AS n FROM factory.issue_events WHERE kind = 'filed' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}`,
  )

/**
 * Issues filed in the window that no loop of the factory filed: what a person, an agent or an alert asked for. A loop files
 * through intake with a finding, so its Issue's intake subject is a finding key (`finding:`, the `FINDING_PREFIX` of intake's rules, which a test holds equal): the
 * friction patterns and the weekly retro, hygiene, selfwatch and throughput alike; `loop_findings` holds the rows the ledger
 * imported from before. The owner-touch rate divides by these, so a week the loops file hundreds of hygiene Issues does not
 * make the owner's touches look rarer.
 */
const issuesFiledOutsideLoops = (sql: SQL, w: Window): Promise<number> =>
  one(sql`
    SELECT count(*) AS n FROM factory.issue_events e
    WHERE e.kind = 'filed' AND e.result = 'applied' AND e.at >= ${w.from} AND e.at < ${w.to}
      AND NOT EXISTS (SELECT 1 FROM factory.loop_findings lf WHERE lf.issue_id = e.issue_id)
      AND NOT EXISTS (SELECT 1 FROM factory.intake_subjects s WHERE s.issue_id = e.issue_id AND s.subject LIKE 'finding:%')`)

/** Owner touches of one kind this close together are one action: a person sending the same steer to a dozen Issues, or an owner script cancelling a re-planned batch. */
const TOUCH_BURST_MS = 60_000

/**
 * Avoidable touches by kind: an owner action on an Issue the factory should have settled. A Decision the owner answered and
 * did not mark worth asking, an owner note sent to a lead, an owner wake, a cancel, a reopen. Not the first note of a
 * filing, not the orchestrator steering a lead, not a verdict on a Concept or Spec and not an Errand done: the owner
 * wanted those. Touches of one kind within `TOUCH_BURST_MS` of the one before count once (one action fanned across Issues).
 */
export async function avoidableTouches(sql: SQL, w: Window): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    decision_answered: await one(sql`
      SELECT count(*) AS n FROM factory.decisions
      WHERE settled_by = 'owner' AND worth_asking IS NOT TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}`),
  }
  for (const kind of TOUCH_EVENTS) counts[kind] = 0
  const events: unknown[] = await sql`
    WITH t AS (
      SELECT kind, at, lag(at) OVER (PARTITION BY kind ORDER BY at) AS prev FROM factory.issue_events
      WHERE ${ownerTouch(sql, TOUCH_EVENTS)} AND at >= ${w.from} AND at < ${w.to})
    SELECT kind, count(*) FILTER (WHERE prev IS NULL OR at - prev > ${TOUCH_BURST_MS / 1000}::int * interval '1 second') AS n
    FROM t GROUP BY kind`
  for (const raw of events) {
    const row = z.object({ kind: z.string() }).and(Count).parse(raw)
    counts[row.kind] = row.n
  }
  return counts
}

/**
 * The orchestrator's steering by kind (the touch kinds plus `decision_answered` for a Decision it answered and the owner
 * did not mark worth asking). Not part of `avoidableTouches`: the owner-touch figures read the owner alone.
 */
export async function orchestratorSteering(sql: SQL, w: Window): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    decision_answered: await one(sql`
      SELECT count(*) AS n FROM factory.decisions
      WHERE settled_by = 'orchestrator' AND worth_asking IS NOT TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}`),
  }
  for (const kind of TOUCH_EVENTS) counts[kind] = 0
  const events: unknown[] = await sql`
    SELECT kind, count(*) AS n FROM factory.issue_events
    WHERE ${orchestratorSteer(sql, TOUCH_EVENTS)} AND at >= ${w.from} AND at < ${w.to}
    GROUP BY kind`
  for (const raw of events) {
    const row = z.object({ kind: z.string() }).and(Count).parse(raw)
    counts[row.kind] = row.n
  }
  return counts
}

const durations = async (rows: Promise<unknown[]>): Promise<number[]> =>
  (await rows).map((raw) => Duration.parse(raw).ms)

/** Filed to closed, for each Issue that closed in the window. */
const cycleTimes = (sql: SQL, w: Window) =>
  durations(sql`
    SELECT extract(epoch FROM (c.at - f.at)) * 1000 AS ms
    FROM factory.issue_events c
    JOIN factory.issue_events f ON f.issue_id = c.issue_id AND f.kind = 'filed' AND f.version = 1
    WHERE c.result = 'applied' AND c.to_state = 'closed' AND c.at >= ${w.from} AND c.at < ${w.to}`)

/** Filed or reopened to admitted, for each admission in the window. */
const queueWaits = (sql: SQL, w: Window) =>
  durations(sql`
    SELECT extract(epoch FROM (a.at - s.at)) * 1000 AS ms
    FROM factory.issue_events a
    JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = a.issue_id AND x.result = 'applied' AND x.kind IN ('filed', 'reopened') AND x.version < a.version
      ORDER BY x.version DESC LIMIT 1
    ) s ON true
    WHERE a.kind = 'admitted' AND a.result = 'applied' AND a.at >= ${w.from} AND a.at < ${w.to}`)

/** `session_window_share` aggregates every quota interval whatever the filter, so a computed figure is reused this long. */
const POINTS_TTL_MS = 15 * 60_000

export interface PointsCache {
  get(key: string, now: Date): number | undefined
  set(key: string, points: number, now: Date): void
}

/** An in-memory cache of window points by session set; entries expire `POINTS_TTL_MS` after they were computed. */
export function pointsCache(): PointsCache {
  const entries = new Map<string, { points: number; at: number }>()
  return {
    get: (key, now) => {
      const hit = entries.get(key)
      if (hit && now.getTime() - hit.at < POINTS_TTL_MS && now.getTime() >= hit.at) return hit.points
      entries.delete(key)
      return undefined
    },
    set: (key, points, now) => void entries.set(key, { points, at: now.getTime() }),
  }
}

const sharedPoints = pointsCache()

const Ids = z.array(z.object({ id: z.union([z.string(), z.number(), z.bigint()]) }))
const Texts = z.array(z.object({ v: z.string() }))

/**
 * The usage sessions of the Issues filed in the window. A session is an Issue's when usage tagged it with the Issue's
 * number, or when it is (or is a subagent of) a Claude session a lead of the Issue reported in its hook events
 * (`claudeSessionId`). Both sides are looked up from lists, never joined row by row: an OR join with a correlated subselect
 * could use no index and ran past 100 s on the shared database.
 */
async function sessionsOf(tx: SQL, w: Window): Promise<Array<string | number | bigint>> {
  const filed = Texts.parse(
    await tx`
      SELECT DISTINCT issue_id AS v FROM factory.issue_events
      WHERE kind = 'filed' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}`,
  ).map((r) => r.v)
  return sessionsOfIssues(tx, filed)
}

/** The usage sessions of these Issues, by the same two lookups as `sessionsOf`. */
async function sessionsOfIssues(tx: SQL, filed: readonly string[]): Promise<Array<string | number | bigint>> {
  if (filed.length === 0) return []
  const numbers = filed.map((id) => id.slice('issue_'.length))
  const claude = Texts.parse(
    await tx`
      SELECT DISTINCT payload->>'claudeSessionId' AS v FROM factory.lead_hook_events
      WHERE issue_id = ANY(${tx.array([...filed], 'TEXT')}) AND payload->>'claudeSessionId' IS NOT NULL`,
  ).map((r) => r.v)
  const byNumber = Ids.parse(
    await tx`SELECT s.id FROM usage.sessions s WHERE s.issue_id = ANY(${tx.array(numbers, 'TEXT')})`,
  )
  const byClaude =
    claude.length === 0
      ? []
      : Ids.parse(
          await tx`
            SELECT s.id FROM usage.sessions s
            WHERE split_part(s.source_session_id, ':', 1) = ANY(${tx.array(claude, 'TEXT')})`,
        )
  const unique = new Map<string, string | number | bigint>()
  for (const row of [...byNumber, ...byClaude]) unique.set(String(row.id), row.id)
  return [...unique.values()]
}

/**
 * Cost and window points of the Issues filed in the window, joined from the `usage` schema, which another component owns
 * in this database. The five-hour window's points come from `usage.session_window_share`. Each figure is its own bounded
 * transaction: a statement past the timeout, a missing schema, table or column, or a role that may not read the schema
 * leaves that figure null (unmeasured) and holds no connection. The points are reused for a few minutes, because the view
 * costs seconds for any filter.
 */
interface Usage {
  cost: number | null
  points: number | null
  /** why a figure is null; null when both were read */
  reason: string | null
}

async function usageOf(
  sql: SQL,
  w: Window,
  options: { now: Date; timeoutMs: number; cache: PointsCache },
): Promise<Usage> {
  let sessions: Array<string | number | bigint>
  let cost: number
  let shares: boolean
  try {
    const found = await boundedRead(sql, options.timeoutMs, async (tx) => {
      // inside the try: `to_regclass` raises "permission denied for schema usage" when the factory's role has no USAGE on it
      const [row] = await tx`
        SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS records,
          to_regclass('usage.session_window_share') IS NOT NULL AS shares`
      const present = z.object({ records: z.boolean(), shares: z.boolean() }).parse(row)
      if (!present.records) return null
      const ids = await sessionsOf(tx, w)
      if (ids.length === 0) return { ids, cost: 0, shares: present.shares }
      const [sum] = await tx`
        SELECT coalesce(sum(r.cost_usd), 0)::float8 AS cost FROM usage.records_unique r
        WHERE r.session_id = ANY(${tx.array(ids, 'BIGINT')})`
      return { ids, cost: z.object({ cost: z.coerce.number() }).parse(sum).cost, shares: present.shares }
    })
    if (!found) return { cost: null, points: null, reason: 'The usage schema is not in this database' }
    ;({ ids: sessions, cost, shares } = found)
  } catch {
    return {
      cost: null,
      points: null,
      reason: 'The usage schema could not be read: no access, or the read timed out',
    }
  }
  if (!shares) {
    return { cost, points: null, reason: 'The usage view session_window_share is not in this database' }
  }
  if (sessions.length === 0) {
    return { cost: null, points: null, reason: 'No usage session is linked to an Issue filed in the window' }
  }

  const key = String(Bun.hash(sessions.map(String).sort().join(',')))
  const cached = options.cache.get(key, options.now)
  if (cached !== undefined) return { cost, points: cached, reason: null }
  try {
    const points = await boundedRead(sql, options.timeoutMs, async (tx) => {
      const [sum] = await tx`
        SELECT coalesce(sum(m.five_hour_pct), 0)::float8 AS points FROM usage.session_window_share m
        WHERE m.session_id = ANY(${tx.array(sessions, 'BIGINT')})`
      return z.object({ points: z.coerce.number() }).parse(sum).points
    })
    options.cache.set(key, points, options.now)
    return { cost, points, reason: null }
  } catch {
    return { cost, points: null, reason: 'The window points read timed out' }
  }
}

/**
 * Dollars the usage schema priced for these Issues' sessions, in one bounded transaction; null when the schema is not
 * there, the role may not read it or the read ran past the timeout (unmeasured, never a zero).
 */
export async function costOfIssues(sql: SQL, issues: readonly string[], timeoutMs = USAGE_TIMEOUT_MS) {
  if (issues.length === 0) return 0
  try {
    return await boundedRead(sql, timeoutMs, async (tx) => {
      const [row] =
        await tx`SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS present`
      if (!z.object({ present: z.boolean() }).parse(row).present) return null
      const ids = await sessionsOfIssues(tx, [...issues])
      if (ids.length === 0) return 0
      const [sum] = await tx`
        SELECT coalesce(sum(r.cost_usd), 0)::float8 AS cost FROM usage.records_unique r
        WHERE r.session_id = ANY(${tx.array(ids, 'BIGINT')})`
      return z.object({ cost: z.coerce.number() }).parse(sum).cost
    })
  } catch {
    return null
  }
}

/**
 * The reviewer-agent dollars (the usage side's tool `reviewer`) of these Issues' sessions, split by the seat that ran
 * them: the haiku tier is the cheap seat, any other the rest. Null when the usage schema cannot be read.
 */
export async function reviewerCostOfIssues(
  sql: SQL,
  issues: readonly string[],
  timeoutMs = USAGE_TIMEOUT_MS,
): Promise<{ cheap: number; plain: number } | null> {
  if (issues.length === 0) return { cheap: 0, plain: 0 }
  try {
    const sessions = await boundedRead(sql, timeoutMs, async (tx) => {
      const [row] =
        await tx`SELECT to_regclass('usage.sessions') IS NOT NULL AND to_regclass('usage.records_unique') IS NOT NULL AS present`
      return z.object({ present: z.boolean() }).parse(row).present ? await sessionsOfIssues(tx, [...issues]) : null
    })
    if (sessions === null) return null
    const seats = await costBySeat(sql, { sessions, timeoutMs })
    const reviewer = seats.filter((seat) => seat.tool === 'reviewer')
    const sum = (rows: SeatCost[]) => rows.reduce((total, seat) => total + seat.cost, 0)
    return {
      cheap: sum(reviewer.filter((seat) => seat.model.includes('haiku'))),
      plain: sum(reviewer.filter((seat) => !seat.model.includes('haiku'))),
    }
  } catch {
    return null
  }
}

type Figure = Omit<Kpi, CatalogField | 'history' | 'parts' | 'beside' | 'reason'> & {
  parts?: KpiPart[]
  beside?: KpiPart[]
  reason?: string
}

const kpi = (k: Figure): Omit<Kpi, 'history'> => ({
  ...k,
  ...catalogFields(k.key),
  parts: k.parts ?? [],
  beside: k.beside ?? [],
  reason: k.reason ?? null,
})

/** A figure as a part, or nothing when it has no number: a part is never a null. */
const partOf = (key: string, label: string, value: number | null, unit: KpiPart['unit']): KpiPart[] =>
  value === null || !Number.isFinite(value) ? [] : [{ key, label, value, unit }]

/** The units a KPI under `MIN_SAMPLES` has no figure in (`measured` false, the reason says how many it had); a rate per Issue stands on its Issues and has no floor beyond one. */
const FLOORED_UNITS: ReadonlySet<Kpi['unit']> = new Set(['share', 'ms'])

/**
 * A KPI with no figure says so and why, never a zero: nothing counted at all (a ratio over an empty denominator), or
 * fewer samples than the floor. A KPI the source did not measure already carries its own reason.
 */
function withReason(k: Omit<Kpi, 'history'>): Omit<Kpi, 'history'> {
  if (!k.measured) return { ...k, value: null, reason: k.reason ?? 'The factory has no data for this figure yet' }
  // a count that is zero is a result; every other figure over nothing has no value
  if (k.value === null || (k.n === 0 && k.unit !== 'count'))
    return { ...k, value: null, measured: false, reason: 'Nothing was counted in the window' }
  if (FLOORED_UNITS.has(k.unit) && k.n < MIN_SAMPLES)
    return {
      ...k,
      value: null,
      measured: false,
      reason: `Only ${k.n} counted in the window; at least ${MIN_SAMPLES} are needed for a figure`,
    }
  return k
}

/**
 * Queued time that fell in the window, in ms, by the group of its reason. The groups are the owner's four (capacity, an
 * after edge, a draining queue, production red); everything else (a Spec at the owner, another Issue finalizing, no reason
 * recorded) is `other`. Empty when nothing was queued.
 */
async function queueWaitParts(sql: SQL, w: Window): Promise<Kpi['parts']> {
  const byKind = hoursByKind(await queuedHours(sql, w))
  const grouped = new Set(QUEUE_GROUPS.flatMap(([, , kinds]) => kinds))
  const other = [...byKind].filter(([kind]) => !grouped.has(kind)).reduce((sum, [, hours]) => sum + hours, 0)
  return [
    ...QUEUE_GROUPS.map(([key, label, kinds]) => ({
      key,
      label,
      value: kinds.reduce((sum, kind) => sum + (byKind.get(kind) ?? 0), 0) * 3_600_000,
      unit: 'ms' as const,
    })),
    { key: 'other', label: 'Other', value: other * 3_600_000, unit: 'ms' as const },
  ]
    .filter((part) => part.value > 0)
    .toSorted((a, b) => b.value - a.value)
}

/**
 * Quota used at reset: the share of its weekly quota each account had used when its window reset, weighted by capacity, from the
 * reset ledger the accounts package keeps. A share of the quota (0 to 1), counted over the resets in the window; a window with
 * none, or a ledger this process cannot read, has no figure.
 */
function quotaAtReset(
  read: QuotaAtResetReader | undefined,
  w: Window,
): { value: number | null; resets: number; reason?: string } {
  try {
    if (!read) return { value: null, resets: 0, reason: 'The accounts’ reset ledger is not read in this process' }
    const found = read({ from: w.from, to: w.to })
    return { value: found?.percent == null ? null : found.percent / 100, resets: found?.resets ?? 0 }
  } catch (error) {
    return {
      value: null,
      resets: 0,
      reason: `The accounts’ reset ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** What the reset ledger of the accounts says of a span: the capacity-weighted mean weekly percent at reset, and how many resets stand under it. */
export type QuotaAtResetReader = (span: { from: Date; to: Date }) => { percent: number | null; resets: number } | null

type KpiOptions = { now: Date; usageTimeoutMs?: number; pointsCache?: PointsCache; quotaAtReset?: QuotaAtResetReader }

/**
 * The seven KPIs of one window. `detail` reads their parts and the figures beside them, and the usage schema behind the cost
 * figures: only the current window shows those, so the history windows read the headlines alone.
 */
async function kpisOf(
  sql: SQL,
  w: Window,
  options: KpiOptions,
  { detail, usage }: { detail: boolean; usage: boolean },
): Promise<Array<Omit<Kpi, 'history'>>> {
  const filed = await issuesFiledOutsideLoops(sql, w)
  const touches = await avoidableTouches(sql, w)
  const touchCount = Object.values(touches).reduce((a, b) => a + b, 0)
  const reached = await errandsReached(sql, w)
  const asks = await askAnswers(sql, w)
  const firstWatches = await one(sql`
    SELECT count(*) AS n FROM factory.quality_watches WHERE watch = 1 AND answer IN ('passed', 'regressed') AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const firstPassed = await one(sql`
    SELECT count(*) AS n FROM factory.quality_watches WHERE watch = 1 AND answer = 'passed' AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const cycles = await cycleTimes(sql, w)
  const waits = await queueWaits(sql, w)
  const quota = quotaAtReset(options.quotaAtReset, w)
  // every Issue filed, loops' included: the Errand and Spec rates and the cost figures divide by these
  const issues = await issuesFiled(sql, w)

  const side = detail ? await detailOf(sql, w, { ...options, usage }, { issues, filed, touches, reached }) : null

  const figures = [
    kpi({
      key: 'avoidable_touches',
      value: per(touchCount, filed),
      unit: 'per_issue',
      n: filed,
      count: touchCount,
      measured: true,
      definition:
        'Owner actions in the window on an Issue the factory should have settled, divided by the Issues filed in the window that no loop of the factory filed (a person, an agent or an alert asked for them; the friction, hygiene, selfwatch and throughput loops’ Issues are left out): a Decision the owner answered and did not mark worth asking, an owner note, an owner wake, a cancel, a reopen. The first note of a filing, anything the orchestrator did (its own friction line), a verdict on a Concept or Spec and a done Errand are not counted: those are the request or the owner wanted them. Touches of one kind within a minute of the one before count once: one steer sent to a dozen Issues, or one re-planned batch cancelled, is one action. A touch on an Issue a loop filed counts too: the factory filed work the owner had to step into. The parts are the touches by kind, per Issue; the count is beside the rate.',
      parts: side?.touchParts ?? [],
      beside: side?.touchBeside ?? [],
    }),
    kpi({
      key: 'first_verification_passes',
      value: per(firstPassed, firstWatches),
      unit: 'share',
      n: firstWatches,
      count: firstPassed,
      measured: true,
      definition:
        "Of the first watches (the window after an Issue's first ship) that ended in the window as passed or regressed, the share that passed. A watch that ended because its Issue moved on is not counted. A pass is as strong as its watch: the first watch's median dwell is beside it. The parts are the shares of first watches that regressed, by what failed in the last run: the CI, the project's verify, a deployed version that lacks the landed commit, a missing version probe, the checkout, another check (the first of these in that order names a regression that failed several).",
      parts: side?.regressions ?? [],
      beside: side?.flow.passBeside ?? [],
    }),
    kpi({
      key: 'asks_not_needed',
      value: per(asks.count, asks.n),
      unit: 'share',
      n: asks.n,
      count: asks.count,
      measured: true,
      definition:
        "Of the owner's own answers in the window to what the factory asked of him (a verdict on a Concept or a Spec, a Decision he answered; the factory's defaults and his delegate's answers are not his), the share that changed nothing: a verdict of Looks good with no note and no comment of his on that revision, or a Decision answered with the lead's recommendation and nothing else. It reads his answer, never a mark he sets afterwards. The parts are that share by kind of ask and, for Specs, by who made the Spec owed (the filer, triage, a Replan, the lead). Beside it: the Specs per 100 Issues (near zero for weeks means the Spec path is silent) and the share of his verdicts that asked for notes or changes.",
      parts: asks.parts,
      beside: side?.specBeside ?? [],
    }),
    kpi({
      key: 'errands_reached_per_100',
      value: issues === 0 ? null : (reached.n / issues) * 100,
      unit: 'per_100_issues',
      n: issues,
      count: reached.n,
      measured: true,
      definition:
        "Errands, an Issue's and a request's, that the screen let through to the owner in the window (the rules of their shape, the fixed MacBook verbs and the screen model keep the rest away from him), per 100 Issues filed in the window. The parts are the share of those that needs a secret (1Password, a biometric, a password), hands (a device, a portal, a physical step), a place on his MacBook or only his yes on the mini. Beside it: the share that needed neither a secret nor hands, the share his MacBook ran by itself, the share of raised Errands the screen turned away, and the share of Errands and requests a rule refused when they were raised.",
      parts: side?.errandParts ?? [],
      beside: side?.errandBeside ?? [],
    }),
    kpi({
      key: 'cycle_p50',
      value: percentile(cycles, 0.5),
      unit: 'ms',
      n: cycles.length,
      count: null,
      measured: true,
      definition:
        'The median time from filed to closed of the Issues that closed in the window. The parts are the time Issues spent in each state and wait reason, for the intervals that ended in the window; beside it, the share of working and waiting spent working and the share of Issues closed dropped or cancelled after a lead started.',
      parts: side?.flow.cycleParts ?? [],
      beside: side?.flow.cycleBeside ?? [],
    }),
    kpi({
      key: 'queue_wait_p90',
      value: percentile(waits, 0.9),
      unit: 'ms',
      n: waits.length,
      count: null,
      measured: true,
      definition:
        'The 90th percentile of the time from filed or reopened to admitted (a lead started), over the admissions in the window; settling and the chain are part of the wait. The parts are the queued time of the window by what held it: capacity (a seat, a cap, an account window, memory, load), an after edge, a draining queue, production red (a fix is queued and only fixes are admitted), and the rest. Beside it: the share of queued hours in which an account had room.',
      parts: side?.queueParts ?? [],
      beside: side?.flow.queueBeside ?? [],
    }),
    kpi({
      key: 'quota_at_reset',
      value: quota.value,
      unit: 'share',
      n: quota.resets,
      count: quota.resets,
      measured: quota.value !== null,
      ...(quota.value === null && quota.reason ? { reason: quota.reason } : {}),
      definition:
        'The weekly percent each account stood at when its weekly window reset, weighted by the account’s weekly capacity, over the resets in the window (the reset ledger of packages/accounts, read in the server’s process). Higher means less quota went unused. Beside it: the points of the five-hour window and the dollars the sessions of the Issues filed in the window used, per Issue (from the usage schema; absent while it cannot be read).',
      beside: side?.quotaBeside ?? [],
    }),
  ]
  return figures.map(withReason)
}

/** The parts and the beside-figures of the current window. */
async function detailOf(
  sql: SQL,
  w: Window,
  options: KpiOptions & { usage: boolean },
  head: {
    issues: number
    filed: number
    touches: Record<string, number>
    reached: Awaited<ReturnType<typeof errandsReached>>
  },
) {
  const { issues, filed, touches, reached } = head
  const asked = await one(sql`
    SELECT count(*) AS n FROM factory.decisions
    WHERE asked_at >= ${w.from} AND asked_at < ${w.to}
      AND (settled_by IN ('owner', 'orchestrator') OR (answered_at IS NULL AND withdrawn_at IS NULL))`)
  const byOwner = await one(sql`
    SELECT count(*) AS n FROM factory.decisions WHERE settled_by = 'owner' AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const recommended = await one(sql`
    SELECT count(*) AS n FROM factory.decisions
    WHERE settled_by = 'owner' AND lower(trim(answer)) = lower(trim(recommendation))
      AND answered_at >= ${w.from} AND answered_at < ${w.to}`)
  const verdicts = await one(sql`SELECT count(*) AS n FROM factory.verdicts v WHERE ${ownerVerdict(sql, w)}`)
  const verdictsChanged = await one(
    sql`SELECT count(*) AS n FROM factory.verdicts v WHERE ${ownerVerdict(sql, w)} AND (v.verdict IN ('with_notes', 'changes') OR (v.verdict = 'looks_good' AND v.note IS NOT NULL))`,
  )
  const specs = await one(sql`
    SELECT count(*) AS n FROM factory.artifacts WHERE kind = 'spec' AND created_at >= ${w.from} AND created_at < ${w.to}`)
  const autoRun = await errandsAutoRun(sql, w)
  const raises = await errandRaises(sql, w)
  const usage = options.usage
    ? await usageOf(sql, w, {
        now: options.now,
        timeoutMs: options.usageTimeoutMs ?? USAGE_TIMEOUT_MS,
        cache: options.pointsCache ?? sharedPoints,
      })
    : { cost: null, points: null }
  const flow = await flowFigures(sql, w)

  return {
    flow,
    regressions: await regressionParts(sql, w),
    queueParts: await queueWaitParts(sql, w),
    touchParts:
      filed === 0
        ? []
        : Object.entries(touches)
            .filter(([, count]) => count > 0)
            .toSorted((a, b) => b[1] - a[1])
            .map(([kind, count]): KpiPart => ({
              key: `touch:${kind}`,
              label: TOUCH_LABELS[kind] ?? kind,
              value: count / filed,
              unit: 'per_issue',
            })),
    // the keys of the figures beside a KPI are the keys they had as KPIs of their own: a retro marker naming one still reads it
    touchBeside: [
      ...partOf('loop_filed', 'Issues the factory’s own loops filed (not in the rate)', issues - filed, 'count'),
      ...partOf('asks', 'Decisions the factory did not settle, per Issue filed', per(asked, issues), 'per_issue'),
      ...partOf(
        'owner_decisions_per_100',
        'Decisions the owner answered, per 100 Issues filed',
        issues === 0 ? null : (byOwner / issues) * 100,
        'per_100_issues',
      ),
      ...partOf(
        'recommendation_taken',
        'Owner answers that took the recommendation',
        shareOf(recommended, byOwner),
        'share',
      ),
    ],
    specBeside: [
      ...partOf(
        'specs_per_100',
        'Specs per 100 Issues filed',
        issues === 0 ? null : (specs / issues) * 100,
        'per_100_issues',
      ),
      ...partOf(
        'verdict_changes_share',
        'Owner verdicts with notes or changes',
        shareOf(verdictsChanged, verdicts),
        'share',
      ),
    ],
    errandParts:
      reached.n === 0
        ? []
        : [
            {
              key: 'secret',
              label: 'Needing a secret or a password',
              value: reached.secret / reached.n,
              unit: 'share' as const,
            },
            { key: 'hands', label: 'Needing hands', value: reached.hands / reached.n, unit: 'share' as const },
            {
              key: 'place',
              label: 'Needing a place on his MacBook',
              value: reached.place / reached.n,
              unit: 'share' as const,
            },
            {
              key: 'approval',
              label: 'Needing only his yes',
              value: reached.approval / reached.n,
              unit: 'share' as const,
            },
          ].toSorted((a, b) => b.value - a.value),
    errandBeside: [
      ...partOf(
        'errands_no_secret_no_hands',
        'Reached him needing neither a secret nor hands',
        shareOf(reached.place + reached.approval, reached.n),
        'share',
      ),
      ...partOf('errands_auto_run_share', 'Run by his MacBook by itself', shareOf(autoRun.auto, autoRun.n), 'share'),
      ...partOf(
        'errands_refused_by_rule_share',
        'Refused by a rule when raised, of those asked for',
        shareOf(raises.refused, raises.refused + raises.raised),
        'share',
      ),
      ...flow.errandsBeside,
    ],
    quotaBeside: [
      ...partOf(
        'window_points',
        'Five-hour window points per Issue filed',
        usage.points === null ? null : per(usage.points, issues),
        'points',
      ),
      ...partOf('cost', 'Dollars per Issue filed', usage.cost === null ? null : per(usage.cost, issues), 'usd'),
    ],
  }
}

/**
 * Windows read at once. A window holds one pool connection at a time (a usage read takes its own transaction, after the
 * plain reads), and the shared pool has 8, so 3 leaves the rest for other requests.
 */
const WINDOW_CONCURRENCY = 3

/** `fn` over `items` with at most `limit` running at once; results in item order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * The windows behind a KPI read: `HISTORY_WINDOWS` of `days` days, oldest first, the last ending now. None ends before the
 * counting epoch, and the one it falls into starts at it: a figure from before the factory counted is not history.
 */
function kpiWindows(now: Date, days: number, epoch: Date | null): Window[] {
  const step = days * 24 * 3_600_000
  const all = Array.from({ length: HISTORY_WINDOWS }, (_, i) =>
    windowOf(new Date(now.getTime() - (HISTORY_WINDOWS - 1 - i) * step), days),
  )
  if (epoch === null) return all
  const kept = all
    .filter((w) => w.to.getTime() > epoch.getTime())
    .map((w) => (w.from.getTime() < epoch.getTime() ? { from: epoch, to: w.to } : w))
  // an epoch in the future (a clock that is off) cuts nothing it cannot: the current window stays
  return kept.length > 0 ? kept : all.slice(-1)
}

/**
 * The seven KPIs over the last `days` days from the event log and the checkpoint tables, with each one's history over the windows
 * of `days` days before it since the counting epoch (`kpiWindows`). Only the current window reads the parts and the figures
 * beside a KPI.
 */
export async function readKpis(
  sql: SQL,
  options: {
    now: Date
    days: number
    /** the counting epoch: no window reaches back before it; absent or null, six windows */
    epoch?: Date | null
    usageTimeoutMs?: number
    pointsCache?: PointsCache
    /** the accounts' reset ledger (`packages/accounts`); absent or null, `quota_at_reset` has no figure */
    quotaAtReset?: QuotaAtResetReader
  },
): Promise<KpiModel> {
  const epoch = options.epoch ?? null
  const windows = kpiWindows(options.now, options.days, epoch)
  const lists = await mapBounded(windows, WINDOW_CONCURRENCY, (w, i) =>
    kpisOf(sql, w, options, { detail: i === windows.length - 1, usage: i === windows.length - 1 }),
  )
  const current = lists.at(-1) ?? []
  const kpis: Kpi[] = current.map((k) => ({
    ...k,
    history: lists.map((list) => {
      const point = list.find((x) => x.key === k.key)
      return { value: point?.value ?? null, n: point?.n ?? 0 }
    }),
  }))
  const last = windows.at(-1) ?? windowOf(options.now, options.days)
  const first = windows[0] ?? last
  return {
    at: options.now.toISOString(),
    days: options.days,
    window: { from: last.from.toISOString(), to: last.to.toISOString() },
    windows: windows.map((w) => ({ from: w.from.toISOString(), to: w.to.toISOString() })),
    since: epoch !== null && first.from.getTime() === epoch.getTime() ? epoch.toISOString() : null,
    kpis,
  }
}

/**
 * The seven KPIs of one window with their parts and no history, the usage schema not read: what the friction pass judges
 * against the targets.
 */
export const kpisOfWindow = (sql: SQL, w: Window, options: KpiOptions): Promise<Array<Omit<Kpi, 'history'>>> =>
  kpisOf(sql, w, options, { detail: true, usage: false })
