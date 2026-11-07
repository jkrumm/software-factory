import { ErrorBody, TickAnswer } from '@software-factory/contract'
import { Elysia } from 'elysia'
import type { PortError, Result } from '../kernel/result.ts'
import { errorResponses } from './errors.ts'

/**
 * `POST /internal/test/tick` runs one pass of the lead tick (spool, lost leads, outbox) and answers what it did: the
 * scenarios' way to drive time. Mounted only with `FACTORY_INTERNAL_TEST_ROUTES=1`, like the work domain's test routes,
 * so the OpenAPI document and the generated CLI never have it. Package 8 deletes it with them.
 */
export const leadsTestRoutes = (tick: () => Promise<Result<TickAnswer, PortError>>) =>
  new Elysia({ prefix: '/internal/test' }).post(
    '/tick',
    async ({ status }) => {
      const ran = await tick()
      return ran.ok
        ? status(200, TickAnswer.parse(ran.value))
        : status(503, ErrorBody.parse({ error: ran.error.detail, code: 'unavailable' }))
    },
    { response: { 200: TickAnswer, ...errorResponses(503) }, detail: { operationId: 'internal-test.tick' } },
  )
