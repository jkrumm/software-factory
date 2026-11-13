import type { BlockBody, CloseBody, DeferBody } from '@software-factory/contract'
import type { AnyIssueEvent } from '../domains/work/events.ts'
import type { IssueId } from '../kernel/ids.ts'
import { key } from '../kernel/keys.ts'
import type { PortError, Result } from '../kernel/result.ts'
import type { IssueWriteError, IssueWrites, Recorded, WriteDeps } from './issues.ts'
import { recordIssueEvent } from './issues.ts'

type Deps = WriteDeps & { uow: IssueWrites }
type Written = Result<Recorded, IssueWriteError | PortError>

/**
 * The lead's own verbs: each is an event the Issue's machine decides, with the lead as its actor and the attempt it
 * speaks for. The call id (or one made now) is in the key, so a repeated call is one event; a verb of an earlier
 * attempt is refused by the machine. Ship and the evidence belong to quality, Decisions and Errands to checkpoints.
 */
function verb(
  deps: Deps,
  issueId: IssueId,
  name: string,
  attempt: number,
  call: string | undefined,
  event: AnyIssueEvent,
): Promise<Written> {
  return recordIssueEvent(deps, {
    issueId,
    key: key(issueId, attempt, name, call ?? deps.ids.next('call')),
    event,
  })
}

/** The lead ends its work without a watch: done (nothing to deploy) or dropped. */
export const closeIssue = (deps: Deps, issueId: IssueId, body: CloseBody): Promise<Written> =>
  verb(deps, issueId, 'close', body.attempt, body.call, {
    kind: 'closed',
    payload: { attempt: body.attempt, outcome: body.outcome, reason: body.reason },
    actor: 'lead',
  })

/** The lead waits until a time, or until other Issues close. */
export const deferIssue = (deps: Deps, issueId: IssueId, body: DeferBody): Promise<Written> =>
  verb(deps, issueId, 'defer', body.attempt, body.call, {
    kind: 'deferred',
    payload: body.until
      ? { attempt: body.attempt, until: body.until }
      : body.review
        ? { attempt: body.attempt, review: body.review }
        : { attempt: body.attempt, after: (body.after ?? []) as IssueId[] },
    actor: 'lead',
  })

/** The lead cannot go on and nobody can answer: a stall the steward re-checks. */
export const blockIssue = (deps: Deps, issueId: IssueId, body: BlockBody): Promise<Written> =>
  verb(deps, issueId, 'block', body.attempt, body.call, {
    kind: 'stalled',
    payload: { attempt: body.attempt, cause: 'blocked', detail: body.reason },
    actor: 'lead',
  })
