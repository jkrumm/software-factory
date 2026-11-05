import { REVIEWER_ROLE, type Status } from '@software-factory/contract'
import type { SQL } from 'bun'
import { liveSessions, type LiveSession } from '../sessions.ts'

/** What bounds review v4's reviewer sessions (docs/design.md §3 "The review transport"). */
export interface ReviewLimits {
  /** `FACTORY_REVIEW_SESSIONS`: live reviewer sessions host-wide */
  sessions: number
  /** `FACTORY_REVIEW_DEEP_CAP`: reviewer spawns of tier `deep` started per account per UTC day */
  deepCap: number
  /** `FACTORY_REVIEW_IDLE_MS`: a reviewer whose open turn leaves its transcript unchanged this long is closed */
  idleMs: number
}

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = { sessions: 2, deepCap: 15, idleMs: 600_000 }

/** How long a `needs_human` stays a health line. */
export const NEEDS_HUMAN_SHOWN_MS = 3 * 86_400_000

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

export const utcDayStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** Reviewer sessions that hold a slot: alive, and whose attempt has no recorded outcome yet (an ended attempt gives its slot back when its outcome is recorded, not when the witness notices the closed terminal). */
export async function reviewSessionsLive(sql: SQL, sessions: readonly LiveSession[], except?: string): Promise<number> {
  const mine = sessions.filter((s) => s.role === REVIEWER_ROLE && s.id !== except).map((s) => s.id)
  if (mine.length === 0) return 0
  const done: { spawn_key: string }[] =
    await sql`SELECT spawn_key FROM factory.review_outcomes WHERE spawn_key IN ${sql(mine)}`
  return mine.length - done.length
}

/** Deep reviewer spawns that started today (UTC) per account; `except` leaves the spawn being admitted out. */
export async function deepStartedToday(sql: SQL, now: Date, except?: string): Promise<Map<string, number>> {
  const rows: { account: string; n: number }[] = await sql`
    SELECT account, count(*)::int AS n FROM factory.spawns
    WHERE role = ${REVIEWER_ROLE} AND review_tier = 'deep' AND status IN ('starting', 'started') AND account IS NOT NULL
      AND first_claimed_at >= ${utcDayStart(now)} AND key IS DISTINCT FROM ${except ?? null}
    GROUP BY account`
  return new Map(rows.map((r) => [r.account, r.n]))
}

/** `factory status`' reviews line: live against the slots, and today's deep starts per account. */
export async function reviewStatus(sql: SQL, now: Date, limits: ReviewLimits): Promise<NonNullable<Status['reviews']>> {
  const live = await reviewSessionsLive(sql, await liveSessions(sql, now))
  const today = await deepStartedToday(sql, now)
  return {
    live,
    slots: limits.sessions,
    deepCap: limits.deepCap,
    deepToday: [...today]
      .map(([account, started]) => ({ account, started }))
      .sort((a, b) => a.account.localeCompare(b.account)),
  }
}

/**
 * The review lines of `factory status`. `health`: a job both attempts failed (`needs a human`: a machine failure, not a decision).
 * `asks`: a deep review held by the day's cap, whose `allow` is the owner's call (the spawn key is the second word; the ask reads it back).
 */
export async function reviewAttention(
  sql: SQL,
  now: Date,
  limits: ReviewLimits,
): Promise<{ asks: string[]; health: string[] }> {
  const health: string[] = []
  const asks: string[] = []
  const since = new Date(now.getTime() - NEEDS_HUMAN_SHOWN_MS)
  const human: { job_id: string; attempt: number; detail: string | null }[] = await sql`
    SELECT job_id, attempt, detail FROM factory.review_outcomes WHERE outcome = 'needs_human' AND at > ${since} ORDER BY at, spawn_key`
  for (const r of human) {
    health.push(
      `review ${r.job_id} needs a human: attempt ${r.attempt} failed${r.detail ? `: ${oneLine(r.detail, 300)}` : ''}`,
    )
  }
  const held: { key: string }[] = await sql`
    SELECT key FROM factory.spawns WHERE role = ${REVIEWER_ROLE} AND hold = 'deep_cap' AND status = 'queued' AND NOT deep_allowed ORDER BY created_at, key`
  if (held.length === 0) return { asks, health }
  const today = [...(await deepStartedToday(sql, now))].sort(([a], [b]) => a.localeCompare(b))
  const counts = today.map(([account, n]) => `${account} ${n}/${limits.deepCap}`).join(', ')
  for (const { key } of held) {
    asks.push(
      `review ${key} held: deep cap reached on every open account today (UTC), started ${counts || 'none'}; allow runs it past the cap`,
    )
  }
  return { asks, health }
}
