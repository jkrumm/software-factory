import {
  AlertRequest,
  cleanText,
  DoorReport,
  DoorReportAck,
  DoorRoute,
  DoorRouteInput,
  DoorRouteList,
  ErrorBody,
  FeedbackRequest,
  PromoteRequest,
  SignalAck,
  SignalList,
  SignalRequest,
  StoredSignal,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { Intake, IntakeError } from '../app/intake.ts'
import type { Triaged } from '../domains/intake/model.ts'
import type { DoorRouteRow, SignalRow } from '../domains/intake/ports.ts'
import { type Result } from '../kernel/result.ts'
import { redactSignals } from '../read/signals.ts'
import { callerOf } from './auth.ts'
import { errorResponses } from './errors.ts'

/** The use cases the routes call, bound in `main.ts`. */
export type IntakeApi = Pick<
  Intake,
  'file' | 'alert' | 'feedback' | 'promote' | 'list' | 'doorReport' | 'routes' | 'setRoute' | 'removeRoute'
>

const failure = (error: string, code: string): ErrorBody => ErrorBody.parse({ error, code })

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function problem(error: IntakeError): Response {
  switch (error.kind) {
    case 'not_found':
      return json(404, failure(error.detail, 'not_found'))
    case 'unknown_issue':
      return json(404, failure(`no Issue ${error.issueId}`, 'not_found'))
    case 'not_held':
    case 'key_taken':
    case 'version_conflict':
      return json(409, failure('detail' in error ? error.detail : `${error.kind}; try again`, error.kind))
    case 'trust_refused':
      return json(403, failure(error.detail, 'trust_refused'))
    case 'no_repo':
    case 'unknown_project':
    case 'filing_refused':
      return json(422, failure(error.detail, error.kind))
    default:
      return json(503, failure(`the factory could not take it: ${error.detail}`, 'unavailable'))
  }
}

const answer = <T>(result: Result<T, IntakeError>, ok: (value: T) => unknown): Response =>
  result.ok ? json(200, ok(result.value)) : problem(result.error)

const ackOf = (t: Triaged): SignalAck => SignalAck.parse(t)

const storedOf = (row: SignalRow): StoredSignal =>
  StoredSignal.parse({
    id: row.id,
    source: row.received.signal.source,
    kind: row.received.signal.kind,
    origin: row.received.signal.origin,
    trust: row.received.signal.trust,
    repo: row.received.signal.repo,
    title: row.received.signal.title,
    text: row.received.signal.text,
    link: row.received.signal.link,
    receivedAt: row.receivedAt.toISOString(),
    state: row.state,
    issue: row.issueId,
    redacted: false,
  })

const routeOf = (row: DoorRouteRow): DoorRoute =>
  DoorRoute.parse({
    source: row.source,
    monitor: row.monitor,
    repo: row.repo,
    quiet: row.quiet,
    lastQuietAt: row.lastQuietAt?.toISOString() ?? null,
  })

const RESPONSES = { 200: SignalAck, ...errorResponses(400, 404, 409, 422, 503) }

/** Used when the app is built without intake (the OpenAPI document, tests of other routes): every call is a 503. */
export const unwiredIntake: IntakeApi = (() => {
  const unavailable = () =>
    Promise.resolve({ ok: false as const, error: { kind: 'gone' as const, detail: 'intake is not wired' } })
  return {
    file: unavailable,
    alert: unavailable,
    feedback: unavailable,
    promote: unavailable,
    list: unavailable,
    doorReport: unavailable,
    routes: unavailable,
    setRoute: unavailable,
    removeRoute: unavailable,
  }
})()

/**
 * Signals in, and the door's registry. `POST /signals` is `factory signal`'s entry (the owner, Hermes, agents, an app): the
 * token decides the trust and the claimed `from` can only lower it;
 * `POST /signals/alerts` and `POST /signals/feedback` are the door's, and their bodies are strict: a repo in one is a 400, because the door's routes pick
 * the repo and nothing in a payload does.
 */
export const intakeRoutes = (api: IntakeApi) =>
  new Elysia()
    .post('/signals', async ({ body, request }) => answer(await api.file(body, callerOf(request)), ackOf), {
      body: SignalRequest,
      response: RESPONSES,
      detail: { operationId: 'signal.file', summary: 'Put work in: an owner, agent or feedback signal' },
    })
    .post('/signals/alerts', async ({ body }) => answer(await api.alert(body), ackOf), {
      body: AlertRequest,
      response: RESPONSES,
      detail: { operationId: 'signal.alert', summary: "The door's entry: one alert of a monitoring source" },
    })
    .post('/signals/feedback', async ({ body }) => answer(await api.feedback(body), ackOf), {
      body: FeedbackRequest,
      response: RESPONSES,
      detail: { operationId: 'signal.feedback', summary: "The door's entry: one piece of an app's feedback" },
    })
    .get(
      '/v1/signals',
      async ({ query, request }) =>
        answer(await api.list(query.state ?? null), (rows) => {
          const signals = rows.map(storedOf)
          return SignalList.parse({ signals: callerOf(request) === 'read' ? redactSignals(signals) : signals })
        }),
      {
        query: z.object({ state: z.enum(['held', 'filed', 'amended', 'incident', 'promoted']).optional() }),
        response: { 200: SignalList, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'signal.list',
          summary: 'The stored signals, a state first: held ones wait for promotion',
        },
      },
    )
    .post('/signals/:id/promote', async ({ params, body }) => answer(await api.promote(params.id, body), ackOf), {
      params: z.object({ id: z.string() }),
      body: PromoteRequest,
      response: RESPONSES,
      detail: { operationId: 'signal.promote', summary: 'Let a held signal become work' },
    })
    .get(
      '/door/routes',
      async () =>
        answer(await api.routes(), (value) =>
          DoorRouteList.parse({
            routes: value.routes.map(routeOf),
            unrouted: value.unrouted.map((row) => ({
              source: row.source,
              monitor: row.monitor,
              count: row.count,
              lastSeen: row.lastSeen.toISOString(),
              lastTitle: row.lastTitle,
              status: row.status,
              downSince: row.downSince?.toISOString() ?? null,
              group: row.group,
              issue: row.filedIssue,
            })),
          }),
        ),
      {
        response: { 200: DoorRouteList, ...errorResponses(503) },
        detail: { operationId: 'door.routes', summary: "The door's routes, and the monitors that alerted with none" },
      },
    )
    .post(
      '/door/routes',
      async ({ body }) => answer(await api.setRoute({ ...body, monitor: cleanText(body.monitor) }), routeOf),
      {
        body: DoorRouteInput,
        response: { 200: DoorRoute, ...errorResponses(400, 404, 422, 503) },
        detail: { operationId: 'door.route-set', summary: 'Route a monitor to a repo' },
      },
    )
    .post('/door/routes/remove', async ({ body }) => answer(await api.removeRoute(body), routeOf), {
      body: z.strictObject({ source: z.string().min(1), monitor: z.string().min(1) }).meta({ id: 'DoorRouteKey' }),
      response: { 200: DoorRoute, ...errorResponses(400, 404, 422, 503) },
      detail: { operationId: 'door.route-remove', summary: 'Remove a monitor route' },
    })
    .post(
      '/door/reports',
      async ({ body }) => answer(await api.doorReport(body), () => DoorReportAck.parse({ ok: true })),
      {
        body: DoorReport,
        response: { 200: DoorReportAck, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'door.report',
          summary: 'What the door says about its sources (start, refused, accepted)',
        },
      },
    )
