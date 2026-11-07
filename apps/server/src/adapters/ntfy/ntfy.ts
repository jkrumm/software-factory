import * as z from 'zod'
import type { Notifier } from '../../domains/checkpoints/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/** Longest one publish may take before it is abandoned: a plain HTTP request, not an agent run. */
export const SEND_TIMEOUT_MS = 10_000
/** ntfy turns a longer message into an attachment. */
const MAX_BODY_BYTES = 4000

const TOPIC = /^[A-Za-z0-9_-]{1,64}$/

const Env = z.object({
  FACTORY_NTFY_URL: z.string().optional(),
  FACTORY_NTFY_TOPIC: z.string().regex(TOPIC).default('factory'),
  NTFY_TOKEN: z.string().optional(),
  /** where a checkpoint is answered; a placeholder until the Console exists */
  FACTORY_CONSOLE_URL: z.string().min(1).default('http://127.0.0.1:7793/console'),
})

export interface OwnersLine {
  url: string | null
  topic: string
  token: string | null
  consoleUrl: string
}

/** The owner's line from the environment; throws one message when a setting is malformed. */
export function loadOwnersLine(env: Record<string, string | undefined>): OwnersLine {
  const parsed = Env.safeParse(env)
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  const url = parsed.data.FACTORY_NTFY_URL?.trim().replace(/\/+$/, '') || null
  return {
    url,
    topic: parsed.data.FACTORY_NTFY_TOPIC,
    token: parsed.data.NTFY_TOKEN?.trim() || null,
    consoleUrl: parsed.data.FACTORY_CONSOLE_URL,
  }
}

/** The text cut to at most `MAX_BODY_BYTES` UTF-8 bytes on a character boundary, ending with `…` when cut. */
function fitBody(message: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(message).length <= MAX_BODY_BYTES) return message
  const budget = MAX_BODY_BYTES - encoder.encode('…').length
  let out = ''
  let bytes = 0
  for (const char of message) {
    const size = encoder.encode(char).length
    if (bytes + size > budget) break
    out += char
    bytes += size
  }
  return `${out}…`
}

/** HTTP header values are Latin-1: anything else would make `fetch` throw. */
const headerSafe = (value: string): string => value.replace(/[^\x20-\x7e]/g, '?')

/**
 * Publishes a page to `<url>/<topic>` with a bearer token; the `Click` header is the deep link. The token never appears
 * in an error. At-least-once: the outbox may send a page again after a crash between the send and its record.
 */
export function ntfyNotifier(line: OwnersLine & { url: string; token: string }, timeoutMs = SEND_TIMEOUT_MS): Notifier {
  return {
    async send(page) {
      try {
        const response = await fetch(`${line.url}/${line.topic}`, {
          method: 'POST',
          body: fitBody(page.body),
          headers: {
            Authorization: `Bearer ${line.token}`,
            Title: headerSafe(page.title),
            Click: headerSafe(page.link),
            Tags: page.kind,
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
        await response.body?.cancel()
        if (response.ok) return ok(undefined)
        return err(portError(response.status >= 500 ? 'gone' : 'refused', `ntfy answered ${response.status}`))
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          return err(portError('timeout', `ntfy publish timed out after ${timeoutMs} ms`))
        }
        const reason = error instanceof Error ? error.message : String(error)
        return err(portError('gone', `ntfy publish failed: ${reason.replaceAll(line.token, '[redacted]')}`))
      }
    },
  }
}

/** Honest about being one: with no URL or token the page waits in the outbox and the error says why. */
export const stubNotifier = (reason: string): Notifier => ({
  send: () => Promise.resolve(err(portError('refused', reason))),
})

export function makeNotifier(line: OwnersLine): Notifier {
  if (!line.url) return stubNotifier('FACTORY_NTFY_URL is not set')
  if (!line.token) return stubNotifier('NTFY_TOKEN is not set')
  return ntfyNotifier({ ...line, url: line.url, token: line.token })
}
