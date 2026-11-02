import type { SQL } from 'bun'
import { sendDue } from './outbox.ts'
import { NOTIFY_OFF, type Notifier } from './port.ts'
import { notifyDigest, notifyFailures } from './rules.ts'

export interface NotifyDeps {
  notifier: Notifier
  /** `FACTORY_NOTIFY_TARGET`: `off` marks rows as sent without a delivery */
  target: string
  digestAt: string | null
  digestTz: string
  /** whether a place is IuRoot's or a visible root's: its items are only counted in the morning reading (default: a path with an `IuRoot` segment) */
  visible?: () => Promise<(path: string) => boolean>
}

/**
 * The notifier's part of a tick: the rules that read state decide what is due, then unsent rows are sent (at most five, outside
 * any transaction). Returns the errors for the tick's log; nothing here stops the rest of the tick.
 */
export async function notifyPass(sql: SQL, deps: NotifyDeps, now: () => Date): Promise<string[]> {
  const errors: string[] = []
  const guarded = async (name: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work()
    } catch (error) {
      errors.push(`notify ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await guarded('failures', () => notifyFailures(sql, now()))
  await guarded('digest', async () =>
    notifyDigest(sql, {
      now: now(),
      at: deps.digestAt,
      timeZone: deps.digestTz,
      isVisible: deps.visible ? await deps.visible() : undefined,
    }),
  )
  await guarded('send', async () => {
    const note = deps.target === NOTIFY_OFF ? 'notifications are off (FACTORY_NOTIFY_TARGET=off)' : null
    const { errors: sendErrors } = await sendDue(sql, { notifier: deps.notifier, now, note })
    errors.push(...sendErrors.map((e) => `notify ${e}`))
  })
  return errors
}

export { listNotifications, getNotification, notificationAttention, record, sendDue } from './outbox.ts'
export { makeNotifier } from './port.ts'
export type { Notifier } from './port.ts'
