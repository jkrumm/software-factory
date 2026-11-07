import type { QualityView } from '../domains/quality/store.ts'
import type { IssueId } from '../kernel/ids.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'
import type { IssueWriteError } from './issues.ts'
import type { QualityUnit } from './quality-ship.ts'

/** What the ship gate and the watch recorded for an Issue, newest last. */
export function showQuality(
  deps: { uow: QualityUnit },
  issueId: IssueId,
): Promise<Result<QualityView, IssueWriteError | PortError>> {
  return deps.uow.run(async ({ work, quality }) => {
    if (!(await work.history(issueId))) return err<IssueWriteError>({ kind: 'unknown_issue', issueId })
    return ok(await quality.view(issueId))
  })
}
