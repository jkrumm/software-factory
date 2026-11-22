import { Elysia } from 'elysia'
import { logEvent, recordServerError, telemetryOn } from '../kernel/telemetry.ts'

/** The answers that say the caller sent a bad request: a body or field the contract refuses, a verb the policy refuses. */
const REFUSED = new Set([400, 403, 422])

/**
 * What a request leaves in the telemetry (`kernel/telemetry.ts`): an answer 5xx is one error span and one error log, an
 * answer the contract or the policy refuses (400, 403, 422) one warning. Both carry the method, the route pattern
 * (`/v1/issues/:id/note`, never the path), the status and the time it took: nothing of the body, the token or the caller's words.
 */
export function requestTelemetry() {
  const began = new WeakMap<Request, number>()
  return new Elysia({ name: 'request-telemetry' })
    .onRequest(({ request }) => {
      if (telemetryOn()) began.set(request, Date.now())
    })
    .onAfterResponse({ as: 'global' }, ({ request, route, set }) => {
      const startMs = began.get(request)
      if (startMs === undefined) return
      began.delete(request)
      const status = Number(set.status ?? 200)
      const attrs = { method: request.method, route: route || 'unmatched', status }
      if (status >= 500) recordServerError({ ...attrs, startMs })
      else if (REFUSED.has(status)) {
        logEvent('warn', 'api.request_refused', {
          'http.method': attrs.method,
          'http.route': attrs.route,
          'http.status': status,
          'duration.ms': Date.now() - startMs,
        })
      }
    })
}
