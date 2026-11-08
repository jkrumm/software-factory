import { classOf, mayFile, verdictOf, type ClassVerdict, type FindingLoop } from '../../domains/loops/classes.ts'
import type { LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

/**
 * What a pass may file, decided once at its start from the outcomes of each class's Issues. A class is the loop plus the
 * key's first segment across every repo (one probe misfiring everywhere is the pattern). A class on probation may file one
 * Issue at a time across repos: an open Issue of the class in any repo holds it. `allows` claims the slot for this pass.
 */
export interface ClassGate {
  /** true when the finding's class may file now (and claims the class's slot for this pass) */
  allows(key: string): boolean
  /** the finding stands as an Issue: remember which class filed it; the reason when that could not be stored; `repo` is stored as a fact, not part of the class */
  record(issue: string | null, key: string, repo: string): Promise<string | null>
}

const OPEN: ClassVerdict = { status: 'open', decided: 0, noise: 0, share: null, open: 0, heldUntil: null }

export async function readGate(
  deps: { uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads }> },
  input: { loop: FindingLoop; now: Date },
): Promise<Result<ClassGate, PortError>> {
  const read = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.classIssues(input.loop)))
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
    async record(issue, key, repo) {
      if (issue === null) return null
      const recorded = await deps.uow.run(async ({ loops }) => {
        await loops.recordFinding({ issue, loop: input.loop, repo, class: classOf(input.loop, key), key })
        return ok(undefined)
      })
      return recorded.ok ? null : `${recorded.error.kind}: ${recorded.error.detail}`
    },
  })
}
