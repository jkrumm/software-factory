import type { ErrandCheckReply } from '@software-factory/contract'
import type { ErrandId } from '../domains/checkpoints/errand.ts'
import type { ErrandRecord } from '../domains/checkpoints/ports.ts'
import { err, ok } from '../kernel/result.ts'
import type { CheckpointResult } from './checkpoints.ts'
import { resolveErrand } from './checkpoints-errands.ts'
import type { SettleDeps } from './checkpoints-settle.ts'
import { runCheck } from './loops/errands.ts'

export interface ErrandChecked {
  outcome: ErrandCheckReply['outcome']
  /** the check's own words, or the closing note */
  note: string | null
  errand: ErrandRecord
}

/**
 * Runs one Errand's check now, the way the desk pass does and outside any transaction: exit 1..125 closes the Errand and
 * ends its Issue's wait (the lead hears that nothing is left to do), exit 0 keeps it, a check that could not run is noted.
 * The lead's way to settle an Errand its check already answers, without waiting for the owner's return or the next pass.
 */
export async function checkErrandNow(
  deps: SettleDeps,
  input: { errandId: ErrandId },
): Promise<CheckpointResult<ErrandChecked>> {
  const read = await deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.errand(input.errandId)))
  if (!read.ok) return read
  const errand = read.value
  if (!errand) return err({ kind: 'not_found', what: 'Errand', id: input.errandId })
  if (errand.doneAt) return ok({ outcome: 'already_closed', note: errand.doneNote, errand })
  if (errand.checkCommand === null) return ok({ outcome: 'no_check', note: null, errand })

  const pass = { kept: 0, checkedOut: 0, unrunnable: 0, problems: [] as string[] }
  const refusals: Extract<Awaited<ReturnType<typeof resolveErrand>>, { ok: false }>[] = []
  await runCheck(
    {
      uow: deps.uow,
      clock: deps.clock,
      checks: deps.checks,
      resolve: async (found, why) => {
        const closed = await resolveErrand(deps, found.id, why)
        if (!closed.ok) refusals.push(closed)
        return closed.ok && closed.value
      },
    },
    errand,
    errand.checkCommand,
    pass,
  )
  // the check said "not needed" but the close was refused: say so, never "needed"
  if (refusals[0]) return refusals[0]
  const after = await deps.uow.run(async ({ checkpoints }) => ok(await checkpoints.errand(input.errandId)))
  if (!after.ok) return after
  const now = after.value ?? errand
  if (now.doneAt) return ok({ outcome: 'closed', note: now.doneNote, errand: now })
  return ok({ outcome: pass.unrunnable > 0 ? 'unrunnable' : 'needed', note: now.checkNote, errand: now })
}
