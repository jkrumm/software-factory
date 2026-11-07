import type { AnyIssueEvent } from '../domains/work/events.ts'
import { replay } from '../domains/work/machine.ts'
import type { IssueId } from '../kernel/ids.ts'
import { type Key, key } from '../kernel/keys.ts'
import { err, type PortError, type Result } from '../kernel/result.ts'
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

/**
 * A signal that speaks for an Issue's change: a failed alert after the ship, feedback that the change broke something.
 * Intake correlates the signal and hands it over here with its own deterministic `signal` key.
 *
 * Watched, the Issue records `regressed` (back to its lead twice, the third a stall). Closed, a new fault reopens it:
 * `reopened` by the factory, and the machine refuses that past the 30 days. Any other state records `regressed`, which
 * the machine ignores with its reason: a lead that works it hears the signal as a note, not as a regression.
 */
export function reportRegression(
  deps: Deps,
  input: { issueId: IssueId; signal: Key; detail: string },
): Promise<Result<Recorded, IssueWriteError | PortError>> {
  const regressed = key('regressed', input.signal)
  const reopened = key('reopened', input.signal)
  return deps.uow.run(async ({ work }) => {
    // A signal seen before has its answer: the Issue may have moved on since, and the replay must not decide again.
    const earlier = (await work.eventByKey(regressed)) ?? (await work.eventByKey(reopened))
    if (earlier) {
      return recordIn(work, deps, {
        issueId: input.issueId,
        key: earlier.key,
        event: { kind: earlier.kind, payload: earlier.payload, actor: earlier.actor } as AnyIssueEvent,
      })
    }
    const history = await work.history(input.issueId)
    if (!history) return err<IssueWriteError>({ kind: 'unknown_issue', issueId: input.issueId })
    if (replay(input.issueId, history).state === 'closed') {
      return recordIn(work, deps, {
        issueId: input.issueId,
        key: reopened,
        event: { kind: 'reopened', payload: { reason: `regressed: ${input.detail}` }, actor: 'factory' },
      })
    }
    return recordIn(work, deps, {
      issueId: input.issueId,
      key: regressed,
      event: { kind: 'regressed', payload: { watch: null, detail: input.detail }, actor: 'factory' },
    })
  })
}
