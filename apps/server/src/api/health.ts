import { ErrorBody, Health } from '@software-factory/contract'
import { Elysia } from 'elysia'

export interface HealthSource {
  read(): Promise<Health>
}

/** `GET /health`, the one route without a token: 200 when ok, 503 with the reason in the same shape. */
export const healthRoutes = (source: HealthSource) =>
  new Elysia().get(
    '/health',
    async ({ status }) => {
      const health = await source.read()
      return health.status === 'ok' ? status(200, health) : status(503, health)
    },
    {
      response: { 200: Health, 503: Health, 500: ErrorBody },
      detail: {
        operationId: 'health.get',
        summary: 'the server health and the heartbeat the Uptime Kuma pusher reads',
      },
    },
  )
