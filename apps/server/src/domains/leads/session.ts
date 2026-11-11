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
  /**
   * an `idle` session whose last turn ended with background work in flight (a subagent, a shell, a monitor, as the Stop hook
   * listed it): it pauses until that work wakes it, so it is waiting, not quiet. A later turn, or a session that is not idle, clears it.
   */
  backgroundTasks: boolean
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
 * First match wins, read from the latest `session_started` that begins a life (`startup`, `clear`, `resume` or no source:
 * a restarted process starts clean). A `compact` start does not: Claude Code fires it after a compaction, also mid-turn, so
 * an open turn, the limit wall and the end of an earlier life carry on across it. Its `claudeSessionId` and `transcriptPath`
 * still count, from the latest start of any source.
 * `gone` (the last of start, end and `pane_gone` is not a start; a later hook event withdraws a `pane_gone`, never an end),
 * `working` (a turn started and not ended), `compacted` (the latest start is a compaction and no turn started or ended
 * since), `idle`, and `starting` when no hook has spoken.
 */
export function deriveSession(facts: readonly HookFact[]): SessionView {
  const sorted = [...facts].sort(inOrder)
  const turnStarts = sorted.filter((fact) => fact.kind === 'turn_started')
  const lastStart = sorted.findLastIndex((fact) => fact.kind === 'session_started')
  const lifeStart = sorted.findLastIndex(
    (fact) => fact.kind === 'session_started' && text(fact.payload.source) !== 'compact',
  )
  const current = lifeStart < 0 ? sorted : sorted.slice(lifeStart)
  const start = lastStart < 0 ? undefined : sorted[lastStart]

  let ended = false
  let paneGone = false
  let open = false
  let walled = false
  let turnStartedAt: Date | null = null
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
  const compacted =
    start !== undefined &&
    text(start.payload.source) === 'compact' &&
    !sorted.slice(lastStart + 1).some((fact) => fact.kind === 'turn_started' || fact.kind === 'turn_ended')

  const lastEnd = current.findLast((fact) => fact.kind === 'turn_ended')
  const lastTurn = turnStarts.at(-1)
  const previousTurn = turnStarts.at(-2)
  const last = sorted.at(-1)
  const state: SessionState =
    sorted.length === 0 ? 'starting' : gone ? 'gone' : open ? 'working' : compacted ? 'compacted' : 'idle'
  return {
    state,
    turns: turnStarts.length,
    turnStartedAt: state === 'working' ? turnStartedAt : null,
    lastTurnAt: lastTurn?.at ?? null,
    previousTurnAt: previousTurn?.at ?? null,
    lastEventAt: last?.at ?? null,
    idleSince: quietSince(state, current),
    walled,
    backgroundTasks: state === 'idle' && lastEnd?.payload.backgroundTasks === true,
    claudeSession: text(start?.payload.claudeSessionId),
    transcriptPath: text(start?.payload.transcriptPath),
  }
}
