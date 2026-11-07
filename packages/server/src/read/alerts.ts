import type { AlertList, ReadAlert } from '@software-factory/contract'
import type { Clock } from '../clock.ts'
import { namesVisible } from '../fleet/digest-model.ts'
import { cut } from './describe.ts'

/**
 * The alerts read (`GET /v1/alerts`): the messages Kuma, HyperDX and the jobs sent to the ntfy alerts topic. The factory stores none of
 * them; the topic is the truth, so the read polls it (`ntfy.sh`'s `?poll=1&since=`, the server's message cache) and shapes what it finds.
 */

/** Longest one poll may take before it is abandoned (a plain HTTP request, not an agent run). */
export const POLL_TIMEOUT_MS = 10_000
export const DEFAULT_ALERT_HOURS = 24
/** ntfy keeps messages for 12 h unless the server is set longer; a day is the most this read asks for. */
export const MAX_ALERT_HOURS = 24
export const DEFAULT_ALERT_LIMIT = 100
export const MAX_ALERT_LIMIT = 500
/** One line of an alert's text, cut at a word. */
const TEXT_MAX = 240
const HIDDEN = 'Alert about a visible repository.'

/** A message as ntfy publishes it, reduced to what the read uses. */
export interface AlertMessage {
  id: string
  /** unix seconds */
  time: number
  title?: string
  tags?: readonly string[]
  message?: string
  priority?: number
}

/** The alerts could not be read: the source is not set up or did not answer. The route answers 503 with `code`. */
export class AlertsUnavailable extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'unavailable',
  ) {
    super(message)
  }
}

export interface AlertSource {
  /** every message of the last `hours`, in any order; throws `AlertsUnavailable` */
  recent(hours: number): Promise<AlertMessage[]>
}

/** Polls `<url>/<topic>/json?poll=1&since=<hours>h` with a bearer token. The token never appears in an error. */
export class NtfyAlertSource implements AlertSource {
  constructor(private readonly options: { url: string; topic: string; token: string; timeoutMs?: number }) {}

  async recent(hours: number): Promise<AlertMessage[]> {
    const { url, topic, token, timeoutMs = POLL_TIMEOUT_MS } = this.options
    if (!url) throw new AlertsUnavailable('FACTORY_NTFY_URL is not set', 'not_configured')
    if (!token) throw new AlertsUnavailable('NTFY_TOKEN is not set', 'not_configured')
    try {
      const response = await fetch(`${url}/${topic}/json?poll=1&since=${hours}h`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new AlertsUnavailable(`ntfy answered ${response.status}`, 'unavailable')
      }
      return parseMessages(await response.text())
    } catch (error) {
      if (error instanceof AlertsUnavailable) throw error
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new AlertsUnavailable(`ntfy poll timed out after ${timeoutMs} ms`, 'unavailable')
      const reason = error instanceof Error ? error.message : String(error)
      throw new AlertsUnavailable(`ntfy poll failed: ${reason.replaceAll(token, '[redacted]')}`, 'unavailable')
    }
  }
}

/** ntfy's JSON stream: one object per line; only `message` events are alerts (`open` and `keepalive` are not). */
export function parseMessages(body: string): AlertMessage[] {
  const out: AlertMessage[] = []
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.event !== 'message' || typeof event.id !== 'string' || typeof event.time !== 'number') continue
    out.push({
      id: event.id,
      time: event.time,
      title: typeof event.title === 'string' ? event.title : undefined,
      tags: Array.isArray(event.tags) ? event.tags.filter((t): t is string => typeof t === 'string') : undefined,
      message: typeof event.message === 'string' ? event.message : undefined,
      priority: typeof event.priority === 'number' ? event.priority : undefined,
    })
  }
  return out
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export interface AlertsDeps {
  source: AlertSource
  clock: Clock
  /** the names of the directories under the visible roots: an alert that mentions one is a visible repo's (`namesVisible`) */
  visibleNames?: () => Promise<readonly string[]>
}

export class Alerts {
  constructor(private readonly deps: AlertsDeps) {}

  /** The alerts of the last `hours`, newest first, at most `limit`. `surface`: an alert that names a visible place loses its text. */
  async list(options: { hours: number; limit: number; surface: boolean }): Promise<AlertList> {
    const { hours, limit, surface } = options
    const cutoff = this.deps.clock.now().getTime() - hours * 3_600_000
    const names = (await this.deps.visibleNames?.()) ?? []
    const messages = (await this.deps.source.recent(hours))
      .filter((m) => m.time * 1000 >= cutoff)
      .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))
    const alerts = messages.slice(0, limit).map((m): ReadAlert => {
      const source = m.title?.trim() || m.tags?.[0]?.trim() || null
      const text = oneLine(m.message || m.title || '')
      const visible = namesVisible(`${source ?? ''}\n${text}`, names)
      return {
        id: m.id,
        at: new Date(m.time * 1000).toISOString(),
        source: surface && visible ? null : source,
        text: surface && visible ? HIDDEN : cut(text, TEXT_MAX),
        priority: m.priority ?? 3,
        visible,
      }
    })
    return { hours, total: messages.length, alerts }
  }
}
