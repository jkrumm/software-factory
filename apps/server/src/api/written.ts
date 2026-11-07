import { ErrorBody, LeadVerbAnswer } from '@software-factory/contract'
import type { IssueWriteError, Recorded } from '../app/issues.ts'
import type { PortError, Result } from '../kernel/result.ts'

export type Written = Result<Recorded, IssueWriteError | PortError>

export const failure = (error: string, code: string, details?: Record<string, unknown>): ErrorBody =>
  ErrorBody.parse({ error, code, ...(details ? { details } : {}) })

/** The error body and status of a write that did not land. */
export function writeFailure(error: IssueWriteError | PortError): { status: 404 | 409 | 503; body: ErrorBody } {
  switch (error.kind) {
    case 'unknown_issue':
      return { status: 404, body: failure(`no Issue ${error.issueId}`, 'not_found') }
    case 'version_conflict':
      return {
        status: 409,
        body: failure(`Issue ${error.issueId} moved past version ${error.expected}; try again`, 'version_conflict'),
      }
    case 'key_taken':
      return { status: 409, body: failure(`key ${error.key} is ${error.detail}`, 'key_taken') }
    case 'filing_refused':
      return { status: 409, body: failure(error.detail, 'refused') }
    default:
      return { status: 503, body: failure(`the database: ${error.detail}`, 'unavailable') }
  }
}

export const issueMove = ({ issue }: Pick<Recorded, 'issue'>) => ({
  id: issue.id,
  state: issue.state,
  waitReason: issue.wait?.reason ?? null,
  outcome: issue.outcome,
  version: issue.version,
})

/** A recorded verb as the answer: a refusal is a 409 with the machine's reason, an ignored or replayed one changed nothing and says so. */
export function verbResponse(written: Written): Response {
  if (!written.ok) {
    const out = writeFailure(written.error)
    return Response.json(out.body, { status: out.status })
  }
  const { result, event } = written.value
  if (result === 'refused') return Response.json(failure(event.detail ?? 'refused', 'refused'), { status: 409 })
  return Response.json(
    LeadVerbAnswer.parse({
      result,
      detail: event.detail,
      issue: issueMove(written.value),
      event: { id: event.id, key: event.key, version: event.version },
    }),
  )
}
