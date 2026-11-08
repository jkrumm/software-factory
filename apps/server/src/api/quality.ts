import {
  ErrorBody,
  QualityView as QualityViewBody,
  ReopenAnswer,
  ReopenBody,
  ShipAnswer as ShipAnswerBody,
  ShipBody,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { IssueWriteError, Recorded } from '../app/issues.ts'
import type { ShipAnswer, ShipInput } from '../app/quality-ship.ts'
import { parseAcceptance } from '../domains/quality/evidence.ts'
import type { StoredEvidence, QualityView } from '../domains/quality/store.ts'
import type { OwnerActor } from '../kernel/events.ts'
import type { IssueId } from '../kernel/ids.ts'
import { err, portError, type PortError, type Result } from '../kernel/result.ts'
import { ownerActorOf } from './auth.ts'
import { errorResponses } from './errors.ts'
import { issueRef } from './issue-ref.ts'

/** The quality use cases the routes call, bound in `main.ts`. */
export interface QualityWrites {
  ship(input: ShipInput): Promise<Result<ShipAnswer, IssueWriteError | PortError>>
  reopen(input: {
    issueId: IssueId
    call: string
    reason: string
    actor: OwnerActor
  }): Promise<Result<Recorded, IssueWriteError | PortError>>
  show(issueId: IssueId): Promise<Result<QualityView, IssueWriteError | PortError>>
}

/**
 * The use cases when none are wired: every call answers that the database is unavailable. The CLI generator and the API
 * tests build the app this way, to read its OpenAPI document and its shapes; `main.ts` always wires the real ones.
 */
export const unwiredQuality: QualityWrites = {
  ship: async () => err(portError('gone', 'quality is not wired')),
  reopen: async () => err(portError('gone', 'quality is not wired')),
  show: async () => err(portError('gone', 'quality is not wired')),
}

const failure = (error: string, code: string): ErrorBody => ErrorBody.parse({ error, code })

const issueOf = (issue: Recorded['issue']) => ({
  id: issue.id,
  state: issue.state,
  waitReason: issue.wait?.reason ?? null,
  outcome: issue.outcome,
  version: issue.version,
})

const evidenceOf = (one: StoredEvidence) => {
  switch (one.kind) {
    case 'commits':
      return { kind: 'commits' as const, ...one.payload }
    case 'review':
      return { kind: 'review' as const, ...one.payload }
    case 'acceptance':
      return { kind: 'acceptance' as const, ...one.payload }
  }
}

type Failed = { status: 404 | 409 | 503; body: ErrorBody }

function failed(error: IssueWriteError | PortError): Failed {
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

const REFUSED = (detail: string | null) => failure(detail ?? 'the Issue refused it', 'refused')

const Params = z.object({ id: z.string() })

/**
 * `POST /issues/:id/ship` is the lead's verb, `POST /issues/:id/reopen` the owner's, `GET /issues/:id/quality` what
 * the gate and the watch recorded. A refusal is a 409 with the verb's error named, which the CLI exits 5 on.
 */
export const qualityRoutes = (writes: QualityWrites) =>
  new Elysia({ prefix: '/issues' })
    .post(
      '/:id/ship',
      async ({ params, body, status }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const acceptance = parseAcceptance(body.acceptance ?? [])
        if (!acceptance.ok) return status(422, failure(acceptance.error, 'invalid'))
        const shipped = await writes.ship({
          issueId,
          attempt: body.attempt,
          call: body.call,
          commits: [...(body.commits ?? []), ...(body.commit ?? [])],
          acceptance: acceptance.evidence,
        })
        if (!shipped.ok) {
          const out = failed(shipped.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        const { result, detail, issue, evidence } = shipped.value
        if (result === 'refused') return status(409, REFUSED(detail))
        return status(200, ShipAnswerBody.parse({ result, issue: issueOf(issue), evidence: evidence.map(evidenceOf) }))
      },
      {
        params: Params,
        body: ShipBody,
        response: { 200: ShipAnswerBody, ...errorResponses(400, 404, 409, 422, 503) },
        detail: { operationId: 'issue.ship', summary: "the lead's ship: the merged commits, checked, as evidence" },
      },
    )
    .post(
      '/:id/reopen',
      async ({ params, body, request, status }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const reopened = await writes.reopen({
          issueId,
          call: body.call,
          reason: body.reason,
          actor: ownerActorOf(request),
        })
        if (!reopened.ok) {
          const out = failed(reopened.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        const { result, event, issue } = reopened.value
        const ended = result === 'replayed' ? event.result : result
        if (ended === 'refused' || ended === 'ignored') return status(409, REFUSED(event.detail))
        return status(
          200,
          ReopenAnswer.parse({ result: result === 'applied' ? 'applied' : 'replayed', issue: issueOf(issue) }),
        )
      },
      {
        params: Params,
        body: ReopenBody,
        response: { 200: ReopenAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: { operationId: 'issue.reopen', summary: "the owner's reopen of a closed Issue, within 30 days" },
      },
    )
    .get(
      '/:id/quality',
      async ({ params, status }) => {
        const issueId = issueRef(params.id)
        if (!issueId) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const shown = await writes.show(issueId)
        if (!shown.ok) {
          const out = failed(shown.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        return status(
          200,
          QualityViewBody.parse({
            ships: shown.value.ships.map((ship) => ({
              attempt: ship.attempt,
              call: ship.eventKey,
              at: ship.at.toISOString(),
              result: ship.result,
              detail: ship.detail,
              commits: ship.reported,
              evidence: ship.evidence.map(evidenceOf),
            })),
            watches: shown.value.watches.map((watch) => ({
              watch: watch.watch,
              attempt: watch.attempt,
              startedAt: watch.startedAt.toISOString(),
              windowMs: watch.windowMs,
              answer: watch.answer,
              checks: watch.checks.map((check) => ({ ...check, at: check.at.toISOString() })),
            })),
          }),
        )
      },
      {
        params: Params,
        response: { 200: QualityViewBody, ...errorResponses(404, 409, 503) },
        detail: { operationId: 'issue.quality', summary: 'what the ship gate and the watch recorded for an Issue' },
      },
    )
