import { type HoldReason, REVIEWER_ROLE, type ReviewMeta } from '@software-factory/contract'
import type { SQL } from 'bun'
import { currentLoads, latestReadings, nextOpening, pickEligible } from './capacity.ts'
import { tryClaim } from './projects/claims.ts'
import { effectiveState, loadQueueStates } from './queue.ts'
import { DEFAULT_REVIEW_LIMITS, deepStartedToday, type ReviewLimits, reviewSessionsLive } from './review/limits.ts'
import { type LiveSession, liveSessions } from './sessions.ts'

/** The role that is limited to one live session per repo. */
export const WAVE_ROLE = 'wave'

/** How long a held spawn waits before admission looks at it again (a wave ending or a session dying wakes nothing). */
export const HOLD_RECHECK_MS = 30_000

export type Decision =
  /** an account has room: start on it */
  | { kind: 'start'; account: string }
  /** a rule other than capacity says not now; the spawn stays queued */
  | { kind: 'hold'; reason: HoldReason }
  /** no account has room; look again at `resumeAt` (the first opening, none if no reading names one) or on a new reading */
  | { kind: 'wait'; resumeAt: Date | null }

export interface Candidate {
  /** the spawn's key: its own session and its own assignment do not count against it */
  key: string
  repo: string
  role: string
  /** the account it already has, kept while it is still open */
  prefer?: string | null
  /** the Issue it works: it waits on the Issue's claim on the project. A fleet spawn has none and takes no claim. */
  issueId?: number | null
  /** a reviewer's job: its tier decides whether the day's deep cap applies */
  review?: Pick<ReviewMeta, 'tier'> | null
  /** the owner's `allow`: this spawn may start past the day's deep cap */
  deepAllowed?: boolean
}

const inside = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)

/**
 * Whether a session started in `at` belongs to `repo`: it started there or below it, or `repo` is a Claude Code worktree
 * of the directory it started in (`<at>/.claude/worktrees/…`). A session in a parent folder (the home directory, a workspace
 * root) is not in every repo below it.
 */
const inRepo = (at: string, repo: string): boolean =>
  inside(at, repo) || inside(repo, `${at.replace(/\/$/, '')}/.claude/worktrees`)

async function readLive(tx: SQL, now: Date, live?: { sessions?: LiveSession[] }): Promise<LiveSession[]> {
  if (!live) return liveSessions(tx, now)
  live.sessions ??= await liveSessions(tx, now)
  return live.sessions
}

/**
 * Whether a spawn may start, in the order of the rules: the queue state (`drain` starts nothing), one unfinished `wave`
 * session per repo, `pace` (one live session per project), the Issue's claim on its project (`claim`; a spawn with an Issue only),
 * and then an account with room, which under `pace` is also one whose weekly use is at or below the elapsed share of its week.
 * Never spills: with every account closed the answer is to wait for the first opening. Works inside the caller's transaction and
 * calls nothing outside the database; the one write is the claim, taken or queued (no account is reserved by a hold).
 *
 * `live` is the caller's list of live sessions, for a caller that claims several spawns in one transaction and
 * adds each claim to it; without it the sessions are read when a rule needs them.
 */
export async function admit(
  tx: SQL,
  candidate: Candidate,
  now: Date,
  live?: { sessions?: LiveSession[] },
  limits: ReviewLimits = DEFAULT_REVIEW_LIMITS,
): Promise<Decision> {
  const state = effectiveState(await loadQueueStates(tx), candidate.repo)
  if (state === 'drain') return { kind: 'hold', reason: 'drain' }
  if (candidate.role === REVIEWER_ROLE) return admitReview(tx, candidate, now, live, limits)

  const sessions = state === 'pace' || candidate.role === WAVE_ROLE ? await readLive(tx, now, live) : []
  const others = sessions.filter((s) => s.id !== candidate.key && inRepo(s.repo, candidate.repo))
  // A chain wave leaves its tab open after it spawned its successor, so a wave whose turn has ended does not hold the repo.
  if (candidate.role === WAVE_ROLE && others.some((s) => s.role === WAVE_ROLE && !s.finished))
    return { kind: 'hold', reason: 'wave' }
  if (state === 'pace' && others.length > 0) return { kind: 'hold', reason: 'pace' }
  if (candidate.issueId != null && (await tryClaim(tx, candidate.issueId, now)) === 'queued') {
    return { kind: 'hold', reason: 'claim' }
  }

  const readings = await latestReadings(tx)
  const options = { now, pace: state === 'pace', prefer: candidate.prefer }
  const picked = pickEligible(readings, await currentLoads(tx, readings, candidate.key), options)
  if (picked) return { kind: 'start', account: picked.account }
  return { kind: 'wait', resumeAt: nextOpening(readings, options) ?? null }
}

/**
 * A reviewer (review v4) is admitted by its own rules, after `drain`: at most `limits.sessions` live reviewer sessions host-wide
 * (`review_slots`), then an account under the review ceiling (`capacity.ts`; none is a wait, like any spawn, never a spill), then for a
 * `deep` review an account that has not started `limits.deepCap` deep reviews today (UTC): all of them spent is `deep_cap`, unless the owner
 * allowed this spawn. The tier is never lowered. `pace` and the one-wave-per-repo rule do not apply: the reviewer reads the repo of the
 * session that asked for it, which `pace` (one live session per project) would hold behind that very session.
 */
async function admitReview(
  tx: SQL,
  candidate: Candidate,
  now: Date,
  live: { sessions?: LiveSession[] } | undefined,
  limits: ReviewLimits,
): Promise<Decision> {
  const taken = await reviewSessionsLive(tx, await readLive(tx, now, live), candidate.key)
  if (taken >= limits.sessions) return { kind: 'hold', reason: 'review_slots' }

  const readings = await latestReadings(tx)
  const loads = await currentLoads(tx, readings, candidate.key)
  const options = { now, prefer: candidate.prefer, review: true }
  const eligible = pickEligible(readings, loads, options)
  if (!eligible) return { kind: 'wait', resumeAt: nextOpening(readings, options) ?? null }
  if (candidate.review?.tier !== 'deep' || candidate.deepAllowed) return { kind: 'start', account: eligible.account }
  const started = await deepStartedToday(tx, now, candidate.key)
  const room = readings.filter((r) => (started.get(r.account) ?? 0) < limits.deepCap)
  const picked = pickEligible(room, loads, options)
  return picked ? { kind: 'start', account: picked.account } : { kind: 'hold', reason: 'deep_cap' }
}
