import type { SQL } from 'bun'
import { lockCapacity } from '../capacity.ts'
import type { Clock } from '../clock.ts'
import { releaseClaim, wakeClaimWaiters } from '../projects/claims.ts'
import { isPlanKey, type Runner } from '../runner.ts'
import { dropEmptySession } from '../sessions.ts'
import { archiveAttempt, type ProjectsDir, type TranscriptStore } from './archive.ts'
import { type Effect, type EffectPorts, Waiting } from './effects.ts'
import { leadBranch, leadKey } from './names.ts'
import type { OffTick } from './offtick.ts'
import { markEvent } from './shared.ts'
import type { Worktrees } from './worktree.ts'

export interface FinalizeDeps {
  sql: SQL
  clock: Clock
  runner: Pick<Runner, 'close'>
  worktrees: Pick<Worktrees, 'remove'>
  transcripts: TranscriptStore
  /** `FACTORY_ARCHIVE_DIR` */
  archiveDir: string
  /** the account's Claude projects directory: where a transcript may be copied from */
  projectsDir: ProjectsDir
  /** whether a worktree of the Issue is being made right now: it is removed when that is over */
  making: (issueId: number) => boolean
  offTick: OffTick
}

/**
 * The claim goes back, a lead or a worker of it that never started never will, and whoever waits for the place is looked at now rather than at its next
 * recheck, unless a later attempt holds the claim by now. Under the capacity lock like every admission, and on the tick: no check that fills the off-tick jobs may hold a project's place,
 * and between two passes no start is in flight, so a spawn still `starting` is one a crash left, whose lease would otherwise start it
 * later. Each statement finds its work done on a replay.
 */
async function giveBack({ sql, clock }: FinalizeDeps, issueId: number, attempt: number): Promise<void> {
  const now = clock.now()
  await sql.begin(async (tx) => {
    await lockCapacity(tx)
    // A finalize older than the attempt now running (one planned before this port existed, that nothing waited for) has no claim to give:
    // the one there is that attempt's.
    const [issue]: { state: string; attempt: number }[] =
      await tx`SELECT state, attempt FROM factory.issues WHERE id = ${issueId}`
    const owned = issue?.state === 'closed' || issue?.attempt === attempt
    const keys = owned ? await releaseClaim(tx, issueId) : []
    const lead = leadKey(issueId, attempt)
    const stopped: { key: string }[] = await tx`
      UPDATE factory.spawns SET status = 'failed', claimed_at = NULL, error = ${`Issue ${issueId} closed before the spawn started`}
      WHERE (key = ${lead} OR parent = ${lead}) AND status IN ('queued', 'waiting', 'starting')
      RETURNING key`
    for (const { key } of stopped) await dropEmptySession(tx, key)
    await wakeClaimWaiters(tx, keys, now)
  })
}

const attemptOf = (effect: Effect): number => Number(effect.payload?.attempt ?? 0)

const once = (issueId: number, attempt: number): string => `issue_finalized:${issueId}:${attempt}`

/**
 * What ends an attempt, from every exit path, in this order (the place was given back already, so nothing here can keep the next Issue
 * waiting): the lead's tab and those of the workers it spawned closed, so nothing writes after them; the transcripts archived; its worktree removed when clean and on the
 * base, otherwise kept with a line for the owner. `issue_finalized:<issue>:<attempt>` closes it: a second close of an attempt that
 * has it (a reopen that never started a lead) gives the claim back and touches nothing else. Every step finds its own work done, so a
 * crash between any two replays to one of each. Terminal state, and the promotion of the next Issue, are the transition's and admission's.
 */
async function finalize(deps: FinalizeDeps, effect: Effect): Promise<void> {
  const { sql, clock } = deps
  const issueId = effect.issueId
  const attempt = attemptOf(effect)

  const [done] = await sql`SELECT 1 FROM factory.issue_events WHERE key = ${once(issueId, attempt)}`
  if (done) return
  if (attempt >= 1) {
    // A worktree in the making comes after this removal otherwise, and stays for good.
    if (deps.making(issueId)) throw new Waiting(`the worktree of Issue ${issueId} is being made`)
    const [issue]: { repo: string }[] = await sql`SELECT repo FROM factory.issues WHERE id = ${issueId}`
    if (!issue) throw new Error(`issue ${issueId} is gone`)
    const lead = leadKey(issueId, attempt)
    const workers: { key: string }[] = await sql`SELECT key FROM factory.spawns WHERE parent = ${lead}`
    // Only the lead's own keys are closed; a `plan:` key is the owner's shell and is never passed on.
    for (const key of [lead, ...workers.map((worker) => worker.key)].filter((key) => !isPlanKey(key))) {
      await deps.runner.close(key)
    }
    await archiveAttempt(
      {
        sql,
        store: deps.transcripts,
        dir: deps.archiveDir,
        projectsDir: deps.projectsDir,
        now: () => clock.now(),
      },
      issueId,
      attempt,
    )
    // What the lead reported as merged, as the full shas resolved when it shipped: a squash leaves no commit of the branch on the base,
    // and nothing else says it landed. Never the strings the lead typed, which can be short or a branch name and resolve to something else now.
    const reported: { commits: string[] | null }[] = await sql`
      SELECT payload->'derived'->'commits' AS commits FROM factory.issue_inbox
      WHERE issue_id = ${issueId} AND kind IN ('ship', 'close') AND result = 'applied' AND payload->>'attempt' = ${String(attempt)}`
    const tree = await deps.worktrees.remove({
      repo: issue.repo,
      branch: leadBranch(issueId, attempt),
      reported: reported.flatMap((row) => row.commits ?? []),
    })
    if ('kept' in tree) {
      await markEvent(sql, issueId, `worktree_kept:${issueId}:${attempt}`, 'worktree_kept', clock.now(), tree)
    }
  }
  await markEvent(sql, issueId, once(issueId, attempt), 'issue_finalized', clock.now(), { attempt })
}

export function finalizePorts(deps: FinalizeDeps): Pick<EffectPorts, 'finalize'> {
  return {
    finalize: async (effect) => {
      await giveBack(deps, effect.issueId, attemptOf(effect))
      await deps.offTick.run(effect.key, () => finalize(deps, effect))
    },
  }
}
