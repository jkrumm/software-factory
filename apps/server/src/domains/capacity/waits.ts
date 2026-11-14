/**
 * What a queued Issue waits for, kept as intervals (`factory.queue_intervals`): the rules that turn one admission look into
 * the changes to the stored intervals. Pure: the stored open intervals and the look are passed in.
 */

import { MEMORY_FIT_KIND } from '../../kernel/throughput-limits.ts'

/** The interval kind of a refusal: its queue kind, with the memory gate's lead-fit refusal as its own kind (`MEMORY_FIT_KIND`). */
export const waitKindOf = (reason: { kind: string; part?: 'fit' }): string =>
  reason.kind === 'memory' && reason.part === 'fit' ? MEMORY_FIT_KIND : reason.kind

/** The interval an Issue has open. */
export interface OpenWait {
  id: number
  issue: string
  kind: string
}

/** One queued Issue of the look, with the reason it stays queued. */
export interface SeenWait {
  issue: string
  /** the project name its repo is stored as */
  project: string
  kind: string
  message: string
}

export interface WaitPlan {
  /** the open intervals that end at the look: the Issue left the queue, or its reason changed kind */
  close: number[]
  /** the intervals that begin at the look: a newly queued Issue, or one whose reason changed kind */
  start: SeenWait[]
}

/** An Issue's interval ends when it is no longer queued for a reason, and a new one begins only when the kind changes. */
export function planWaits(open: readonly OpenWait[], seen: readonly SeenWait[]): WaitPlan {
  const byIssue = new Map(seen.map((s) => [s.issue, s]))
  const openByIssue = new Map(open.map((o) => [o.issue, o]))
  return {
    close: open.filter((o) => byIssue.get(o.issue)?.kind !== o.kind).map((o) => o.id),
    start: seen.filter((s) => openByIssue.get(s.issue)?.kind !== s.kind),
  }
}
