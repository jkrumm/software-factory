import type { SQL } from 'bun'
import * as z from 'zod'
import type { WaitCensusModel } from '@software-factory/contract'
import type { WaitReason } from '../domains/work/issue.ts'
import { issueNumberOf } from './sessions.ts'
import { percentile, windowOf } from './stats.ts'

type Ender = WaitCensusModel['longest'][number]['endedBy']
type Reason = WaitCensusModel['byReason'][number]

/** Every wait reason, and whether its exit is a person (the work domain's `WAITS`; a new reason fails tsc here). */
const PERSON: Record<WaitReason, boolean> = {
  timer: false,
  dependency: false,
  wall: false,
  unreported: false,
  blocked: false,
  lead_gone: false,
  regressed: false,
  decision: true,
  review: true,
  errand: true,
  external: false,
}
const WAIT_REASONS = Object.keys(PERSON) as WaitReason[]

const MINUTE = 60
const HOUR = 3600
const LONGEST = 10

const WaitRow = z.object({
  issue_id: z.string(),
  reason: z.string(),
  began: z.date(),
  ended: z.date().nullable(),
  actor: z.string().nullable(),
})

/** Who ended a wait: the actor of the event that left it, or `open` while it goes on. */
const enderOf = (row: z.infer<typeof WaitRow>): Ender => {
  if (row.ended === null) return 'open'
  // the orchestrator holds the owner's rights and is his hands; a lead or the factory's own code is no person
  if (row.actor === 'owner' || row.actor === 'orchestrator') return 'owner'
  return row.actor === 'judge' || row.actor === 'steward' ? row.actor : 'factory'
}

/**
 * A wait nobody's hands were needed to end: its exit is a person (a Decision, a review, an Errand) and the Judge, a
 * standing policy, a default verdict, the steward or a check ended it. A lead that had taken the reversible default, built
 * on the Spec's defaults or filed the follow-up and shipped would not have waited. A wait the owner ended, a timer, a
 * chain and a stall are not marked: the read cannot tell a needed one from one a lead could have skipped, so it counts and
 * sizes them and leaves the judgment to whoever reads the longest.
 */
const avoidable = (reason: string, ender: Ender): boolean =>
  PERSON[reason as WaitReason] === true && ender !== 'owner' && ender !== 'open'

const bucketOf = (seconds: number): keyof Reason['buckets'] => {
  if (seconds < 30 * MINUTE) return 'lt30m'
  if (seconds < 2 * HOUR) return 'lt2h'
  if (seconds < 24 * HOUR) return 'lt24h'
  return 'gte24h'
}

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals

/**
 * The waits that began in the last `days` days, counted by reason and length, and which of them no person's hands were
 * needed to end. A wait is the span from the applied event that began it (its `wait.since` is its own version) to the next
 * applied event that left the state or began another wait; one still going lasts until `now`. Read-only SQL over
 * `issue_events`; only the sums happen here.
 */
export async function readWaitCensus(sql: SQL, options: { now: Date; days: number }): Promise<WaitCensusModel> {
  const { from, to } = windowOf(options.now, options.days)
  const rows: unknown[] = await sql`
    SELECT s.issue_id, s.wait->>'reason' AS reason, s.at AS began, n.at AS ended, n.actor
    FROM factory.issue_events s
    LEFT JOIN LATERAL (
      SELECT x.at, x.actor FROM factory.issue_events x
      WHERE x.issue_id = s.issue_id AND x.result = 'applied' AND x.version > s.version
        AND (x.to_state <> 'waiting' OR (x.wait->>'since')::int <> s.version)
      ORDER BY x.version LIMIT 1
    ) n ON true
    WHERE s.result = 'applied' AND s.to_state = 'waiting' AND (s.wait->>'since')::int = s.version
      AND s.at >= ${from} AND s.at < ${to}
    ORDER BY s.at, s.issue_id`
  const waits = rows.map((raw) => {
    const row = WaitRow.parse(raw)
    const seconds = Math.max(0, ((row.ended ?? to).getTime() - row.began.getTime()) / 1000)
    const endedBy = enderOf(row)
    return { issue: row.issue_id, reason: row.reason, seconds, endedBy, avoidable: avoidable(row.reason, endedBy) }
  })

  const byReason = WAIT_REASONS.map((reason): Reason => {
    const own = waits.filter((wait) => wait.reason === reason)
    const durations = own.map((wait) => wait.seconds)
    const card: Reason = {
      reason,
      person: PERSON[reason],
      count: own.length,
      open: own.filter((wait) => wait.endedBy === 'open').length,
      totalSeconds: round(
        durations.reduce((sum, seconds) => sum + seconds, 0),
        1,
      ),
      p50Seconds: round1(percentile(durations, 0.5)),
      p90Seconds: round1(percentile(durations, 0.9)),
      buckets: { lt30m: 0, lt2h: 0, lt24h: 0, gte24h: 0 },
      endedBy: { owner: 0, judge: 0, steward: 0, factory: 0, open: 0 },
      avoidableCount: 0,
      avoidableSeconds: 0,
    }
    for (const wait of own) {
      card.buckets[bucketOf(wait.seconds)] += 1
      card.endedBy[wait.endedBy] += 1
      if (!wait.avoidable) continue
      card.avoidableCount += 1
      card.avoidableSeconds += wait.seconds
    }
    card.avoidableSeconds = round(card.avoidableSeconds, 1)
    return card
  }).sort((a, b) => b.totalSeconds - a.totalSeconds || a.reason.localeCompare(b.reason))

  const totalSeconds = round(
    byReason.reduce((sum, card) => sum + card.totalSeconds, 0),
    1,
  )
  const avoidableSeconds = round(
    byReason.reduce((sum, card) => sum + card.avoidableSeconds, 0),
    1,
  )
  return {
    at: to.toISOString(),
    days: options.days,
    window: { from: from.toISOString(), to: to.toISOString() },
    waits: waits.length,
    totalSeconds,
    avoidableSeconds,
    avoidableShare: totalSeconds === 0 ? null : round(avoidableSeconds / totalSeconds, 3),
    byReason,
    longest: [...waits]
      .sort((a, b) => b.seconds - a.seconds || issueNumberOf(a.issue) - issueNumberOf(b.issue))
      .slice(0, LONGEST)
      .map((wait) => ({
        issue: wait.issue,
        reason: wait.reason,
        seconds: round(wait.seconds, 1),
        open: wait.endedBy === 'open',
        endedBy: wait.endedBy,
        avoidable: wait.avoidable,
      })),
  }
}

const round1 = (value: number | null): number | null => (value === null ? null : round(value, 1))
