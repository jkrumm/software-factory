import * as z from 'zod'
import type { Notifier } from '../../domains/checkpoints/ports.ts'
import { loadConsoleSettings } from '../../console-settings.ts'
import { parseEnv } from '../../kernel/env.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/** Longest one publish may take before it is abandoned: a plain HTTP request, not an agent run. */
const SEND_TIMEOUT_MS = 10_000
/** ntfy turns a longer message into an attachment. */
const MAX_BODY_BYTES = 4000

const TOPIC = /^[A-Za-z0-9_-]{1,64}$/

const Env = z.object({
  /** the ntfy server the owner's line posts to; unset, nothing is pushed */
  FACTORY_NTFY_URL: z.string().optional(),
  /** the ntfy topic the owner's line posts to (letters, digits, - and _) */
  FACTORY_NTFY_TOPIC: z.string().regex(TOPIC).default('factory'),
  /** the bearer token for the ntfy server, when it needs one */
  NTFY_TOKEN: z.string().optional(),
  /** the Console's base URL, where a checkpoint is answered; unset, it is the Console listener on loopback (FACTORY_CONSOLE_PORT) */
  FACTORY_CONSOLE_URL: z.string().min(1).optional(),
})

export interface OwnersLine {
  url: string | null
  topic: string
  token: string | null
  consoleUrl: string
}

/** The Console listener on loopback: where a checkpoint links when FACTORY_CONSOLE_URL is unset. */
const loopbackUrl = (port: number): string => `http://127.0.0.1:${port}`

/** The owner's line from the environment; throws one message when a setting is malformed. */
export function loadOwnersLine(env: Record<string, string | undefined>): OwnersLine {
  const e = parseEnv(Env, env)
  const url = e.FACTORY_NTFY_URL?.trim().replace(/\/+$/, '') || null
  return {
    url,
    topic: e.FACTORY_NTFY_TOPIC,
    token: e.NTFY_TOKEN?.trim() || null,
    consoleUrl: e.FACTORY_CONSOLE_URL ?? loopbackUrl(loadConsoleSettings(env).port),
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
function ntfyNotifier(line: OwnersLine & { url: string; token: string }, timeoutMs = SEND_TIMEOUT_MS): Notifier {
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
const stubNotifier = (reason: string): Notifier => ({
  send: () => Promise.resolve(err(portError('refused', reason))),
})

export function makeNotifier(line: OwnersLine): Notifier {
  if (!line.url) return stubNotifier('FACTORY_NTFY_URL is not set')
  if (!line.token) return stubNotifier('NTFY_TOKEN is not set')
  return ntfyNotifier({ ...line, url: line.url, token: line.token })
}
