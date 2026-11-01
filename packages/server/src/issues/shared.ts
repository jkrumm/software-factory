import type { IssueState } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { IssueRow } from './read.ts'

/** The end of year 9999. */
export const MAX_TIME_MS = 253_402_300_799_000

export interface InboxRow {
  id: string
  issue_id: number
  key: string
  kind: string
  session: string | null
  at: Date
  payload: Record<string, unknown> | null
  /** the Issue's revision when handling it last threw, and why */
  failed_revision: number | null
  error: string | null
}

export type Context = { tx: SQL; issue: IssueRow; row: InboxRow; now: Date }

export const text = (payload: InboxRow['payload'], name: string): string | null => {
  const value = payload?.[name]
  return typeof value === 'string' && value ? value : null
}

/** A time from a payload as a `Date`, the form Postgres cannot refuse; invalid when it is no time. */
export const time = (payload: InboxRow['payload'], name: string): Date | null => {
  const value = text(payload, name)
  return value === null ? null : new Date(value)
}

/** Not a time, or one outside what Postgres stores (a JavaScript date reaches further). */
export const badTime = (payload: InboxRow['payload'], name: string): boolean => {
  const ms = time(payload, name)?.getTime() ?? 0
  return Number.isNaN(ms) || ms < 0 || ms > MAX_TIME_MS
}

export async function logEvent(
  tx: SQL,
  input: { issueId: number; key: string; kind: string; from: IssueState | null; to: IssueState | null; at: Date },
  payload: Record<string, unknown> | null,
): Promise<void> {
  await tx`
    INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at, payload)
    VALUES (${input.issueId}, ${input.key}, ${input.kind}, ${input.from}, ${input.to}, ${input.at}, ${payload})`
}
