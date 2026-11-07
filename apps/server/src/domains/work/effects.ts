import type { IssueId } from '../../kernel/ids.ts'
import { type Key, key } from '../../kernel/keys.ts'

/**
 * What a transition asks the world to do, as data. The write path stores them in the outbox in the transition's
 * transaction; the outbox runner calls the port after the commit. A key is built from its parts, so a replay finds the
 * effect it already planned and the port finds the work it already did.
 */
export interface EffectPayloads {
  /** start the attempt's lead */
  start_lead: { attempt: number }
  /** tell the lead what the event of this version says: a note, an answer, a verdict, a wake, a regression */
  note_lead: { attempt: number; version: number }
  /** begin the watch after a ship: its window, then verify */
  start_watch: { attempt: number; watch: number }
  /** end the attempt: its terminals, transcripts, worktree and claim */
  finalize: { attempt: number }
}

export type EffectKind = keyof EffectPayloads
export const EFFECT_KINDS = ['start_lead', 'note_lead', 'start_watch', 'finalize'] as const satisfies EffectKind[]

export type Effect = { [K in EffectKind]: { kind: K; key: Key; payload: EffectPayloads[K] } }[EffectKind]
export type EffectOf<K extends EffectKind> = Extract<Effect, { kind: K }>

/** An effect that outlives a close; every other open effect of a closed Issue is cancelled. */
export const OUTLIVES_CLOSE: readonly EffectKind[] = ['finalize']

export const startLead = (issue: IssueId, attempt: number): Effect => ({
  kind: 'start_lead',
  key: key('start_lead', issue, attempt),
  payload: { attempt },
})

export const noteLead = (issue: IssueId, attempt: number, version: number): Effect => ({
  kind: 'note_lead',
  key: key('note_lead', issue, version),
  payload: { attempt, version },
})

export const startWatch = (issue: IssueId, attempt: number, watch: number): Effect => ({
  kind: 'start_watch',
  key: key('start_watch', issue, watch),
  payload: { attempt, watch },
})

/** One per attempt: a second close of the same attempt plans the same key, which is a no-op. */
export const finalize = (issue: IssueId, attempt: number): Effect => ({
  kind: 'finalize',
  key: key('finalize', issue, attempt),
  payload: { attempt },
})

/** How long the outbox waits before it runs a failed effect again: 30 s, doubling, at most 5 min. */
export function retryDelayMs(failures: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 5 * 60_000)
}
