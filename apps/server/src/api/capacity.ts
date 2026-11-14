import {
  AccountView,
  AdmitAnswer,
  CapacityView,
  ErrorBody,
  MergeWindow,
  QueueOrder,
  type QUEUE_REASONS,
  QueueSetBody,
  QueueStatesView,
  RefreshAnswer,
  Slot,
  SlotBody,
  SlotRelease,
  StepCost,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { CapacityLimits, PassResult, QueueEntry, QueueReasonKind } from '../app/capacity-admit.ts'
import type { AccountState, CapacityState } from '../app/capacity-view.ts'
import type { QueueState, QueueStates } from '../domains/capacity/queue-state.ts'
import type { SlotView } from '../domains/capacity/slots.ts'
import type { PortError, Result } from '../kernel/result.ts'
import { errorResponses } from './errors.ts'

/** The contract's list of reasons and the server's are one list: a reason added on one side fails `tsc` until it is on the other. */
const queueReasonsMatch: [(typeof QUEUE_REASONS)[number]] extends [QueueReasonKind]
  ? [QueueReasonKind] extends [(typeof QUEUE_REASONS)[number]]
    ? true
    : never
  : never = true
void queueReasonsMatch

/** The use cases the routes call, bound in `main.ts`. */
export interface CapacityApi {
  limits: CapacityLimits & { slots: number; slotsMax: number }
  state(): Promise<Result<CapacityState, PortError>>
  refresh(): Promise<Result<AccountState[], PortError>>
  admit(): Promise<Result<PassResult, PortError>>
  queue(): Promise<Result<{ queue: QueueEntry[]; notes: string[] }, PortError>>
  /** `project` (a name or a path inside a source root) narrows the answer to that project; a path outside the roots is `refused` */
  queueStates(project?: string): Promise<Result<QueueStates, PortError>>
  /** `project` is a name or a path inside a source root; a path outside the roots is `refused` */
  setQueueState(input: { project: string | null; state: QueueState }): Promise<Result<QueueStates, PortError>>
  touchSlot(input: {
    id: string
    name: string
    cwd: string | undefined
    limitMs: number | undefined
    rssMib: number | undefined
    peakRssMib: number | undefined
    holding: boolean | undefined
  }): Promise<Result<SlotView, PortError>>
  giveSlotBack(id: string): Promise<Result<boolean, PortError>>
  recordStepCost(cost: StepCost): Promise<Result<true, PortError>>
  recordMergeWindow(window: {
    project: string
    cwd?: string | undefined
    requestedAt: Date
    acquiredAt: Date | null
    releasedAt: Date
    exitCode: number | null
  }): Promise<Result<true, PortError>>
}

const failure = (error: string, code: string): ErrorBody => ErrorBody.parse({ error, code })
const unavailable = (error: PortError): ErrorBody => failure(`unavailable: ${error.detail}`, 'unavailable')
const outsideRoots = (error: PortError): ErrorBody => failure(error.detail, 'repo_outside_roots')
const iso = (at: Date | null): string | null => at?.toISOString() ?? null

const accountView = (a: AccountState): AccountView =>
  AccountView.parse({
    account: a.reading.account,
    enabled: a.reading.enabled,
    authOk: a.reading.authOk,
    fiveHourUsed: a.reading.fiveHourUsed,
    weeklyUsed: a.reading.weeklyUsed,
    fiveHourResetsAt: iso(a.reading.fiveHourResetsAt),
    weeklyResetsAt: iso(a.reading.weeklyResetsAt),
    exhaustedUntil: iso(a.reading.exhaustedUntil),
    sampledAt: iso(a.reading.sampledAt),
    readAt: a.reading.readAt.toISOString(),
    fresh: a.fresh,
    open: a.open,
    why: a.why,
    opensAt: iso(a.opensAt),
    rank: a.rank,
    rankReason: a.rankReason,
  })

const entryView = (entry: QueueEntry) => ({
  issue: entry.issue,
  repo: entry.repo,
  project: entry.project,
  kind: entry.kind,
  prio: entry.prio,
  reason: entry.reason
    ? { kind: entry.reason.kind, message: entry.reason.message, opensAt: iso(entry.reason.opensAt) }
    : null,
  account: entry.account,
})

const statesView = (states: QueueStates): QueueStatesView =>
  QueueStatesView.parse({ global: states.global, projects: Object.fromEntries(states.projects) })

const slotView = (slot: SlotView): Slot => Slot.parse(slot)

/**
 * Capacity: the accounts, the host, who holds which claim, the queue states, the admission pass, and the test slots. The
 * routes exist whether or not the use cases are bound (unbound they answer 503), so the OpenAPI document is the same
 * everywhere. The slot routes are the `factory slot run` wrapper's own, hand-written in the CLI, so they stay out of the
 * document.
 */
export const capacityRoutes = (api?: CapacityApi) => {
  const unbound = failure('capacity is not wired in this process', 'unavailable')
  return new Elysia()
    .get(
      '/capacity',
      async ({ status }) => {
        if (!api) return status(503, unbound)
        const state = await api.state()
        if (!state.ok) return status(503, unavailable(state.error))
        const s = state.value
        return status(
          200,
          CapacityView.parse({
            accounts: s.accounts.map(accountView),
            host: {
              load: s.host.load,
              loadCeiling: api.limits.loadCeiling,
              memory: s.host.memory,
              memoryCeilings: api.limits.memoryCeilings,
              notes: s.host.notes,
            },
            claims: s.claims.map((claim) => ({
              issue: claim.issue,
              repo: claim.repo,
              account: claim.account,
              urgent: claim.urgent,
              takenAt: claim.takenAt.toISOString(),
            })),
            rank: s.rank && {
              lane: s.rank.lane,
              at: s.rank.at.toISOString(),
              readAt: s.rank.readAt.toISOString(),
              fresh: s.rankFresh,
              order: s.rank.order,
            },
            leadsPerAccount: api.limits.leadsPerAccount,
            queue: statesView(s.states),
            slots: {
              total: api.limits.slots,
              max: api.limits.slotsMax,
              held: s.slots.flatMap((row) =>
                row.slot !== null && row.grantedAt
                  ? [{ slot: row.slot, name: row.name, grantedAt: row.grantedAt.toISOString() }]
                  : [],
              ),
              waiting: s.slots.filter((row) => row.slot === null).map((row) => row.name),
              lines: s.slotLines,
            },
          }),
        )
      },
      {
        response: { 200: CapacityView, ...errorResponses(503) },
        detail: {
          operationId: 'capacity.get',
          summary:
            'the accounts and their windows, the host, who holds which claim, the queue states and the test slots',
        },
      },
    )
    .post(
      '/capacity/refresh',
      async ({ status }) => {
        if (!api) return status(503, unbound)
        const polled = await api.refresh()
        return polled.ok
          ? status(200, RefreshAnswer.parse({ accounts: polled.value.map(accountView) }))
          : status(503, unavailable(polled.error))
      },
      {
        response: { 200: RefreshAnswer, ...errorResponses(503) },
        detail: { operationId: 'capacity.refresh', summary: 'poll the account picker now and store the readings' },
      },
    )
    .post(
      '/capacity/admit',
      async ({ status }) => {
        if (!api) return status(503, unbound)
        const pass = await api.admit()
        if (!pass.ok) return status(503, unavailable(pass.error))
        return status(
          200,
          AdmitAnswer.parse({
            admitted: pass.value.admitted,
            queue: pass.value.queue.map(entryView),
            notes: pass.value.notes,
          }),
        )
      },
      {
        response: { 200: AdmitAnswer, ...errorResponses(503) },
        detail: {
          operationId: 'capacity.admit',
          summary: 'admit every queued Issue that nothing keeps out, one at a time, and say why the others stay queued',
        },
      },
    )
    .get(
      '/queue/order',
      async ({ status }) => {
        if (!api) return status(503, unbound)
        const view = await api.queue()
        return view.ok
          ? status(200, QueueOrder.parse({ queue: view.value.queue.map(entryView), notes: view.value.notes }))
          : status(503, unavailable(view.error))
      },
      {
        response: { 200: QueueOrder, ...errorResponses(503) },
        detail: {
          operationId: 'queue.order',
          summary: 'the queued Issues in the order they are looked at, each with the reason it stays queued',
        },
      },
    )
    .get(
      '/queue',
      async ({ query, status }) => {
        if (!api) return status(503, unbound)
        const states = await api.queueStates(query.project)
        if (states.ok) return status(200, statesView(states.value))
        return states.error.kind === 'refused'
          ? status(422, outsideRoots(states.error))
          : status(503, unavailable(states.error))
      },
      {
        query: z.object({ project: z.string().min(1).optional() }),
        response: { 200: QueueStatesView, ...errorResponses(400, 422, 503) },
        detail: { operationId: 'queue.get', summary: 'the queue state per scope: run, pace or drain' },
      },
    )
    .put(
      '/queue',
      async ({ body, status }) => {
        if (!api) return status(503, unbound)
        const states = await api.setQueueState({ project: body.project, state: body.state })
        if (states.ok) return status(200, statesView(states.value))
        return states.error.kind === 'refused'
          ? status(422, outsideRoots(states.error))
          : status(503, unavailable(states.error))
      },
      {
        body: QueueSetBody,
        response: { 200: QueueStatesView, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'queue.set',
          summary: 'set the queue state of the whole queue or one project: run, pace or drain',
          'x-cli': { args: ['state'] },
        },
      },
    )
    .put(
      '/slots/:id',
      async ({ params, body, status }) => {
        if (!api) return status(503, unbound)
        const touched = await api.touchSlot({
          id: params.id,
          name: body.name,
          cwd: body.cwd,
          limitMs: body.limitMs,
          rssMib: body.rssMib,
          peakRssMib: body.peakRssMib,
          holding: body.holding,
        })
        return touched.ok ? status(200, slotView(touched.value)) : status(503, unavailable(touched.error))
      },
      {
        params: z.object({ id: z.string().min(1).max(200) }),
        body: SlotBody,
        response: { 200: Slot, ...errorResponses(400, 422, 503) },
        detail: { hide: true, operationId: 'slots.touch' },
      },
    )
    .delete(
      '/slots/:id',
      async ({ params, status }) => {
        if (!api) return status(503, unbound)
        const released = await api.giveSlotBack(params.id)
        return released.ok
          ? status(200, SlotRelease.parse({ released: released.value }))
          : status(503, unavailable(released.error))
      },
      {
        params: z.object({ id: z.string().min(1).max(200) }),
        response: { 200: SlotRelease, ...errorResponses(503) },
        detail: { hide: true, operationId: 'slots.release' },
      },
    )
    .post(
      '/slots/:id/cost',
      async ({ body, status }) => {
        if (!api) return status(503, unbound)
        const recorded = await api.recordStepCost(body)
        return recorded.ok
          ? status(200, SlotRelease.parse({ released: true }))
          : status(503, unavailable(recorded.error))
      },
      {
        params: z.object({ id: z.string().min(1).max(200) }),
        body: StepCost,
        response: { 200: SlotRelease, ...errorResponses(400, 503) },
        detail: { hide: true, operationId: 'slots.cost' },
      },
    )
    .post(
      '/merge-windows',
      async ({ body, status }) => {
        if (!api) return status(503, unbound)
        const recorded = await api.recordMergeWindow({
          project: body.project,
          cwd: body.cwd,
          requestedAt: new Date(body.requestedAt),
          acquiredAt: body.acquiredAt === null ? null : new Date(body.acquiredAt),
          releasedAt: new Date(body.releasedAt),
          exitCode: body.exitCode,
        })
        return recorded.ok
          ? status(200, SlotRelease.parse({ released: true }))
          : status(503, unavailable(recorded.error))
      },
      {
        body: MergeWindow,
        response: { 200: SlotRelease, ...errorResponses(400, 503) },
        detail: { hide: true, operationId: 'mergeWindows.record' },
      },
    )
}
