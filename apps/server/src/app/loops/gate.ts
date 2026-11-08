import { classOf, mayFile, verdictOf, type ClassVerdict, type FindingLoop } from '../../domains/loops/classes.ts'
import type { LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

/**
 * What a pass may file, decided once at its start from the outcomes of each class's Issues. A class on probation may file
 * one Issue in the pass; `allows` claims that slot, so a second finding of the class is refused.
 */
export interface ClassGate {
  /** true when the finding's class may file now (and claims the class's slot for this pass) */
  allows(key: string): boolean
  /** the finding stands as an Issue: remember which class filed it; the reason when that could not be stored */
  record(issue: string | null, key: string): Promise<string | null>
}

const OPEN: ClassVerdict = { status: 'open', decided: 0, noise: 0, share: null, open: 0, heldUntil: null }

export async function readGate(
  deps: { uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads }> },
  input: { loop: FindingLoop; repo: string; now: Date },
): Promise<Result<ClassGate, PortError>> {
  const read = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.classIssues(input.loop, input.repo)))
  if (!read.ok) return read
  const verdicts = new Map(Object.entries(read.value).map(([name, issues]) => [name, verdictOf(issues, input.now)]))
  const claimed = new Set<string>()
  return ok({
    allows(key) {
      const name = classOf(input.loop, key)
      if (!mayFile(verdicts.get(name) ?? OPEN, claimed.has(name))) return false
      claimed.add(name)
      return true
    },
    async record(issue, key) {
      if (issue === null) return null
      const recorded = await deps.uow.run(async ({ loops }) => {
        await loops.recordFinding({ issue, loop: input.loop, repo: input.repo, class: classOf(input.loop, key), key })
        return ok(undefined)
      })
      return recorded.ok ? null : `${recorded.error.kind}: ${recorded.error.detail}`
    },
  })
}
