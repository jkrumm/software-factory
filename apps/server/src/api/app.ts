import { openapi } from '@elysiajs/openapi'
import { ErrorBody } from '@software-factory/contract'
import { Elysia } from 'elysia'
import * as z from 'zod'
import { type HealthSource, healthRoutes } from './health.ts'
import { type InternalTestWrites, internalTestRoutes } from './internal-test.ts'
import { type IntakeApi, intakeRoutes, unwiredIntake } from './intake.ts'

export interface ApiDeps {
  health: HealthSource
  /** the scenarios' entry into the write path (`FACTORY_INTERNAL_TEST_ROUTES=1`); absent, the routes do not exist */
  internalTest?: InternalTestWrites
  /** signals in and the door's registry; absent, the routes answer 503 (the OpenAPI document needs no database) */
  intake?: IntakeApi
  /** where an unexpected error is reported; the answer itself never carries its detail */
  log?: (message: string) => void
}

/** Where the OpenAPI document is served; the CLI generator reads it in-process through `app.handle`. */
export const OPENAPI_PATH = '/openapi/json'

const failure = (error: string, code: string): ErrorBody => ErrorBody.parse({ error, code })

/**
 * The Elysia app: the OpenAPI document from the contract's zod schemas, every failure as an `ErrorBody`, and the route
 * groups. Built without a port, so tests and the CLI generator use it through `app.handle`.
 */
export function createApp(deps: ApiDeps) {
  const log = deps.log ?? ((message: string) => console.error(message))
  return new Elysia()
    .use(
      openapi({
        mapJsonSchema: { zod: z.toJSONSchema },
        documentation: { info: { title: 'software-factory', version: '0.0.0' } },
      }),
    )
    .onError(({ code, error, set }) => {
      switch (code) {
        case 'NOT_FOUND':
          set.status = 404
          return failure('no such route', 'not_found')
        case 'PARSE':
          set.status = 400
          return failure('the body is not valid JSON', 'unparseable')
        case 'VALIDATION': {
          // Elysia 1.4 answers a response that fails its schema with 422 too; the code tells the two apart.
          set.status = error.status
          const first = error.all[0]
          const detail = first && 'summary' in first && first.summary ? first.summary : error.type
          return error.type === 'response'
            ? failure(`the server built an answer its contract refuses: ${detail}`, 'invalid_response')
            : failure(`the ${error.type} does not match the contract: ${detail}`, 'invalid_request')
        }
        default:
          log(`unexpected error (${String(code)}): ${error instanceof Error ? error.message : String(error)}`)
          set.status = 500
          return failure('internal error', 'internal')
      }
    })
    .use(healthRoutes(deps.health))
    .use(intakeRoutes(deps.intake ?? unwiredIntake))
    .use(deps.internalTest ? internalTestRoutes(deps.internalTest) : new Elysia())
}

export type App = ReturnType<typeof createApp>
