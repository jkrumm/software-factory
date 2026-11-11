import type { Leak } from '../../domains/loops/reaper.ts'
import { decideReaping } from '../../domains/loops/reaper.ts'
import type { LoopStore, ProcessKiller, ReapedRow, ReaperProcesses } from '../../domains/loops/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface ReaperPassDeps {
  uow: UnitOfWork<{ loops: LoopStore }>
  clock: Clock
  processes: ReaperProcesses
  killer: ProcessKiller
  graceMs: number
  /** decide and record with signal `dry`, send nothing */
  dry: boolean
  /** pids never touched, with their ancestors: pid 1 and this server */
  protect: readonly number[]
}

/** The attempts weighed (closed within it) and the rows kept. */
export const REAPED_KEEP_MS = 30 * 86_400_000

/** A SIGTERM is followed up by a SIGKILL only on a later pass that is within this long. */
const ESCALATE_WITHIN_MS = 6 * 3_600_000

export interface ReaperPass {
  /** processes signalled (or, dry, decided on) */
  reaped: number
  /** the closed attempts they belonged to */
  attempts: number
  /** of those, the ones SIGKILLed after an earlier SIGTERM */
  escalated: number
  dry: boolean
}

/**
 * One pass of the reaper: the attempts and the earlier SIGTERMs are read (one transaction), then the process table with
 * each process's lead session and directory (outside any transaction; a failed `ps` or `lsof` fails the pass, nothing is
 * ever ended on partial knowledge), then the pure decision, then the signals, then one transaction records a row per signal
 * and drops rows older than 30 days. A process of a closed attempt gets SIGTERM; one that survived an earlier pass's
 * SIGTERM gets SIGKILL.
 */
export async function reaperPass(deps: ReaperPassDeps): Promise<Result<ReaperPass, PortError>> {
  const now = deps.clock.now()
  const known = await deps.uow.run(async ({ loops }) =>
    ok({
      attempts: await loops.reaperAttempts(new Date(now.getTime() - REAPED_KEEP_MS)),
      termed: await loops.termedSince(new Date(now.getTime() - ESCALATE_WITHIN_MS)),
    }),
  )
  if (!known.ok) return known
  const procs = await deps.processes.read()
  if (procs === null) return err(portError('unreadable', 'ps or lsof could not be read: nothing was ended'))

  const decision = decideReaping({
    procs,
    attempts: known.value.attempts,
    now,
    graceMs: deps.graceMs,
    protect: deps.protect,
    previouslyTermed: known.value.termed,
  })

  const rows: ReapedRow[] = []
  const send = async (leaks: readonly Leak[], signal: 'SIGTERM' | 'SIGKILL') => {
    for (const leak of leaks) {
      if (!deps.dry && !(await deps.killer.signal({ pid: leak.pid, ageS: leak.ageS }, signal))) continue
      rows.push({
        at: now,
        pid: leak.pid,
        session: leak.session,
        worktree: leak.worktree,
        comm: leak.comm,
        signal: deps.dry ? 'dry' : signal,
        reason: leak.reason,
        ageS: leak.ageS,
      })
    }
  }
  await send(decision.term, 'SIGTERM')
  await send(decision.kill, 'SIGKILL')

  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.recordReaped(rows)
    await loops.pruneReaped(new Date(now.getTime() - REAPED_KEEP_MS))
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  const killed = new Set(decision.kill.map((leak) => leak.pid))
  return ok({
    reaped: rows.length,
    attempts: new Set(rows.map((row) => row.session)).size,
    escalated: rows.filter((row) => killed.has(row.pid)).length,
    dry: deps.dry,
  })
}

export const reaperSummary = (pass: ReaperPass): string =>
  pass.reaped === 0
    ? 'nothing to reap'
    : `${pass.dry ? 'would reap' : 'reaped'} ${pass.reaped} process(es) of ${pass.attempts} closed attempt(s), ${pass.escalated} escalated`
