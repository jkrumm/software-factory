import { ErrorBody, InternalTestEventAnswer, InternalTestEventBody } from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { EventInput, IssueWriteError, Recorded } from '../app/issues.ts'
import { type IssueEvent, parseIssueEvent } from '../domains/work/events.ts'
import { idOf } from '../kernel/ids.ts'
import { type Key, keyOf } from '../kernel/keys.ts'
import type { PortError, Result } from '../kernel/result.ts'
import { errorResponses } from './errors.ts'

type Written = Result<Recorded, IssueWriteError | PortError>

/** The use cases the route calls, bound in `main.ts`. */
export interface InternalTestWrites {
  file(input: { key: Key; event: IssueEvent<'filed'> }): Promise<Written>
  record(input: EventInput): Promise<Written>
}

const failure = (error: string, code: string): ErrorBody => ErrorBody.parse({ error, code })

const answerOf = ({ result, issue, event, effects }: Recorded): InternalTestEventAnswer =>
  InternalTestEventAnswer.parse({
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
    effects: effects.map((effect) => ({ kind: effect.kind, key: effect.key })),
  })

type Answer = { status: 200; body: InternalTestEventAnswer } | { status: 404 | 409 | 503; body: ErrorBody }

function answer(written: Written): Answer {
  if (written.ok) return { status: 200, body: answerOf(written.value) }
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

const RESPONSES = { 200: InternalTestEventAnswer, ...errorResponses(400, 404, 409, 422, 503) }

/**
 * `POST /internal/test/issues` files an Issue, `POST /internal/test/issues/:id/events` records an event on one: the
 * scenarios' entry into the write path (the owner's token, like every route). Mounted only when
 * `FACTORY_INTERNAL_TEST_ROUTES=1`, so the OpenAPI document and the generated CLI never have it.
 */
export const internalTestRoutes = (writes: InternalTestWrites) =>
  new Elysia({ prefix: '/internal/test/issues' })
    .post(
      '/',
      async ({ body, status }) => {
        const key = keyOf(body.key)
        const event = parseIssueEvent({ kind: body.kind, payload: body.payload, actor: body.actor })
        if (!key || typeof event === 'string' || event.kind !== 'filed') {
          return status(
            400,
            failure(typeof event === 'string' ? event : 'POST a filed event with a key', 'invalid_request'),
          )
        }
        const out = answer(await writes.file({ key, event }))
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
      { body: InternalTestEventBody, response: RESPONSES, detail: { operationId: 'internal-test.file' } },
    )
    .post(
      '/:id/events',
      async ({ params, body, status }) => {
        const issueId = idOf('issue', params.id)
        const key = keyOf(body.key)
        const event = parseIssueEvent({ kind: body.kind, payload: body.payload, actor: body.actor })
        if (!issueId) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        if (!key || typeof event === 'string') {
          return status(400, failure(typeof event === 'string' ? event : 'a key is required', 'invalid_request'))
        }
        const out = answer(await writes.record({ issueId, key, event }))
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
        body: InternalTestEventBody,
        response: RESPONSES,
        detail: { operationId: 'internal-test.record' },
      },
    )
