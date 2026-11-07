import { releaseSlot, type SlotRow, type SlotView, slotLines, touchSlots } from '../domains/capacity/slots.ts'
import { DEFAULT_SLOT_RUN_MS, durationMs } from '../domains/planning/project.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

/** The run limit of a grant: the caller's own, else the `slots.run` of the project whose repo is the caller's directory (the longest repo wins, so a worktree matches), else the default. */
async function runLimitMs(
  deps: PlanningDeps,
  input: { cwd?: string | undefined; limitMs?: number | undefined },
): Promise<number> {
  if (input.limitMs !== undefined) return input.limitMs
  const cwd = input.cwd
  if (cwd === undefined) return DEFAULT_SLOT_RUN_MS
  return deps.uow
    .run(async ({ planning }) => {
      const owner = (await planning.projects())
        .filter((p) => cwd === p.repo || cwd.startsWith(`${p.repo}/`))
        .sort((a, b) => b.repo.length - a.repo.length)[0]
      const run = owner?.project.slots.run
      return ok((run ? durationMs(run) : undefined) ?? DEFAULT_SLOT_RUN_MS)
    })
    .then((result) => (result.ok ? result.value : DEFAULT_SLOT_RUN_MS))
}

export interface SlotDeps extends PlanningDeps {
  /** `FACTORY_SLOTS`: how many commands run their tests at once on this host */
  slots: number
}

/**
 * One call of `factory slot run`: a request for a slot and the renewal of the one it has. The first call makes the
 * caller a waiter, a waiter first in line with a slot free gets it, a holder's call renews the lease. Everything runs
 * behind the capacity lock.
 */
export async function touchSlot(
  deps: SlotDeps,
  input: { id: string; name: string; cwd?: string | undefined; limitMs?: number | undefined },
): Promise<Result<SlotView, PortError>> {
  const runMs = await runLimitMs(deps, input)
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const touched = touchSlots(
      await capacity.slots(),
      { id: input.id, name: input.name, slots: deps.slots, runMs },
      deps.clock.now(),
    )
    await capacity.saveSlots(touched.rows)
    return ok(touched.view)
  })
}

/** Gives the slot back (or leaves the line). True if the caller had a row. */
export async function giveSlotBack(deps: PlanningDeps, id: string): Promise<Result<boolean, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const released = releaseSlot(await capacity.slots(), id)
    if (released.had) await capacity.saveSlots(released.rows)
    return ok(released.had)
  })
}

export async function slotRows(deps: PlanningDeps): Promise<Result<{ rows: SlotRow[]; lines: string[] }, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    const rows = await capacity.slots()
    return ok({ rows, lines: slotLines(rows, deps.clock.now()) })
  })
}
