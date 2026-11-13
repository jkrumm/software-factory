import type { ReadUptime } from '@software-factory/contract'
import * as z from 'zod'
import type { Clock } from '../../kernel/clock.ts'

const HTTP_TIMEOUT_MS = 8_000
/** a last good read older than this is not shown: a dead feed must not read as all up */
export const STALE_AFTER_MS = 10 * 60_000
const MAX_DOWN_NAMES = 10
const MAX_NAME_CHARS = 80

export interface UptimePollerDeps {
  clock: Clock
  /** `FACTORY_UPTIME_URL`; null is off */
  url: string | null
  /** `FACTORY_UPTIME_TOKEN`, sent as a bearer */
  token?: string | null
  fetch?: typeof fetch
  log?: (line: string) => void
}

const Snapshot = z.looseObject({
  status: z.string(),
  monitors: z.array(
    z.looseObject({
      name: z.string().catch(''),
      type: z.string().catch(''),
      active: z.unknown(),
      status: z.unknown(),
    }),
  ),
})

/** The counting rule: groups and monitors that are not active are left out; status 1 is up, 0 down, the rest counts in the total only. */
function count(monitors: z.infer<typeof Snapshot>['monitors']): Omit<ReadUptime, 'at'> {
  let up = 0
  let total = 0
  const down: string[] = []
  for (const monitor of monitors) {
    if (monitor.type === 'group' || monitor.active !== true) continue
    total++
    if (monitor.status === 1) up++
    else if (monitor.status === 0) down.push(monitor.name.slice(0, MAX_NAME_CHARS))
  }
  return { up, down: down.length, total, downNames: down.sort().slice(0, MAX_DOWN_NAMES) }
}

/**
 * The uptime feed: Argo's Kuma snapshot read over plain HTTP, the last good count kept in memory for the read side. It files
 * no signal. A failed pass (an error status, a body that is not `ready` or not the shape) keeps the last good count and logs
 * one line; the count reads as null once it is older than ten minutes.
 */
export function uptimePoller(deps: UptimePollerDeps): {
  enabled: boolean
  pass(): Promise<void>
  snapshot(): ReadUptime | null
} {
  const log = deps.log ?? ((line: string) => console.error(line))
  const url = deps.url?.trim() ? deps.url.trim() : null
  const enabled = url !== null
  const doFetch = deps.fetch ?? fetch
  let last: { read: ReadUptime; atMs: number } | null = null

  async function pass(): Promise<void> {
    if (url === null) return
    try {
      const response = await doFetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'software-factory',
          ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) return void log(`uptime feed: HTTP ${response.status}`)
      const body = Snapshot.safeParse(await response.json())
      if (!body.success) return void log('uptime feed: the body is not a snapshot')
      if (body.data.status !== 'ready')
        return void log(`uptime feed: status is not ready (${body.data.status.slice(0, 40)})`)
      const now = deps.clock.now()
      last = { read: { ...count(body.data.monitors), at: now.toISOString() }, atMs: now.getTime() }
    } catch (error) {
      log(`uptime feed: ${error instanceof Error ? error.name : 'failed'}`)
    }
  }

  return {
    enabled,
    pass,
    snapshot() {
      if (!enabled || !last) return null
      return deps.clock.now().getTime() - last.atMs > STALE_AFTER_MS ? null : last.read
    },
  }
}
