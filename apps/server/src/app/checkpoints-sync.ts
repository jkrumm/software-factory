import { isSyncCommand, needOf } from '../domains/errands/need.ts'
import type { SyncPort } from '../domains/errands/ports.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { outputNote } from '../kernel/run.ts'
import { type CheckpointDeps, finishErrand } from './checkpoints.ts'

/** Open Errands read in one pass. */
const READ_LIMIT = 500
const NOTE_MAX = 1500

export interface SyncPass {
  /** open `place` Errands whose command is exactly the dotfiles sync */
  looked: number
  /** closed through their done: the verb answered 0 (an Errand's own check still decides) */
  synced: number
  problems: string[]
}

/**
 * A `place` Errand whose command is exactly the dotfiles sync (`isSyncCommand`) is run through the MacBook's
 * `dotfiles-sync` verb instead of waiting for the owner to copy it. One call serves every such Errand, since the verb takes
 * no argument and all of them ask for the same thing. Exit 0 is the owner's done (`finishErrand`: the Errand's check
 * decides, the lead hears it). Any other answer changes nothing: the Errand stays on Needs you with its command, and the
 * pass names why (a refused tree is the MacBook's, an unreachable MacBook or an old gate is no failure of the command).
 *
 * Never inside a transaction, never throws, and does nothing, with no call, when no such Errand is open.
 */
export async function syncPlaceErrands(deps: CheckpointDeps, port: SyncPort): Promise<Result<SyncPass, PortError>> {
  const pass: SyncPass = { looked: 0, synced: 0, problems: [] }
  const read = await deps.uow.run(async ({ errands }) => ok(await errands.openErrands(READ_LIMIT)))
  if (!read.ok) return read
  const open = read.value.filter(
    (errand) =>
      errand.doneAt === null &&
      errand.reachedOwnerAt !== null &&
      errand.command !== null &&
      isSyncCommand(errand.command) &&
      (errand.need ?? needOf(errand)) === 'place' &&
      errand.runStatus !== 'running' &&
      errand.runStatus !== 'done',
  )
  pass.looked = open.length
  if (open.length === 0) return ok(pass)

  const answer = await port.sync()
  if (!answer.ok) {
    pass.problems.push(`dotfiles-sync: ${answer.error.detail}`.slice(0, 300))
    return ok(pass)
  }
  const { exit, output } = answer.value
  if (exit !== 0) {
    const head = outputNote(output).replace(/\s+/g, ' ').trim().slice(0, 200)
    pass.problems.push(`dotfiles-sync exited ${exit}${head === '' ? '' : `: ${head}`}`)
    return ok(pass)
  }
  for (const errand of open) {
    const closed = await finishErrand(deps, {
      errandId: errand.id,
      note: `synced by the factory through the MacBook's dotfiles-sync (exit 0)${output.trim() === '' ? '' : `: ${outputNote(output).slice(0, NOTE_MAX)}`}`,
      run: { status: 'done', exit: 0, output },
    })
    if (!closed.ok) pass.problems.push(`${errand.id}: ${JSON.stringify(closed.error)}`.slice(0, 300))
    else if (closed.value.errand.doneAt !== null) pass.synced++
  }
  return ok(pass)
}

export const syncSummary = (pass: SyncPass): string =>
  pass.looked === 0 ? '' : `${pass.synced}/${pass.looked} dotfiles-sync Errands closed`
