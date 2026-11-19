// Re-login asks (keepalive path): a dead or soon-dead login asks its owner for a re-login through the command the user
// configured (integrations.reloginAsk). At most one ask per account per 24 h and one per machine per hour, never an auto-run.
import { type LoginRow, type RefreshResult, type ReloginCandidate, reloginCandidates } from './policy.ts'
import {
  RELOGIN_ASK_INTERVAL_MS,
  RELOGIN_CAP_INTERVAL_MS,
  claimStamp,
  releaseStamp,
  reloginCapPath,
  reloginStampPath,
} from './store.ts'
import { cacheDir } from './paths.ts'

export interface AskOutcome {
  /** the ask process started */
  asked: string[]
  /** the spawn threw: nothing is stamped, the next run retries */
  failed: string[]
  /** due, but the one-dialog-per-hour machine cap was taken: the next run retries */
  capped: string[]
}

/**
 * Asks (via `ask`) for every due candidate. Both slots are claimed atomically BEFORE the ask (the 24 h stamp per
 * account, the 1 h cap per machine), so two keepalive runs never ask twice; they are given back when the ask throws,
 * so the 24 h mute only ever follows an ask that really started. One account's failure never stops the others.
 */
export function askRelogins(d: {
  results: Record<string, RefreshResult>
  logins: LoginRow[]
  now: number
  dir?: string
  ask: (c: ReloginCandidate) => void
  log?: (msg: string) => void
}): AskOutcome {
  const dir = d.dir ?? cacheDir()
  const out: AskOutcome = { asked: [], failed: [], capped: [] }
  for (const c of reloginCandidates(d.results, d.logins)) {
    try {
      if (!claimStamp(reloginStampPath(dir, c.id), d.now, RELOGIN_ASK_INTERVAL_MS)) continue
      if (!claimStamp(reloginCapPath(dir), d.now, RELOGIN_CAP_INTERVAL_MS)) {
        releaseStamp(reloginStampPath(dir, c.id))
        out.capped.push(c.id)
        continue
      }
      try {
        d.ask(c)
        out.asked.push(c.id)
      } catch (e) {
        releaseStamp(reloginStampPath(dir, c.id))
        releaseStamp(reloginCapPath(dir))
        throw e
      }
    } catch (e) {
      out.failed.push(c.id)
      d.log?.(`re-login ask for ${c.id} failed: ${(e as Error).message}`)
    }
  }
  return out
}
