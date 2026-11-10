import {
  ChangeList,
  ErrorBody,
  ReadAccountList,
  ISSUE_ID_META,
  ReadAskList,
  ReadHealthList,
  ReadIssueCards,
  ReadIssueDetail,
  ReadOverview,
  ReadSessionCard,
  ReadSessionCards,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import { type ReadApi } from '../read/reader.ts'
import { issueRefOf } from '../read/sessions.ts'
import { CursorGone, streamResponse } from '../read/stream.ts'
import { callerOf } from './auth.ts'
import { errorResponses } from './errors.ts'

const failure = (status: number, error: string, code: string): Response =>
  Response.json(ErrorBody.parse({ error, code }), { status })

const unavailable = () => failure(503, 'the read API is not wired in this process', 'unavailable')

const gone = (error: CursorGone): Response => failure(410, error.message, 'cursor_gone')

/** 410 on top of the 400, 404 and 503 the other routes declare. */
const withGone = { ...errorResponses(400, 404, 503), 410: ErrorBody }

const Id = z.object({ id: z.string() })

/** The read token's callers get a work repo's text redacted (`read/surface.ts`). */
const surfaceOf = (request: Request) => ({ redact: callerOf(request) === 'read' })

/**
 * The read API (`/v1`, `docs/architecture.md`) and the change stream. GET only; the policy lets the owner, an
 * agent and the read token through (`api/policy.ts`, `GET /v1/*`). Unbound (the OpenAPI document alone), the routes answer 503.
 */
export const readRoutes = (read: ReadApi | undefined) =>
  new Elysia({ prefix: '/v1' })
    .get(
      '/overview',
      async ({ request }) =>
        read ? Response.json(ReadOverview.parse(await read.overview(surfaceOf(request)))) : unavailable(),
      {
        response: { 200: ReadOverview, ...errorResponses(503) },
        detail: {
          operationId: 'read.overview',
          summary: 'counts, what waits on the owner, health lines, accounts, the queue state and the open Issues',
        },
      },
    )
    .get(
      '/issues',
      async ({ request, query }) => {
        if (!read) return unavailable()
        const issues = await read.issues({
          ...surfaceOf(request),
          scope: query.state ?? 'open',
          limit: query.limit,
          repo: query.repo,
        })
        return Response.json(ReadIssueCards.parse({ issues }))
      },
      {
        query: z.object({
          state: z.enum(['open', 'closed', 'all']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          repo: z.string().min(1).max(200).optional(),
        }),
        response: { 200: ReadIssueCards, ...errorResponses(400, 503) },
        detail: { operationId: 'issue.list', summary: 'Issue cards, newest activity first' },
      },
    )
    .get(
      '/issues/:id',
      async ({ request, params }) => {
        if (!read) return unavailable()
        if (!issueRefOf(params.id))
          return failure(400, `${params.id} is not an Issue (issue_12 or 12)`, 'invalid_request')
        const detail = await read.issue({ ...surfaceOf(request), id: params.id })
        return detail
          ? Response.json(ReadIssueDetail.parse(detail))
          : failure(404, `no Issue ${params.id}`, 'not_found')
      },
      {
        params: Id,
        response: { 200: ReadIssueDetail, ...errorResponses(400, 404, 503) },
        detail: {
          operationId: 'issue.show',
          summary: 'one Issue with its timeline, evidence, asks and sessions (issue_12 or 12)',
        },
      },
    )
    .get(
      '/sessions',
      async ({ request, query }) => {
        if (!read) return unavailable()
        const sessions = await read.sessions({
          ...surfaceOf(request),
          issue: query.issue,
          role: query.role,
          live: query.live === '1',
        })
        if (sessions === null) return failure(400, `${query.issue} is not an Issue (issue_12 or 12)`, 'invalid_request')
        return Response.json(ReadSessionCards.parse({ sessions }))
      },
      {
        query: z.object({
          issue: z.string().meta(ISSUE_ID_META).optional(),
          role: z.string().optional(),
          live: z.enum(['1']).optional(),
        }),
        response: { 200: ReadSessionCards, ...errorResponses(400, 503) },
        detail: {
          operationId: 'read.sessions',
          summary: "lead sessions: an Issue's, or the newest; live=1 leaves ended ones out",
        },
      },
    )
    .get(
      '/sessions/:id',
      async ({ request, params }) => {
        if (!read) return unavailable()
        const card = await read.session({ ...surfaceOf(request), id: params.id })
        return card ? Response.json(ReadSessionCard.parse(card)) : failure(404, `no session ${params.id}`, 'not_found')
      },
      {
        params: Id,
        response: { 200: ReadSessionCard, ...errorResponses(404, 503) },
        detail: { operationId: 'read.session', summary: 'one lead session by its key (lead-<n>-<attempt>)' },
      },
    )
    .get(
      '/asks',
      async ({ request }) =>
        read ? Response.json(ReadAskList.parse(await read.asks(surfaceOf(request)))) : unavailable(),
      {
        response: { 200: ReadAskList, ...errorResponses(503) },
        detail: {
          operationId: 'read.asks',
          summary: 'what waits on the owner, and the open Errands',
        },
      },
    )
    .get(
      '/health',
      async ({ request }) =>
        read ? Response.json(ReadHealthList.parse({ health: await read.health(surfaceOf(request)) })) : unavailable(),
      {
        response: { 200: ReadHealthList, ...errorResponses(503) },
        detail: {
          operationId: 'read.health',
          summary: 'lines that need a look: the door, accounts, loops, a blocked checkout',
        },
      },
    )
    .get(
      '/accounts',
      async () => (read ? Response.json(ReadAccountList.parse({ accounts: await read.accounts() })) : unavailable()),
      {
        response: { 200: ReadAccountList, ...errorResponses(503) },
        detail: { operationId: 'read.accounts', summary: "each account's newest reading" },
      },
    )
    .get(
      '/changes',
      async ({ query }) => {
        if (!read) return unavailable()
        const issue = query.issue === undefined ? undefined : issueRefOf(query.issue)
        if (issue === null) return failure(400, `${query.issue} is not an Issue (issue_12 or 12)`, 'invalid_request')
        try {
          return Response.json(ChangeList.parse(await read.changes({ since: query.since, issue, limit: query.limit })))
        } catch (error) {
          if (error instanceof CursorGone) return gone(error)
          throw error
        }
      },
      {
        query: z.object({
          since: z.string().optional(),
          issue: z.string().meta(ISSUE_ID_META).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
        response: { 200: ChangeList, ...withGone },
        detail: {
          operationId: 'read.changes',
          summary: 'the changes after a cursor, as a poll; without since, no changes and the current cursor',
        },
      },
    )
    // The stream is server-sent events, not a JSON answer the CLI generator can parse: hidden from the document.
    .get(
      '/stream',
      async ({ request, query }) => {
        if (!read) return unavailable()
        const issue = query.issue === undefined ? undefined : issueRefOf(query.issue)
        if (issue === null) return failure(400, `${query.issue} is not an Issue (issue_12 or 12)`, 'invalid_request')
        const abort = new AbortController()
        request.signal.addEventListener('abort', () => abort.abort())
        try {
          const events = await read.stream({
            since: query.since ?? request.headers.get('last-event-id') ?? undefined,
            issue,
            signal: abort.signal,
          })
          return streamResponse(events, abort)
        } catch (error) {
          if (error instanceof CursorGone) return gone(error)
          throw error
        }
      },
      {
        query: z.object({ since: z.string().optional(), issue: z.string().meta(ISSUE_ID_META).optional() }),
        detail: { hide: true },
      },
    )
