export type SendResult = { ok: true } | { ok: false; error: string }

/**
 * The owner's line. One call, and it never throws: a message is a finished text (the factory calls no model), and the answer says
 * whether it arrived. Never called inside a transaction.
 */
export interface Notifier {
  send(message: string): Promise<SendResult>
}

/** Longest one ntfy publish may take before it is abandoned. */
export const SEND_TIMEOUT_MS = 10_000

/** ntfy turns a longer message into an attachment. */
const MAX_BODY_BYTES = 4000

const TOPIC = /^[A-Za-z0-9_-]{1,64}$/

/** The text cut to at most `MAX_BODY_BYTES` UTF-8 bytes on a character boundary, ending with `…` when cut. */
function fitBody(message: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(message).length <= MAX_BODY_BYTES) return message
  const ellipsis = '…'
  const budget = MAX_BODY_BYTES - encoder.encode(ellipsis).length
  let out = ''
  let bytes = 0
  for (const char of message) {
    const size = encoder.encode(char).length
    if (bytes + size > budget) break
    out += char
    bytes += size
  }
  return out + ellipsis
}

/** Publishes to `<url>/<topic>` on an ntfy server with a bearer token. The token never appears in an error. */
export class NtfyNotifier implements Notifier {
  constructor(private readonly options: { url: string; topic: string; token: string; timeoutMs?: number }) {}

  async send(message: string): Promise<SendResult> {
    const { url, topic, token, timeoutMs = SEND_TIMEOUT_MS } = this.options
    if (!url) return { ok: false, error: 'FACTORY_NTFY_URL is not set' }
    if (!token) return { ok: false, error: 'NTFY_TOKEN is not set' }
    try {
      const response = await fetch(`${url}/${topic}`, {
        method: 'POST',
        body: fitBody(message),
        headers: { Authorization: `Bearer ${token}`, Title: 'Software factory' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      await response.body?.cancel()
      if (response.ok) return { ok: true }
      return { ok: false, error: `ntfy answered ${response.status}` }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        return { ok: false, error: `ntfy publish timed out after ${timeoutMs} ms` }
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `ntfy publish failed: ${reason.replaceAll(token, '[redacted]')}` }
    }
  }
}

/** `FACTORY_NOTIFY_TARGET=off`: rows are still recorded and counted as sent, with the reason, so nothing piles up. */
export class NullNotifier implements Notifier {
  async send(): Promise<SendResult> {
    return { ok: true }
  }
}

export const NOTIFY_OFF = 'off'

export const NTFY_PREFIX = 'ntfy:'

/** A valid `FACTORY_NOTIFY_TARGET`: `off` or `ntfy:<topic>`. */
export function isNotifyTarget(target: string): boolean {
  return target === NOTIFY_OFF || (target.startsWith(NTFY_PREFIX) && TOPIC.test(target.slice(NTFY_PREFIX.length)))
}

export function makeNotifier(config: { notifyTarget: string; ntfyUrl: string; ntfyToken: string }): Notifier {
  if (config.notifyTarget === NOTIFY_OFF) return new NullNotifier()
  if (!isNotifyTarget(config.notifyTarget)) throw new Error(`unsupported notify target: ${config.notifyTarget}`)
  return new NtfyNotifier({
    url: config.ntfyUrl.replace(/\/+$/, ''),
    topic: config.notifyTarget.slice(NTFY_PREFIX.length),
    token: config.ntfyToken,
  })
}
