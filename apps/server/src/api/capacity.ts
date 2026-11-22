import {
  AccountModeAnswer,
  AccountModeBody,
  AccountsView,
  AccountView,
  AdmitAnswer,
  CapacityView,
  ErrorBody,
  MergeWindow,
  QueueOrder,
  QueuePrioBody,
  type QUEUE_REASONS,
  QueueSetBody,
  QueueStatesView,
  RefreshAnswer,
  RelearnBody,
  RelearnView,
  type RemoteGrant,
  Slot,
  SlotBody,
  SlotRelease,
  StepCost,
  type StepHost,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { CapacityLimits, PassResult, QueueEntry, QueueReasonKind } from '../app/capacity-admit.ts'
import type { AccountMode } from '@software-factory/contract'
import type { AccountState, CapacityState } from '../app/capacity-view.ts'
import type { QueueState, QueueStates } from '../domains/capacity/queue-state.ts'
import type { Relearn } from '../domains/capacity/ports.ts'
import type { SlotView } from '../domains/capacity/slots.ts'
import type { PortError, Result } from '../kernel/result.ts'
import { callerOf, ownerActorOf } from './auth.ts'
import { errorResponses } from './errors.ts'

/** The contract's list of reasons and the server's are one list: a reason added on one side fails `tsc` until it is on the other. */
const queueReasonsMatch: [(typeof QUEUE_REASONS)[number]] extends [QueueReasonKind]
  ? [QueueReasonKind] extends [(typeof QUEUE_REASONS)[number]]
    ? true
    : never
  : never = true
void queueReasonsMatch

/** A project name the factory has not read: not a failure of a port, so it has its own kind. */
export interface UnknownProject {
  kind: 'unknown_project'
  detail: string
}

/** The use cases the routes call, bound in `main.ts`. */
export interface CapacityApi {
  limits: CapacityLimits & { slots: number; slotsMax: number }
  state(): Promise<Result<CapacityState, PortError>>
  refresh(): Promise<Result<AccountState[], PortError>>
  /** `GET /v1/accounts`: the package's status of every account with the factory's allowance and leads beside it */
  accounts(): Promise<Result<AccountsView, PortError>>
  /** sets a mode override through the package; a request it refuses is `refused` */
  setAccountMode(account: string, body: AccountModeBody): Promise<Result<AccountMode, PortError>>
  clearAccountMode(account: string): Promise<Result<AccountMode, PortError>>
  admit(): Promise<Result<PassResult, PortError>>
  queue(): Promise<Result<{ queue: QueueEntry[]; notes: string[] }, PortError>>
  /** `project` (a name or a path inside a source root) narrows the answer to that project; a path outside the roots is `refused` */
  queueStates(project?: string): Promise<Result<QueueStates, PortError>>
  /** `project` is a name or a path inside a source root; a path outside the roots is `refused` */
  setQueueState(input: { project: string | null; state: QueueState }): Promise<Result<QueueStates, PortError>>
  /** `project` is a name or a path inside a source root; the priority is -1000 to 1000, else `refused` */
  setProjectPrio(input: { project: string; prio: number }): Promise<Result<QueueStates, PortError | UnknownProject>>
  /** `repo` is a name or a path inside a source root; `at` null: now. A point in the future is `refused`. */
  setRelearn(input: { repo: string; at: Date | null; actor: string }): Promise<Result<Relearn, PortError>>
  touchSlot(input: {
    id: string
    name: string
    cwd: string | undefined
    limitMs: number | undefined
    rssMib: number | undefined
    peakRssMib: number | undefined
    holding: boolean | undefined
    remote: boolean | undefined
    pin: StepHost | undefined
    notOn: readonly StepHost[] | undefined
    runningOn: { host: StepHost; slot: number } | undefined
  }): Promise<Result<SlotView & { remote: RemoteGrant | null }, PortError>>
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
    leads: a.leads,
    cap: a.cap,
  })

const entryView = (entry: QueueEntry) => ({
  issue: entry.issue,
  repo: entry.repo,
  project: entry.project,
  kind: entry.kind,
  prio: entry.prio,
  projectPrio: entry.projectPrio,
  byProjectPrio: entry.byProjectPrio,
  reason: entry.reason
    ? { kind: entry.reason.kind, message: entry.reason.message, opensAt: iso(entry.reason.opensAt) }
    : null,
  account: entry.account,
})

const statesView = (states: QueueStates): QueueStatesView =>
  QueueStatesView.parse({
    global: states.global,
    projects: Object.fromEntries(states.projects),
    prios: Object.fromEntries(states.prios),
  })

const slotView = (slot: SlotView & { remote: RemoteGrant | null }): Slot => Slot.parse(slot)

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
                  ? [
                      {
                        slot: row.slot,
                        name: row.name,
                        grantedAt: row.grantedAt.toISOString(),
                        host: row.host === 'vps' ? ('vps' as const) : ('mini' as const),
                      },
                    ]
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
    .get(
      '/v1/accounts',
      async ({ status }) => {
        if (!api) return status(503, unbound)
        const view = await api.accounts()
        return view.ok ? status(200, AccountsView.parse(view.value)) : status(503, unavailable(view.error))
      },
      {
        response: { 200: AccountsView, ...errorResponses(503) },
        detail: {
          operationId: 'accounts.status',
          summary:
            'every account as the picker judges it (state, mode, limits, lanes, forecast, resets) with the allowance taken and free and the leads running',
        },
      },
    )
    .post(
      '/v1/accounts/:id/mode',
      async ({ params, body, status }) => {
        if (!api) return status(503, unbound)
        const set = await api.setAccountMode(params.id, body)
        if (set.ok) return status(200, AccountModeAnswer.parse({ account: params.id, mode: set.value }))
        return set.error.kind === 'refused'
          ? status(422, failure(set.error.detail, 'refused'))
          : status(503, unavailable(set.error))
      },
      {
        params: z.object({ id: z.string().min(1) }),
        body: AccountModeBody,
        response: { 200: AccountModeAnswer, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'accounts.mode',
          summary:
            'set a mode override on an account: normal, drain, reserve (with for) or paused, until an ISO time or reset; claude-account sees it',
          'x-cli': { args: ['mode'] },
        },
      },
    )
    .delete(
      '/v1/accounts/:id/mode',
      async ({ params, status }) => {
        if (!api) return status(503, unbound)
        const cleared = await api.clearAccountMode(params.id)
        if (cleared.ok) return status(200, AccountModeAnswer.parse({ account: params.id, mode: cleared.value }))
        return cleared.error.kind === 'refused'
          ? status(422, failure(cleared.error.detail, 'refused'))
          : status(503, unavailable(cleared.error))
      },
      {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: AccountModeAnswer, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'accounts.mode-clear',
          summary: "clear an account's mode override; the registry's mode applies again",
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
      '/queue/prio',
      async ({ body, status }) => {
        if (!api) return status(503, unbound)
        const states = await api.setProjectPrio(body)
        if (states.ok) return status(200, statesView(states.value))
        if (states.error.kind === 'unknown_project') return status(404, failure(states.error.detail, 'unknown_project'))
        return states.error.kind === 'refused'
          ? status(422, outsideRoots(states.error))
          : status(503, unavailable(states.error))
      },
      {
        body: QueuePrioBody,
        response: { 200: QueueStatesView, ...errorResponses(400, 404, 422, 503) },
        detail: {
          operationId: 'queue.prio',
          summary:
            "set a project's priority, the owner's: among queued Issues of one Issue priority, a higher project starts first",
          'x-cli': { args: ['prio'] },
        },
      },
    )
    .post(
      '/capacity/relearn',
      async ({ body, request, status }) => {
        if (!api) return status(503, unbound)
        const set = await api.setRelearn({
          repo: body.repo,
          at: body.at === undefined ? null : new Date(body.at),
          actor: callerOf(request) === 'agent' ? 'agent' : ownerActorOf(request),
        })
        if (set.ok) {
          const r = set.value
          return status(
            200,
            RelearnView.parse({ repo: r.repo, at: r.at.toISOString(), setAt: r.setAt.toISOString(), setBy: r.setBy }),
          )
        }
        return set.error.kind === 'refused'
          ? status(422, failure(set.error.detail, 'invalid'))
          : status(503, unavailable(set.error))
      },
      {
        body: RelearnBody,
        response: { 200: RelearnView, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'capacity.relearn',
          summary:
            'a repo’s lead cost is learned only from the attempts since this time (default now); with fewer than three the repo falls back to its lane’s memory',
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
          remote: body.remote,
          pin: body.pin,
          notOn: body.notOn,
          runningOn: body.runningOn,
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
