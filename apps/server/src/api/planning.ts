import {
  AfterAnswer,
  AfterBody,
  ErrorBody,
  FetchQuery,
  PlanningPassAnswer,
  PrioAnswer,
  PrioBody,
  ProjectList,
  ProjectSyncAnswer,
  ProjectView,
  ReplanAnswer,
  ReplanApplyAnswer,
  ReplanApplyBody,
  ReplanBody,
  type ROW_STATES,
  SettleAnswer,
  SettleBody,
  UnafterAnswer,
  UnafterBody,
} from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { RowState } from '../domains/planning/plan.ts'
import type { PlanningError } from '../app/planning-deps.ts'
import type { ReplanApplyInput, ReplanOpResult, Replanned } from '../app/planning-replan.ts'
import type { PassResult } from '../app/planning-pass.ts'
import type { SyncResult } from '../app/planning-sync.ts'
import type { ProjectState } from '../app/planning-views.ts'
import { type IssueId, idOf, issueNumber } from '../kernel/ids.ts'
import type { OwnerActor } from '../kernel/events.ts'
import type { PortError, Result } from '../kernel/result.ts'
import { ownerActorOf } from './auth.ts'
import { errorResponses } from './errors.ts'
import { issueRef } from './issue-ref.ts'

/** The contract's row states and the domain's are one list. */
const rowStatesMatch: [(typeof ROW_STATES)[number]] extends [RowState]
  ? [RowState] extends [(typeof ROW_STATES)[number]]
    ? true
    : never
  : never = true
void rowStatesMatch

/** The use cases the routes call, bound in `main.ts`. */
export interface PlanningApi {
  projects(): Promise<Result<ProjectState[], PortError>>
  sync(input: { fetch: boolean }): Promise<Result<SyncResult, PortError>>
  pass(input: { fetch: boolean }): Promise<Result<PassResult, PortError>>
  settle(input: {
    issue: IssueId
    after: IssueId[]
  }): Promise<
    Result<{ result: 'settled' | 'replayed' | 'ignored'; edges: number; state: string }, PlanningError | PortError>
  >
  after(input: { issue: IssueId; after: IssueId[] }): Promise<Result<{ edges: number }, PlanningError | PortError>>
  unafter(input: { issue: IssueId; after: IssueId[] }): Promise<Result<{ removed: number }, PlanningError | PortError>>
  replan(input: {
    project: string
    ask: string | undefined
    actor: OwnerActor
  }): Promise<Result<Replanned, PlanningError | PortError>>
  applyReplan(input: ReplanApplyInput): Promise<Result<ReplanOpResult[], PlanningError | PortError>>
  prio(input: {
    issue: IssueId
    value: number
    key: string | undefined
    actor: OwnerActor
  }): Promise<Result<{ recorded: boolean }, PlanningError | PortError>>
}

const failure = (error: string, code: string, details?: Record<string, unknown>): ErrorBody =>
  ErrorBody.parse({ error, code, ...(details ? { details } : {}) })

type Failure = { status: 404 | 409 | 503; body: ErrorBody }

const nameOf = (issue: IssueId) => `Issue ${issueNumber(issue)}`

/** Every way a planning verb says no, as the status and the body a person reads. */
export function failureOf(error: PlanningError | PortError): Failure {
  switch (error.kind) {
    case 'unknown_issue':
      return { status: 404, body: failure(`no ${nameOf(error.issue)}`, 'not_found') }
    case 'issue_closed':
      return { status: 409, body: failure(`${nameOf(error.issue)} is closed: nothing can wait for it`, 'issue_closed') }
    case 'wrong_state':
      return { status: 409, body: failure(error.detail, 'wrong_state') }
    case 'cycle':
      return {
        status: 409,
        body: failure(`that closes a cycle: ${error.path.map(nameOf).join(' waits for ')}`, 'cycle', {
          path: error.path,
        }),
      }
    case 'unknown_edge':
      return {
        status: 404,
        body: failure(`${nameOf(error.issue)} does not wait for ${nameOf(error.after)} by a stored edge`, 'not_found'),
      }
    case 'unknown_project':
      return { status: 404, body: failure(`no project ${error.project}`, 'not_found') }
    case 'not_a_replan':
      return { status: 409, body: failure(`${nameOf(error.issue)} is not a Replan`, 'not_a_replan') }
    case 'not_approved':
      return {
        status: 409,
        body: failure(
          `${nameOf(error.issue)} has no approved Spec: its latest Spec revision needs a Looks good or With notes verdict`,
          'not_approved',
        ),
      }
    case 'outside_project':
      return {
        status: 409,
        body: failure(
          `${error.issues.map(nameOf).join(', ')} not open Issues of project ${error.project} (a Replan changes its own project only); nothing was applied`,
          'outside_project',
          { issues: error.issues },
        ),
      }
    case 'version_conflict':
      return { status: 409, body: failure(`${nameOf(error.issue)} moved meanwhile; try again`, 'version_conflict') }
    case 'refused':
      return { status: 409, body: failure(error.detail, 'refused') }
    default:
      return { status: 503, body: failure(`unavailable: ${error.detail}`, 'unavailable') }
  }
}

const issueOf = (text: string): IssueId | null => idOf('issue', text)

const view = ({ project, plan }: ProjectState): ProjectView =>
  ProjectView.parse({
    name: project.name,
    repo: project.repo,
    source: project.source,
    branch: project.branch,
    syncedAt: project.syncedAt?.toISOString() ?? null,
    leads: project.project.leads,
    lanes: project.project.lanes,
    slotRun: project.project.slots.run ?? null,
    signals: project.project.signals,
    projectError: project.projectError,
    plan:
      plan || project.plan ? { sha: project.planSha, warnings: project.planWarnings, rows: plan?.rows ?? [] } : null,
    planError: project.planError?.message ?? null,
  })

const syncAnswer = (result: SyncResult): ProjectSyncAnswer => ProjectSyncAnswer.parse(result)

/**
 * Projects, the plans, the chain and the owner's priorities. The routes exist whether or not the use cases are bound,
 * so the OpenAPI document (and the generated CLI) is the same everywhere; unbound they answer 503.
 */
export const planningRoutes = (api?: PlanningApi) => {
  const unbound = failure('planning is not wired in this process', 'unavailable')
  return new Elysia()
    .get(
      '/projects',
      async ({ status }) => {
        if (!api) return status(503, unbound)
        const projects = await api.projects()
        if (!projects.ok) return status(503, failureOf(projects.error).body)
        return status(200, ProjectList.parse({ projects: projects.value.map(view) }))
      },
      {
        response: { 200: ProjectList, ...errorResponses(503) },
        detail: { operationId: 'project.list', summary: 'the projects the factory has read, with their plans' },
      },
    )
    .get(
      '/projects/:name',
      async ({ params, status }) => {
        if (!api) return status(503, unbound)
        const projects = await api.projects()
        if (!projects.ok) return status(503, failureOf(projects.error).body)
        const found = projects.value.find((p) => p.project.name === params.name)
        return found ? status(200, view(found)) : status(404, failure(`no project ${params.name}`, 'not_found'))
      },
      {
        params: z.object({ name: z.string() }),
        response: { 200: ProjectView, ...errorResponses(404, 503) },
        detail: {
          operationId: 'project.show',
          summary:
            'one project: its project.yaml in force and every plan row with its state (the plan format: docs/plan.md)',
        },
      },
    )
    .post(
      '/projects/sync',
      async ({ query, status }) => {
        if (!api) return status(503, unbound)
        const synced = await api.sync({ fetch: query.fetch === 'true' })
        return synced.ok ? status(200, syncAnswer(synced.value)) : status(503, failureOf(synced.error).body)
      },
      {
        query: FetchQuery,
        response: { 200: ProjectSyncAnswer, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'project.sync',
          summary: 'read project.yaml and docs/plan.yaml of every repo from its default branch',
        },
      },
    )
    .post(
      '/planning/pass',
      async ({ query, status }) => {
        if (!api) return status(503, unbound)
        const pass = await api.pass({ fetch: query.fetch === 'true' })
        if (!pass.ok) return status(503, failureOf(pass.error).body)
        const { sync, filed, satisfied, woken, errors } = pass.value
        return status(
          200,
          PlanningPassAnswer.parse({ sync: sync ? syncAnswer(sync) : null, filed, satisfied, woken, errors }),
        )
      },
      {
        query: FetchQuery,
        response: { 200: PlanningPassAnswer, ...errorResponses(400, 422, 503) },
        detail: {
          operationId: 'planning.pass',
          summary: 'sync the projects, file the plan rows whose after rows closed, wake the Issues whose chain is done',
        },
      },
    )
    .post(
      '/planning/settle',
      async ({ body, status }) => {
        if (!api) return status(503, unbound)
        const issue = issueOf(body.issue)
        if (!issue) return status(404, failure(`no ${body.issue}`, 'not_found'))
        const after = body.after.map(issueOf)
        if (after.some((id) => id === null)) return status(404, failure('an after is not an Issue id', 'not_found'))
        const settled = await api.settle({ issue, after: after.filter((id): id is IssueId => id !== null) })
        if (!settled.ok) {
          const out = failureOf(settled.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        return status(200, SettleAnswer.parse({ issue: body.issue, ...settled.value }))
      },
      {
        body: SettleBody,
        response: { 200: SettleAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'planning.settle',
          summary: 'record settled on a settling Issue once its after edges are known (none is a known answer)',
        },
      },
    )
    .post(
      '/planning/after',
      async ({ body, status }) => {
        if (!api) return status(503, unbound)
        const issue = issueOf(body.issue)
        if (!issue) return status(404, failure(`no ${body.issue}`, 'not_found'))
        const after = body.after.map(issueOf)
        if (after.some((id) => id === null)) return status(404, failure('an after is not an Issue id', 'not_found'))
        const added = await api.after({ issue, after: after.filter((id): id is IssueId => id !== null) })
        if (!added.ok) {
          const out = failureOf(added.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        return status(200, AfterAnswer.parse({ issue: body.issue, edges: added.value.edges }))
      },
      {
        body: AfterBody,
        response: { 200: AfterAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'planning.after',
          summary: 'make a queued, working or watching Issue wait for others to close (refuses a cycle)',
        },
      },
    )
    .post(
      '/planning/unafter',
      async ({ body, status }) => {
        if (!api) return status(503, unbound)
        const issue = issueOf(body.issue)
        if (!issue) return status(404, failure(`no ${body.issue}`, 'not_found'))
        const after = body.after.map(issueOf)
        if (after.some((id) => id === null)) return status(404, failure('an after is not an Issue id', 'not_found'))
        const removed = await api.unafter({ issue, after: after.filter((id): id is IssueId => id !== null) })
        if (!removed.ok) {
          const out = failureOf(removed.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        return status(200, UnafterAnswer.parse({ issue: body.issue, removed: removed.value.removed }))
      },
      {
        body: UnafterBody,
        response: { 200: UnafterAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'planning.unafter',
          summary: 'remove stored after edges from an open Issue (refuses an edge it does not have)',
        },
      },
    )
    .post(
      '/planning/replan',
      async ({ body, request, status }) => {
        if (!api) return status(503, unbound)
        const filed = await api.replan({ project: body.project, ask: body.ask, actor: ownerActorOf(request) })
        if (!filed.ok) {
          const out = failureOf(filed.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        const { issue, filed: isNew, existing } = filed.value
        return status(200, ReplanAnswer.parse({ issue: issue.id, filed: isNew, existing }))
      },
      {
        body: ReplanBody,
        response: { 200: ReplanAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'planning.replan',
          summary:
            "file the project's Replan: an Issue whose lead proposes plan changes as a Spec (one open per project; an ask is added to it)",
          'x-cli': { args: ['project'] },
        },
      },
    )
    .post(
      '/v1/issues/:id/replan',
      async ({ params, body, status }) => {
        if (!api) return status(503, unbound)
        const issue = issueRef(params.id)
        if (!issue) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const edges = (list: { issue: string; after: string[] }[]) =>
          list.map((edge) => ({ issue: issueOf(edge.issue), after: edge.after.map(issueOf) }))
        const add = edges(body.edges?.add ?? [])
        const remove = edges(body.edges?.remove ?? [])
        const cancel = (body.cancel ?? []).map((target) => ({ issue: issueOf(target.issue), reason: target.reason }))
        const unknown = [...add, ...remove].some((edge) => edge.issue === null || edge.after.includes(null))
        if (unknown || cancel.some((target) => target.issue === null)) {
          return status(404, failure('an id in the body is not an Issue id', 'not_found'))
        }
        const applied = await api.applyReplan({
          issue,
          attempt: body.attempt,
          call: body.call,
          edges: {
            add: add as ReplanApplyInput['edges']['add'],
            remove: remove as ReplanApplyInput['edges']['remove'],
          },
          cancel: cancel as ReplanApplyInput['cancel'],
        })
        if (!applied.ok) {
          const out = failureOf(applied.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        return status(200, ReplanApplyAnswer.parse({ results: applied.value }))
      },
      {
        params: z.object({ id: z.string() }),
        body: ReplanApplyBody,
        response: { 200: ReplanApplyAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'issue.replan',
          summary:
            'the Replan lead applies its approved Spec to its own project: body {"attempt":1,"edges":{"add":[{"issue":"issue_7","after":["issue_5"]}],"remove":[]},"cancel":[{"issue":"issue_9","reason":"..."}]}',
        },
      },
    )
    .post(
      '/issues/:id/prio',
      async ({ params, body, request, status }) => {
        if (!api) return status(503, unbound)
        const issue = issueRef(params.id)
        if (!issue) return status(404, failure(`no Issue ${params.id}`, 'not_found'))
        const set = await api.prio({ issue, value: body.value, key: body.key, actor: ownerActorOf(request) })
        if (!set.ok) {
          const out = failureOf(set.error)
          return out.status === 404
            ? status(404, out.body)
            : out.status === 409
              ? status(409, out.body)
              : status(503, out.body)
        }
        return status(200, PrioAnswer.parse({ issue, value: body.value, recorded: set.value.recorded }))
      },
      {
        params: z.object({ id: z.string() }),
        body: PrioBody,
        response: { 200: PrioAnswer, ...errorResponses(400, 404, 409, 422, 503) },
        detail: {
          operationId: 'issue.prio',
          summary: "set an Issue's priority, the owner's: higher runs first within its class",
          'x-cli': { args: ['value'] },
        },
      },
    )
}
