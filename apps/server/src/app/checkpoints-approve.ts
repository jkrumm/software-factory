import { miniShellLine, needOf } from '../domains/checkpoints/need.ts'
import type { ErrandRecord } from '../domains/checkpoints/ports.ts'
import type { ErrandId } from '../domains/checkpoints/errand.ts'
import { err, ok, portError } from '../kernel/result.ts'
import { outputNote } from '../kernel/run.ts'
import { err as fail, type Result } from '../kernel/result.ts'
import { type CheckpointDeps, type CheckpointError, type CheckpointResult, finishErrand } from './checkpoints.ts'

/** A run that began this long ago and never reported (the server restarted under it) may be started again. */
export const APPROVED_RUN_STALE_MS = 35 * 60_000
/** A hang guard on an approved command, never a budget: a release or a restart takes minutes. */
export const APPROVED_RUN_HANG_GUARD_MS = 30 * 60_000
const NOTE_MAX = 1500

export interface ErrandApproved {
  errand: ErrandRecord
  /**
   * Resolves when the command ended and what it came to is recorded. The route answers at once and never waits on it (a
   * release can take minutes); a test awaits it. It never rejects.
   */
  done: Promise<void>
}

const refused = (detail: string): Result<never, CheckpointError> => fail({ kind: 'machine_refused', detail })

/**
 * The owner's Approve on an `approval` Errand: its command runs on the mini, here, as the server's own user with the
 * server's secrets left out, and what it came to is recorded the way a pushed run is. Exit 0 goes through the owner's done
 * (`finishErrand`: its check decides whether the Errand closes, and the lead hears it); a failure, a timeout or a command
 * that never started leaves it open with the run's first and last lines, and the second such failure ends it (the same
 * command is not offered a third time). One run at a time per Errand.
 *
 * Refused when the Errand is closed, never reached the owner, needs something else than his yes, or runs already. The route
 * is the owner's own (`api/policy.ts`: `PERSON`); docs/architecture.md says what that does and does not guard.
 */
export async function approveErrand(
  deps: CheckpointDeps,
  input: { errandId: ErrandId },
): Promise<CheckpointResult<ErrandApproved>> {
  const { commands } = deps
  if (!commands) return err(portError('gone', 'this process has no runner for an approved command'))
  const started = await deps.uow.run<ErrandRecord, CheckpointError>(async ({ checkpoints }) => {
    const errand = await checkpoints.lockErrand(input.errandId)
    if (!errand) return err({ kind: 'not_found', what: 'Errand', id: input.errandId })
    if (errand.doneAt) return refused(`${errand.id} is closed already`)
    if (errand.reachedOwnerAt === null) return refused(`${errand.id} has not reached the owner yet`)
    if (errand.command === null || (errand.need ?? needOf(errand)) !== 'approval')
      return refused(`${errand.id} is not an approval: it needs ${errand.need ?? needOf(errand)}, not his yes alone`)
    const at = deps.clock.now()
    const begun = await checkpoints.startApprovedRun(errand.id, at, new Date(at.getTime() - APPROVED_RUN_STALE_MS))
    if (!begun) return refused(`${errand.id} is closed or its command is running already`)
    const now = await checkpoints.errand(errand.id)
    if (!now) throw new Error(`errand ${errand.id} vanished inside its own transaction`)
    return ok(now)
  })
  if (!started.ok) return started
  return ok({ errand: started.value, done: runApproved(deps, started.value) })
}

/** Runs the command, outside any transaction, and writes what it came to. Never throws. */
async function runApproved(deps: CheckpointDeps, errand: ErrandRecord): Promise<void> {
  const { commands } = deps
  if (!commands || errand.command === null) return
  try {
    const run = await commands.run(miniShellLine(errand.command))
    const status = run.timedOut ? 'timeout' : run.exit === 0 ? 'done' : 'failed'
    const result = await finishErrand(deps, {
      errandId: errand.id,
      note:
        status === 'done'
          ? `approved by the owner, ran on the mini (exit 0)${run.output === '' ? '' : `: ${outputNote(run.output).slice(0, NOTE_MAX)}`}`
          : null,
      run: { status, exit: run.exit, output: run.output },
    })
    if (!result.ok) {
      console.error(
        `checkpoints: the approved run of ${errand.id} could not be recorded: ${JSON.stringify(result.error)}`,
      )
      return
    }
    // it succeeded and its check still says it is needed: the Errand stays, without a run still marked as going
    if (status === 'done' && result.value.errand.doneAt === null) {
      await deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.clearRun(errand.id)))
    }
  } catch (cause) {
    console.error(`checkpoints: the approved run of ${errand.id} failed: ${String(cause).slice(0, 300)}`)
  }
}
