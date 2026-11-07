import type { AnyIssueEvent } from '../domains/work/events.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import type { PortError, Result } from '../kernel/result.ts'
import { type IssueWriteError, type Recorded, recordIn, type WriteDeps } from './issues.ts'
import type { QualityUnit } from './quality-ship.ts'

type Deps = WriteDeps & { uow: QualityUnit }

/**
 * The owner's `reopen`, the only way out of `closed`. The machine refuses it when the Issue closed more than 30 days
 * ago, and the owner files a new Issue instead. The same call again is a replay.
 */
export function reopenIssue(
  deps: Deps,
  input: { issueId: IssueId; call: string; reason: string },
): Promise<Result<Recorded, IssueWriteError | PortError>> {
  const event: AnyIssueEvent = { kind: 'reopened', payload: { reason: input.reason }, actor: 'owner' }
  return deps.uow.run(({ work }) =>
    recordIn(work, deps, { issueId: input.issueId, key: key('reopened', input.issueId, input.call), event }),
  )
}
