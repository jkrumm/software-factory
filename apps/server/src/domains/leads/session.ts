import type { EventKind } from '@software-factory/contract/spool'

/** One hook event of a session as it is stored: `seq` is the order of arrival, which breaks a tie in `at`. */
export interface HookFact {
  key: string
  kind: EventKind
  at: Date
  seq: number
  payload: Record<string, unknown>
}

export const SESSION_STATES = ['starting', 'working', 'idle', 'compacted', 'gone'] as const
export type SessionState = (typeof SESSION_STATES)[number]

/** What a session's hook events say, derived when read; nothing of it is stored. */
export interface SessionView {
  state: SessionState
  /** turns started over the session's whole life: the numbering the spool's keys use, never reset */
  turns: number
  /** when the open turn began, while `working` */
  turnStartedAt: Date | null
  /** when the latest turn began, open or not */
  lastTurnAt: Date | null
  /** when the turn before the latest began */
  previousTurnAt: Date | null
  lastEventAt: Date | null
  /** when an `idle` or `compacted` session went quiet: its last turn ended, or it started with no turn since; null otherwise */
  idleSince: Date | null
  /** a `limit_stop` with no turn after it: the account's window is spent */
  walled: boolean
  claudeSession: string | null
  transcriptPath: string | null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

const inOrder = (a: HookFact, b: HookFact): number => a.at.getTime() - b.at.getTime() || a.seq - b.seq

/** The end of the last turn, or the start of the session if no turn ended since: when a quiet session went quiet. */
function quietSince(state: SessionState, current: readonly HookFact[]): Date | null {
  if (state !== 'idle' && state !== 'compacted') return null
  return current.findLast((fact) => fact.kind === 'turn_ended' || fact.kind === 'session_started')?.at ?? null
}

/**
 * First match wins, read from the latest `session_started` so a resumed or compacted session starts clean:
 * `gone` (the last of start, end and `pane_gone` is not a start; a later hook event withdraws a `pane_gone`, never an end),
 * `working` (a turn started and not ended), `compacted` (started again after a compaction, no turn since), `idle`, and
 * `starting` when no hook has spoken.
 */
export function deriveSession(facts: readonly HookFact[]): SessionView {
  const sorted = [...facts].sort(inOrder)
  const turnStarts = sorted.filter((fact) => fact.kind === 'turn_started')
  const lastStart = sorted.findLastIndex((fact) => fact.kind === 'session_started')
  const current = lastStart < 0 ? sorted : sorted.slice(lastStart)
  const start = lastStart < 0 ? undefined : sorted[lastStart]

  let ended = false
  let paneGone = false
  let open = false
  let walled = false
  let turnStartedAt: Date | null = null
  let turnSinceStart = false
  for (const fact of current) {
    // A hook event is proof of life: it withdraws a lost pane, never a session that ended.
    if (fact.kind !== 'pane_gone') paneGone = false
    switch (fact.kind) {
      case 'session_ended':
        ended = true
        open = false
        break
      case 'pane_gone':
        paneGone = true
        break
      case 'turn_started':
        open = true
        turnSinceStart = true
        walled = false
        turnStartedAt = fact.at
        break
      case 'turn_ended':
        open = false
        break
      case 'limit_stop':
        walled = true
        break
      default:
        break
    }
  }
  const gone = ended || paneGone

  const lastTurn = turnStarts.at(-1)
  const previousTurn = turnStarts.at(-2)
  const last = sorted.at(-1)
  const state: SessionState =
    sorted.length === 0
      ? 'starting'
      : gone
        ? 'gone'
        : open
          ? 'working'
          : start && text(start.payload.source) === 'compact' && !turnSinceStart
            ? 'compacted'
            : 'idle'
  return {
    state,
    turns: turnStarts.length,
    turnStartedAt: state === 'working' ? turnStartedAt : null,
    lastTurnAt: lastTurn?.at ?? null,
    previousTurnAt: previousTurn?.at ?? null,
    lastEventAt: last?.at ?? null,
    idleSince: quietSince(state, current),
    walled,
    claudeSession: text(start?.payload.claudeSessionId),
    transcriptPath: text(start?.payload.transcriptPath),
  }
}
