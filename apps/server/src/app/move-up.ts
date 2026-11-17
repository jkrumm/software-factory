import { LIGHT_ROLE, moveUpWhy } from '../domains/leads/light.ts'
import type { QualityStore } from '../domains/quality/store.ts'
import { replay } from '../domains/work/machine.ts'
import type { WorkStore } from '../domains/work/ports.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import { ok, type Result } from '../kernel/result.ts'
import { type IssueWriteError, type Recorded, recordIn, type WriteDeps } from './issues.ts'

const attemptOf = (payload: unknown): number | null => {
  const value = (payload as { attempt?: unknown } | null)?.attempt
  return typeof value === 'number' ? value : null
}

/**
 * Moves a struggling light lead up, inside the caller's transaction, right after what it struggled with was stored: its
 * second stall (or one that says it is out of its depth), its second refused ship, or a regression of its first watch
 * (`regressedWatch`: the caller records `moved_up` in place of the `regressed` it would send). Reads the attempt from the
 * Issue's events and the refused ships from quality. Null: the rule does not move it, and nothing was written.
 */
export async function moveUpIfDue(
  /** `quality` absent: the trigger is a regression, whose caller has no quality store; earlier refusals moved it up already */
  stores: { work: WorkStore; quality?: Pick<QualityStore, 'refusedShips'> },
  deps: WriteDeps,
  input: { issueId: IssueId; regressedWatch?: number | null },
): Promise<Result<Recorded | null, IssueWriteError>> {
  const history = await stores.work.history(input.issueId)
  if (!history) return ok(null)
  const issue = replay(input.issueId, history)
  if (issue.state === 'closed' || issue.ranOn?.role !== LIGHT_ROLE) return ok(null)
  const stalls = history.filter(
    (record) =>
      record.kind === 'stalled' &&
      attemptOf(record.payload) === issue.attempt &&
      (record.payload as { cause?: unknown }).cause !== 'wall',
  )
  const why = moveUpWhy({
    light: true,
    stalls: stalls.length,
    outOfDepth: stalls.some((record) => (record.payload as { depth?: unknown }).depth === true),
    shipRefusals: stores.quality ? await stores.quality.refusedShips(input.issueId, issue.attempt) : 0,
    regressedWatch: input.regressedWatch ?? null,
  })
  if (!why) return ok(null)
  const recorded = await recordIn(stores.work, deps, {
    issueId: input.issueId,
    key: key('moved_up', input.issueId, issue.attempt),
    event: { kind: 'moved_up', payload: { attempt: issue.attempt, why }, actor: 'factory' },
  })
  return recorded.ok ? ok(recorded.value) : recorded
}
