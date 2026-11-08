import {
  DaysQuery,
  DEFAULT_DAYS,
  ErrorBody,
  FlowModel,
  FrictionModel,
  KpiModel,
  MachineModel,
  NeedsModel,
  ChainModel,
  type QueueReason as QueueReasonSchema,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { Elysia } from 'elysia'
import type * as z from 'zod'
import { readChain } from '../read/chain.ts'
import { type QueueReasons, readFlow } from '../read/flow.ts'
import { readFriction } from '../read/friction.ts'
import { readKpis } from '../read/kpis.ts'
import { needsModel, readNeeds } from '../read/needs.ts'
import { callerOf } from './auth.ts'
import { errorResponses } from './errors.ts'
import type { Caller } from './policy.ts'

/** What the read models read from: the database, and the reasons the capacity use case gives queued Issues. */
export interface ReadModelDeps {
  sql: SQL
  /** why each queued Issue stays queued; absent or failing, the Flow screen shows the Issues without a reason */
  queueReasons?: () => Promise<QueueReasons | null>
  /** the host's load and memory with the admission ceilings; null when the capacity use case cannot read them */
  machine?: () => Promise<Omit<MachineModel, 'at'> | null>
  now?: () => Date
}

/** `QueueReason` of the contract from the capacity use case's entries (`main.ts` binds it). */
export const queueReasonMap = (
  entries: readonly {
    issue: string
    reason: { kind: z.infer<typeof QueueReasonSchema>['kind']; message: string; opensAt: Date | null } | null
  }[],
): QueueReasons =>
  new Map(
    entries.flatMap((entry) =>
      entry.reason
        ? [[entry.issue, { ...entry.reason, opensAt: entry.reason.opensAt?.toISOString() ?? null }] as const]
        : [],
    ),
  )

const unavailable = Response.json(
  ErrorBody.parse({ error: 'the read models are not wired in this process', code: 'unavailable' }),
  { status: 503 },
)

const noMachine = () =>
  Response.json(ErrorBody.parse({ error: 'the host cannot be read in this process', code: 'unavailable' }), {
    status: 503,
  })

/**
 * The Console's computed screens, all `GET /v1/*`: what waits on the owner, the Issues by state, the chain, the KPIs and
 * the friction. `caller` says who is reading; the read token gets work-repo text replaced. Unbound (the OpenAPI document
 * alone), the routes answer 503.
 */
export const readModelRoutes = (deps: ReadModelDeps | undefined, caller: (request: Request) => Caller = callerOf) => {
  const now = () => (deps?.now ?? (() => new Date()))()
  const days = (query: { days?: string | undefined }) => (query.days === undefined ? DEFAULT_DAYS : Number(query.days))
  return new Elysia({ prefix: '/v1' })
    .get(
      '/needs',
      async ({ request }) => {
        if (!deps) return unavailable
        const needs = await readNeeds(deps.sql, now())
        return Response.json(NeedsModel.parse(needsModel(needs, { redact: caller(request) === 'read' })))
      },
      {
        response: { 200: NeedsModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.needs',
          summary:
            'everything that waits on the owner: open Decisions, artifacts awaiting a verdict, open Errands and held signals, newest first within a kind',
        },
      },
    )
    .get(
      '/flow',
      async ({ request }) => {
        if (!deps) return unavailable
        const queue = await deps.queueReasons?.().catch(() => null)
        const redact = caller(request) === 'read'
        return Response.json(
          FlowModel.parse(await readFlow(deps.sql, { now: now(), queue: queue ?? undefined, redact })),
        )
      },
      {
        response: { 200: FlowModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.flow',
          summary:
            'the Issues by state (settling, queued, working, waiting, watching), what closed in the last day, counts per project and the queue state per scope',
        },
      },
    )
    .get(
      '/machine',
      async () => {
        if (!deps) return unavailable
        const machine = await deps.machine?.().catch(() => null)
        if (!machine) return noMachine()
        return Response.json(MachineModel.parse({ at: now().toISOString(), ...machine }))
      },
      {
        response: { 200: MachineModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.machine',
          summary:
            "the host's 1-minute load and swap use with the ceilings above which no new lead is admitted; a reading that failed is null",
        },
      },
    )
    .get(
      '/chain',
      async ({ request }) => {
        if (!deps) return unavailable
        return Response.json(ChainModel.parse(await readChain(deps.sql, now(), { redact: caller(request) === 'read' })))
      },
      {
        response: { 200: ChainModel, ...errorResponses(503) },
        detail: {
          operationId: 'read.chain',
          summary:
            'the dependency chain across projects: open Issues and plan rows not yet filed as nodes, after edges, and what blocks each queued Issue now',
        },
      },
    )
    .get(
      '/kpis',
      async ({ query }) => {
        if (!deps) return unavailable
        return Response.json(KpiModel.parse(await readKpis(deps.sql, { now: now(), days: days(query) })))
      },
      {
        query: DaysQuery,
        response: { 200: KpiModel, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'read.kpis',
          summary:
            'the KPI table over the last days (1 to 90, default 7), each with its value, sample size, target, whether it is measured, and what exactly was counted',
        },
      },
    )
    .get(
      '/friction',
      async ({ query }) => {
        if (!deps) return unavailable
        return Response.json(FrictionModel.parse(await readFriction(deps.sql, { now: now(), days: days(query) })))
      },
      {
        query: DaysQuery,
        response: { 200: FrictionModel, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'read.friction',
          summary:
            'counted waste over the last days (1 to 90, default 7): avoidable touches, refusals, stalls, lost leads, undelivered notes, unreviewed ships, regressions, who settled Decisions, held signals',
        },
      },
    )
}
