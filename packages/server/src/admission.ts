import { loadavg } from 'node:os'
import type { HoldReason } from '@software-factory/contract'
import type { SQL } from 'bun'
import { currentLoads, issueLeadsByAccount, latestReadings, nextOpening, pickEligible } from './capacity.ts'
import { tryClaim } from './projects/claims.ts'
import { effectiveState, loadQueueStates } from './queue.ts'
import { type LiveSession, liveSessions } from './sessions.ts'

/** The role of an Issue's lead (with an Issue it is capped per account; a program lead has none). */
export const LEAD_ROLE = 'lead'

/** `FACTORY_LEADS_PER_ACCOUNT`: most live Issue-lead sessions on one account. */
export const DEFAULT_LEADS_PER_ACCOUNT = 2

/** `FACTORY_LOAD_CEILING`: the 1-minute load average above which no new Issue lead is admitted. */
export const DEFAULT_LOAD_CEILING = 60

/** What admission is bounded by: the lead cap (the default without) and the load ceiling (none without: nothing is held for load). */
export interface AdmissionLimits {
  leadsPerAccount?: number
  loadCeiling?: number
  /** the machine's 1-minute load average; the default reads `os.loadavg()` */
  loadAverage?: () => number
}

/** The rule: a new Issue lead waits while the load is above the ceiling. The reading is passed in; running leads are never touched. */
export const heldByLoad = (load: number, ceiling: number): boolean => load > ceiling

const machineLoad = (): number => loadavg()[0] ?? 0

/** How long a held spawn waits before admission looks at it again (a session dying wakes nothing). */
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
  /** the Issue it works: it waits on the Issue's claim on the project. A spawn without one takes no claim. */
  issueId?: number | null
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
 * Whether a spawn may start, in the order of the rules: the queue state (`drain` starts nothing), the machine's load (a lead with an Issue is held, hold `load`, while the 1-minute load average is above `limits.loadCeiling`, `FACTORY_LOAD_CEILING`), `pace` (one live session per project), the Issue's claim on its project (`claim`; a spawn with an Issue only),
 * and then an account with room, which under `pace` is also one whose weekly use is at or below the elapsed share of its week.
 * Never spills: with every account closed the answer is to wait for the first opening. Works inside the caller's transaction and
 * calls nothing outside the database; the one write is the claim, taken or queued (no account is reserved by a hold).
 *
 * A spawn with role `lead` and an Issue also counts the live Issue-lead sessions per account (`limits.leadsPerAccount`, `FACTORY_LEADS_PER_ACCOUNT`):
 * an account at the cap is passed over, and with none left the spawn is held (hold `cap`, looked at again every `HOLD_RECHECK_MS`) rather than start. A lead asleep in a timed wait or a decision wait is not counted. Decided at every claim.
 *
 * `live` is the caller's list of live sessions, for a caller that claims several spawns in one transaction and
 * adds each claim to it; without it the sessions are read when a rule needs them.
 */
export async function admit(
  tx: SQL,
  candidate: Candidate,
  now: Date,
  live?: { sessions?: LiveSession[] },
  limits: AdmissionLimits = {},
): Promise<Decision> {
  const state = effectiveState(await loadQueueStates(tx), candidate.repo)
  if (state === 'drain') return { kind: 'hold', reason: 'drain' }
  // A new Issue lead waits while the machine is overloaded; before the claim, so a held lead takes no place in the queue.
  if (
    candidate.role === LEAD_ROLE &&
    candidate.issueId != null &&
    limits.loadCeiling !== undefined &&
    heldByLoad((limits.loadAverage ?? machineLoad)(), limits.loadCeiling)
  )
    return { kind: 'hold', reason: 'load' }

  const sessions = state === 'pace' ? await readLive(tx, now, live) : []
  const others = sessions.filter((s) => s.id !== candidate.key && inRepo(s.repo, candidate.repo))
  if (state === 'pace' && others.length > 0) return { kind: 'hold', reason: 'pace' }
  if (candidate.issueId != null && (await tryClaim(tx, candidate.issueId, now)) === 'queued') {
    return { kind: 'hold', reason: 'claim' }
  }

  const readings = await latestReadings(tx)
  const options = { now, pace: state === 'pace', prefer: candidate.prefer }
  const loads = await currentLoads(tx, readings, now, candidate.key)
  if (candidate.role === LEAD_ROLE && candidate.issueId != null) {
    // The lead cap: another account with room is picked; with none, the spawn waits and looks again, never spilling.
    const cap = limits.leadsPerAccount ?? DEFAULT_LEADS_PER_ACCOUNT
    const leads = await issueLeadsByAccount(tx, await readLive(tx, now, live), candidate.key)
    const picked = pickEligible(
      readings.filter((r) => (leads.get(r.account) ?? 0) < cap),
      loads,
      options,
    )
    if (picked) return { kind: 'start', account: picked.account }
    // An account that would take it but for the cap: held (hold `cap`, a health line after 15 min) and looked at again soon, a lead ending gives no reading to wake it.
    if (pickEligible(readings, loads, options)) return { kind: 'hold', reason: 'cap' }
    return { kind: 'wait', resumeAt: nextOpening(readings, options) ?? null }
  }
  const picked = pickEligible(readings, loads, options)
  if (picked) return { kind: 'start', account: picked.account }
  return { kind: 'wait', resumeAt: nextOpening(readings, options) ?? null }
}
