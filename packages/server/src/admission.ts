import type { HoldReason } from '@software-factory/contract'
import type { SQL } from 'bun'
import { currentLoads, latestReadings, nextOpening, pickEligible } from './capacity.ts'
import { effectiveState, loadQueueStates } from './queue.ts'
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
}

/** Whether a session started in `at` belongs to `repo`: it started there or in a worktree or folder below it. */
const inRepo = (at: string, repo: string): boolean =>
  at === repo || at.startsWith(repo.endsWith('/') ? repo : `${repo}/`)

async function readLive(tx: SQL, now: Date, live?: { sessions?: LiveSession[] }): Promise<LiveSession[]> {
  if (!live) return liveSessions(tx, now)
  live.sessions ??= await liveSessions(tx, now)
  return live.sessions
}

/**
 * Whether a spawn may start, in the order of the rules: the queue state (`drain` starts nothing), one live `wave`
 * session per repo, `pace` (one live session per project), and then an account with room, which under `pace` is
 * also one whose weekly use is at or below the elapsed share of its week. Never spills: with every account closed
 * the answer is to wait for the first opening. Reads inside the caller's transaction; calls nothing outside the database.
 *
 * `live` is the caller's list of live sessions, for a caller that claims several spawns in one transaction and
 * adds each claim to it; without it the sessions are read when a rule needs them.
 */
export async function admit(
  tx: SQL,
  candidate: Candidate,
  now: Date,
  live?: { sessions?: LiveSession[] },
): Promise<Decision> {
  const state = effectiveState(await loadQueueStates(tx), candidate.repo)
  if (state === 'drain') return { kind: 'hold', reason: 'drain' }

  const sessions = state === 'pace' || candidate.role === WAVE_ROLE ? await readLive(tx, now, live) : []
  const others = sessions.filter((s) => s.id !== candidate.key && inRepo(s.repo, candidate.repo))
  if (candidate.role === WAVE_ROLE && others.some((s) => s.role === WAVE_ROLE)) return { kind: 'hold', reason: 'wave' }
  if (state === 'pace' && others.length > 0) return { kind: 'hold', reason: 'pace' }

  const readings = await latestReadings(tx)
  const options = { now, pace: state === 'pace', prefer: candidate.prefer }
  const picked = pickEligible(readings, await currentLoads(tx, readings, candidate.key), options)
  if (picked) return { kind: 'start', account: picked.account }
  return { kind: 'wait', resumeAt: nextOpening(readings, options) ?? null }
}
