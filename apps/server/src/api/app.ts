import { openapi } from '@elysiajs/openapi'
import { ErrorBody } from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import type { CheckpointUses } from '../app/checkpoints-uses.ts'
import type { Tokens } from '../settings.ts'
import { auth, Refusal } from './auth.ts'
import { type CapacityApi, capacityRoutes } from './capacity.ts'
import { checkpointRoutes, documentOnlyUses } from './checkpoints.ts'
import { type HealthSource, healthRoutes } from './health.ts'
import { type QualityWrites, qualityRoutes, unwiredQuality } from './quality.ts'
import { type IntakeApi, intakeRoutes, unwiredIntake } from './intake.ts'
import { type InternalTestWrites, internalTestRoutes } from './internal-test.ts'
import { leadsTestRoutes } from './leads-test.ts'
import { type IssueApi, issueRoutes } from './issues.ts'
import { type LeadRoutes, leadRoutes } from './leads.ts'
import { type LoopsApi, loopRoutes } from './loops.ts'
import { type PlanningApi, planningRoutes } from './planning.ts'
import { readRoutes } from './read.ts'
import { type ReadModelDeps, readModelRoutes } from './read-models.ts'
import type { ReadApi } from '../read/reader.ts'

export interface ApiDeps {
  /** who may call: absent, no caller exists and every route but `GET /health` answers 401 */
  tokens?: Tokens
  /** serves the OpenAPI document and its page, public; off by default and in production (the CLI generator turns it on and reads it in-process) */
  docs?: boolean
  health: HealthSource
  /** the checkpoints use cases; absent (the CLI generator reads the document only), the routes exist and answer nothing */
  checkpoints?: CheckpointUses
  /** the scenarios' entry into the write path (`FACTORY_INTERNAL_TEST_ROUTES=1`); absent, the routes do not exist */
  internalTest?: InternalTestWrites
  /** the quality use cases (ship, reopen, what was recorded); absent, they answer unavailable */
  quality?: QualityWrites
  /** the lead's verbs and its session read (package 4); absent, the routes answer 503 */
  leads?: LeadRoutes
  /** one pass of the lead tick, for the scenarios (`FACTORY_INTERNAL_TEST_ROUTES=1`) */
  leadsTick?: Parameters<typeof leadsTestRoutes>[0]
  /** the owner's Issue verbs (new, cancel, note, answer) and the session note; absent, the routes answer 503 */
  issues?: IssueApi
  /** signals in and the door's registry; absent, the routes answer 503 (the OpenAPI document needs no database) */
  intake?: IntakeApi
  /** projects, plans, the chain, priorities (package 3); unbound, the routes answer 503 */
  planning?: PlanningApi
  /** accounts, the host, claims, the queue, admission, test slots (package 3); unbound, the routes answer 503 */
  capacity?: CapacityApi
  /** the loop runner: every loop shown, one pass of one on demand; unbound, the routes answer 503 */
  loops?: LoopsApi
  /** the legacy-compatible read API and the change stream; unbound, the routes answer 503 */
  read?: ReadApi
  /** the computed screens (needs, flow, chain, kpis, friction); unbound, the routes answer 503 */
  readModels?: ReadModelDeps
  /** where an unexpected error is reported; the answer itself never carries its detail */
  log?: (message: string) => void
}

/** Where the OpenAPI document is served; the CLI generator reads it in-process through `app.handle`. */
export const OPENAPI_PATH = '/openapi/json'

const failure = (error: string, code: string, details?: Record<string, unknown>): ErrorBody =>
  ErrorBody.parse({ error, code, ...(details ? { details } : {}) })

/** The names of the fields a validation refused, from the paths Elysia's standard-schema issues carry. */
const fieldsOf = (all: readonly unknown[]): string[] => [
  ...new Set(
    all.flatMap((issue) =>
      typeof issue === 'object' && issue && 'path' in issue && typeof issue.path === 'string' && issue.path
        ? [issue.path.replace(/^\//, '')]
        : [],
    ),
  ),
]

/**
 * The Elysia app: the OpenAPI document from the contract's zod schemas, every failure as an `ErrorBody`, and the route
 * groups. Built without a port, so tests and the CLI generator use it through `app.handle`.
 */
export function createApp(deps: ApiDeps) {
  const log = deps.log ?? ((message: string) => console.error(message))
  return new Elysia()
    .use(
      deps.docs
        ? openapi({
            mapJsonSchema: { zod: z.toJSONSchema },
            documentation: { info: { title: 'software-factory', version: '0.0.0' } },
          })
        : new Elysia(),
    )
    .use(auth(deps.tokens))
    .onError(({ code, error, set }) => {
      if (error instanceof Refusal) {
        set.status = error.status
        return error.body
      }
      switch (code) {
        case 'NOT_FOUND':
          set.status = 404
          return failure('no such route', 'not_found')
        case 'PARSE':
          set.status = 400
          return failure('the body is not valid JSON', 'unparseable')
        case 'VALIDATION': {
          const first = error.all[0]
          const detail = first && 'summary' in first && first.summary ? first.summary : error.type
          // Elysia 1.4 answers a response that fails its schema with 422 too: that is the server's bug, a 500.
          if (error.type === 'response') {
            set.status = 500
            return failure(`the server built an answer its contract refuses: ${detail}`, 'invalid_response')
          }
          set.status = error.status
          const fields = fieldsOf(error.all)
          return failure(
            `the ${error.type} does not match the contract: ${detail}`,
            'invalid_request',
            fields.length ? { fields } : undefined,
          )
        }
        default:
          log(`unexpected error (${String(code)}): ${error instanceof Error ? error.message : String(error)}`)
          set.status = 500
          return failure('internal error', 'internal')
      }
    })
    .use(healthRoutes(deps.health))
    .use(qualityRoutes(deps.quality ?? unwiredQuality))
    .use(checkpointRoutes(deps.checkpoints ?? documentOnlyUses))
    .use(leadRoutes(deps.leads))
    .use(issueRoutes(deps.issues))
    .use(intakeRoutes(deps.intake ?? unwiredIntake))
    .use(planningRoutes(deps.planning))
    .use(capacityRoutes(deps.capacity))
    .use(loopRoutes(deps.loops))
    .use(readRoutes(deps.read))
    .use(readModelRoutes(deps.readModels))
    .use(deps.internalTest ? internalTestRoutes(deps.internalTest) : new Elysia())
    .use(deps.leadsTick ? leadsTestRoutes(deps.leadsTick) : new Elysia())
}

export type App = ReturnType<typeof createApp>
