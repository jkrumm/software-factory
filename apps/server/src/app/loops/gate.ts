import { finderOf, mayFile, verdictOf, type FinderVerdict, type FindingLoop } from '../../domains/improve/finders.ts'
import type { LoopReads, LoopStore } from './stores.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

/**
 * What a pass may file, decided once at its start from the outcomes of each finder's Issues. A finder is the loop plus the
 * key's first segment across every repo (one probe misfiring everywhere is the pattern). A finder on probation may file one
 * Issue at a time across repos: an open Issue of the finder in any repo holds it. `allows` claims the slot for this pass.
 */
export interface FinderGate {
  /** true when the finding's finder may file now (and claims the finder's slot for this pass) */
  allows(key: string): boolean
  /**
   * the finding stands as an Issue: remember which finder filed it, with the figure it was filed against (null: it has none)
   * and the signal; the reason when that could not be stored; `repo` is stored as a fact, not part of the finder
   */
  record(
    issue: string | null,
    key: string,
    repo: string,
    filed: { figure: number | null; signal: string | null; at: Date },
  ): Promise<string | null>
}

const OPEN: FinderVerdict = { status: 'open', decided: 0, noise: 0, share: null, open: 0, mutedUntil: null }

export async function readGate(
  deps: { uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads }> },
  input: { loop: FindingLoop; now: Date },
): Promise<Result<FinderGate, PortError>> {
  const read = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.classIssues(input.loop)))
  if (!read.ok) return read
  const verdicts = new Map(Object.entries(read.value).map(([name, issues]) => [name, verdictOf(issues, input.now)]))
  const claimed = new Set<string>()
  return ok({
    allows(key) {
      const name = finderOf(input.loop, key)
      if (!mayFile(verdicts.get(name) ?? OPEN, claimed.has(name))) return false
      claimed.add(name)
      return true
    },
    async record(issue, key, repo, filed) {
      if (issue === null) return null
      const recorded = await deps.uow.run(async ({ loops }) => {
        await loops.recordFinding({
          issue,
          loop: input.loop,
          repo,
          class: finderOf(input.loop, key),
          key,
          signal: filed.signal,
          filedAt: filed.at,
          figure: filed.figure,
        })
        return ok(undefined)
      })
      return recorded.ok ? null : `${recorded.error.kind}: ${recorded.error.detail}`
    },
  })
}
