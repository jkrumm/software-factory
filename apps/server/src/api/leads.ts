import {
  BlockBody,
  CloseBody,
  DeferBody,
  ErrorBody,
  LeadSession,
  LeadVerbAnswer,
  type LeadSession as LeadSessionType,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { IssueWriteError, Recorded } from '../app/issues.ts'
import { idOf, type IssueId } from '../kernel/ids.ts'
import { err, portError, type PortError, type Result } from '../kernel/result.ts'

type Written = Result<Recorded, IssueWriteError | PortError>

/** The use cases the lead routes call, bound in `main.ts`. */
export interface LeadRoutes {
  close(issue: IssueId, body: CloseBody): Promise<Written>
  defer(issue: IssueId, body: DeferBody): Promise<Written>
  block(issue: IssueId, body: BlockBody): Promise<Written>
  session(issue: IssueId): Promise<Result<LeadSessionType | null, PortError>>
}

const failure = (error: string, code: string): ErrorBody => ErrorBody.parse({ error, code })

/** `issue_12`, or the bare number the owner says ("Issue 12"). */
function issueOf(text: string): IssueId | null {
  return idOf('issue', /^[1-9][0-9]*$/.test(text) ? `issue_${text}` : text)
}

const answerOf = ({ issue, event }: Recorded, result: Recorded['result']): LeadVerbAnswer =>
  LeadVerbAnswer.parse({
    result,
    detail: event.detail,
    issue: {
      id: issue.id,
      state: issue.state,
      waitReason: issue.wait?.reason ?? null,
      outcome: issue.outcome,
      version: issue.version,
    },
    event: { id: event.id, key: event.key, version: event.version },
  })

const VERB_RESPONSES = {
  200: LeadVerbAnswer,
  404: ErrorBody,
  409: ErrorBody,
  503: ErrorBody,
}

type Answer = { status: 200; body: LeadVerbAnswer } | { status: 404 | 409 | 503; body: ErrorBody }

/** A refused verb is a conflict with the Issue's state (exit 5); an ignored or replayed one changed nothing and says so. */
function answer(written: Written): Answer {
  if (written.ok) {
    const { result, event } = written.value
    if (result === 'refused') return { status: 409, body: failure(event.detail ?? 'refused', 'refused') }
    return { status: 200, body: answerOf(written.value, result) }
  }
  const e = written.error
  switch (e.kind) {
    case 'unknown_issue':
      return { status: 404, body: failure(`no Issue ${e.issueId}`, 'not_found') }
    case 'version_conflict':
      return {
        status: 409,
        body: failure(`Issue ${e.issueId} moved past version ${e.expected}; try again`, 'version_conflict'),
      }
    case 'key_taken':
      return { status: 409, body: failure(`key ${e.key} is ${e.detail}`, 'key_taken') }
    case 'filing_refused':
      return { status: 409, body: failure(e.detail, 'refused') }
    default:
      return { status: 503, body: failure(`the database: ${e.detail}`, 'unavailable') }
  }
}

/** A server built without the leads (the generator, a test of another route) still has the routes in its document. */
const unwired: LeadRoutes = {
  close: async () => err(portError('gone', 'the leads are not wired into this server')),
  defer: async () => err(portError('gone', 'the leads are not wired into this server')),
  block: async () => err(portError('gone', 'the leads are not wired into this server')),
  session: async () => err(portError('gone', 'the leads are not wired into this server')),
}

/**
 * The lead's verbs (`factory issue close|defer|block`) and the read of its session (`factory lead get`). No auth yet
 * (package 8 brings it): the routes bind loopback as the app does.
 */
export const leadRoutes = (wired: LeadRoutes | undefined) => {
  const routes = wired ?? unwired
  return new Elysia()
    .post(
      '/v1/issues/:id/close',
      async ({ params, body, status }) => {
        const issue = issueOf(params.id)
        if (!issue) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const out = answer(await routes.close(issue, body))
        switch (out.status) {
          case 200:
            return status(200, out.body)
          case 404:
            return status(404, out.body)
          case 409:
            return status(409, out.body)
          default:
            return status(503, out.body)
        }
      },
      {
        params: z.object({ id: z.string() }),
        body: CloseBody,
        response: VERB_RESPONSES,
        detail: { operationId: 'issue.close', summary: 'the lead ends its work without a watch: done or dropped' },
      },
    )
    .post(
      '/v1/issues/:id/defer',
      async ({ params, body, status }) => {
        const issue = issueOf(params.id)
        if (!issue) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const out = answer(await routes.defer(issue, body))
        switch (out.status) {
          case 200:
            return status(200, out.body)
          case 404:
            return status(404, out.body)
          case 409:
            return status(409, out.body)
          default:
            return status(503, out.body)
        }
      },
      {
        params: z.object({ id: z.string() }),
        body: DeferBody,
        response: VERB_RESPONSES,
        detail: { operationId: 'issue.defer', summary: 'the lead waits until a time, or until other Issues close' },
      },
    )
    .post(
      '/v1/issues/:id/block',
      async ({ params, body, status }) => {
        const issue = issueOf(params.id)
        if (!issue) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const out = answer(await routes.block(issue, body))
        switch (out.status) {
          case 200:
            return status(200, out.body)
          case 404:
            return status(404, out.body)
          case 409:
            return status(409, out.body)
          default:
            return status(503, out.body)
        }
      },
      {
        params: z.object({ id: z.string() }),
        body: BlockBody,
        response: VERB_RESPONSES,
        detail: { operationId: 'issue.block', summary: 'the lead cannot go on and nobody can answer: a stall' },
      },
    )
    .get(
      '/v1/issues/:id/lead',
      async ({ params, status }) => {
        const issue = issueOf(params.id)
        if (!issue) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const session = await routes.session(issue)
        if (!session.ok) return status(503, failure(`the database: ${session.error.detail}`, 'unavailable'))
        if (!session.value) return status(404, failure(`Issue ${issue} has no lead yet`, 'not_found'))
        return status(200, LeadSession.parse(session.value))
      },
      {
        params: z.object({ id: z.string() }),
        response: { 200: LeadSession, 404: ErrorBody, 503: ErrorBody },
        detail: { operationId: 'lead.get', summary: "the current attempt's lead and its session state" },
      },
    )
}
