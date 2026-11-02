import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'

export type SendResult = { ok: true } | { ok: false; error: string }

/**
 * The owner's line. One call, and it never throws: a message is a finished text (the factory calls no model), and the answer says
 * whether it arrived. Never called inside a transaction.
 */
export interface Notifier {
  send(message: string): Promise<SendResult>
}

/** Longest one `hermes send` may run before it is killed. */
export const SEND_TIMEOUT_MS = 10_000

/** `hermes send --to <target> --quiet`, the text on stdin: Hermes only delivers, to a channel that never makes it answer. */
export class HermesNotifier implements Notifier {
  constructor(private readonly options: { bin: string; target: string; timeoutMs?: number }) {}

  async send(message: string): Promise<SendResult> {
    const { bin, target, timeoutMs = SEND_TIMEOUT_MS } = this.options
    try {
      const result = await runProcess([bin, 'send', '--to', target, '--quiet'], timeoutMs, childEnv(), message)
      if (result.exitCode === 0) return { ok: true }
      return {
        ok: false,
        error:
          result.exitCode === EXIT_TIMEOUT
            ? `hermes send timed out after ${timeoutMs} ms`
            : `hermes send exited ${result.exitCode}`,
      }
    } catch (error) {
      return { ok: false, error: error instanceof CannotExecute ? error.message : String(error) }
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

export function makeNotifier(config: { notifyTarget: string; hermesBin: string }): Notifier {
  return config.notifyTarget === NOTIFY_OFF
    ? new NullNotifier()
    : new HermesNotifier({ bin: config.hermesBin, target: config.notifyTarget })
}
