import { z } from 'zod'

/** What the factory tells the owner. `test` is `factory notify test`. */
export const NOTIFICATION_KINDS = ['ask', 'parked', 'failed', 'regression', 'digest', 'test'] as const
export const NotificationKind = z.enum(NOTIFICATION_KINDS)
export type NotificationKind = z.infer<typeof NotificationKind>

/** `pending` is unsent and still retried, `failed` has spent its attempts. */
export const NotificationStatus = z.enum(['pending', 'sent', 'failed'])
export type NotificationStatus = z.infer<typeof NotificationStatus>

export const Notification = z.object({
  key: z.string(),
  kind: NotificationKind,
  issueId: z.number().int().nullable(),
  text: z.string(),
  status: NotificationStatus,
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  attempts: z.number().int(),
  error: z.string().nullable(),
})
export type Notification = z.infer<typeof Notification>

export const NotificationList = z.object({ notifications: z.array(Notification) })
export type NotificationList = z.infer<typeof NotificationList>
