import { Elysia } from 'elysia'
import type { RouteLatency } from '../domains/loops/selfwatch-model.ts'

/** The window the p95 is read over: the self-watch's `routes_slow` and `GET /health`'s `routeP95Ms`. */
export const ROUTE_WINDOW_MS = 5 * 60_000

/** The most answers kept; the oldest go first. A busy server answers a few hundred in five minutes. */
const MAX_SAMPLES = 20_000

export interface RouteTimer {
  /** the p95 of the answer times in the window; a request still unanswered counts at its age, so a hang shows before it ends */
  snapshot(): RouteLatency
  /** the Elysia plugin that times every route but `/health` and the event stream */
  plugin: Elysia
}

/** The routes whose time says nothing about the database: the health route (it never queries) and a stream that stays open by design. */
const untimed = (request: Request): boolean => {
  const { pathname } = new URL(request.url)
  return (
    pathname === '/health' ||
    pathname.endsWith('/stream') ||
    (request.headers.get('accept') ?? '').includes('text/event-stream')
  )
}

/** The 95th percentile by nearest rank; null for no value. */
export function p95Of(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null
}

/**
 * Times the server's own routes in the process, so a server that is up but answers nothing in time shows from its own
 * numbers (the database-backed routes timed out for hours on 2026-11-14 while `/health`, which never queries, answered).
 * A request that never reports its end (a client that left) is dropped from the in-flight set once it is older than the window.
 */
export function routeTimer(options: { windowMs?: number; now?: () => number } = {}): RouteTimer {
  const windowMs = options.windowMs ?? ROUTE_WINDOW_MS
  const now = options.now ?? Date.now
  const pending = new Map<Request, number>()
  let answered: { endedAt: number; ms: number }[] = []

  const prune = (at: number): void => {
    const from = at - windowMs
    const start = answered.findIndex((sample) => sample.endedAt >= from)
    answered = start < 0 ? [] : answered.slice(start)
    if (answered.length > MAX_SAMPLES) answered = answered.slice(answered.length - MAX_SAMPLES)
    for (const [request, began] of pending) if (began < from) pending.delete(request)
  }

  return {
    snapshot() {
      const at = now()
      prune(at)
      const times = [...answered.map((sample) => sample.ms), ...[...pending.values()].map((began) => at - began)]
      return { p95Ms: p95Of(times), samples: times.length, windowMs }
    },
    plugin: new Elysia({ name: 'route-timer' })
      .onRequest(({ request }) => {
        if (!untimed(request)) pending.set(request, now())
      })
      .onAfterResponse({ as: 'global' }, ({ request }) => {
        const began = pending.get(request)
        if (began === undefined) return
        pending.delete(request)
        const at = now()
        answered.push({ endedAt: at, ms: at - began })
        if (answered.length > MAX_SAMPLES * 2) prune(at)
      }),
  }
}
