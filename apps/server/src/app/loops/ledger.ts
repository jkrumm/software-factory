import { judgeClosed, lastTime, newestByKey, type ClosedFinding, type LedgerLoop } from '../../domains/loops/ledger.ts'
import type { LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

/** What a pass knows of the Issues its loop's earlier findings opened, once their verdicts are in. */
export interface Ledger {
  /** the line a finding's signal carries when its key filed an Issue that closed (`null` for a key with none); `now` is the figure it is filed against now */
  lastTime(key: string, now: number | null): string | null
}

/**
 * Judges the loop's closed findings that have no verdict yet against the figure each is read at now (`read`: `null` the
 * source has none, `undefined` it could not be read and the finding waits for the next pass), stores the verdicts, and returns
 * what the pass says of a key it files again. `repo` narrows to one repo (the hygiene loop sweeps one a pass).
 */
export async function settleClosed(
  deps: { uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads }> },
  input: { loop: LedgerLoop; repo?: string; now: Date; read: (row: ClosedFinding) => number | null | undefined },
): Promise<Result<Ledger, PortError>> {
  return deps.uow.run(async ({ loops, loopReads }) => {
    const rows = await loopReads.closedFindings(input.loop, input.repo)
    const judged = judgeClosed(rows, input.read)
    if (judged.length > 0) await loops.recordVerdicts(judged, input.now)
    const verdicts = new Map(judged.map((entry) => [`${entry.issue}\n${entry.key}`, entry.verdict]))
    const newest = newestByKey(
      rows.map((row) => ({ ...row, verdict: verdicts.get(`${row.issue}\n${row.key}`) ?? row.verdict })),
    )
    return ok({ lastTime: (key, now) => lastTime(newest.get(key), now) } satisfies Ledger)
  })
}
