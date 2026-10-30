/**
 * What the hook and the server agree on, without zod: the hook is a short-lived process whose start-up time is the
 * budget, so this file imports nothing. The event kinds, the spool's line, and the counting that gives an event its key.
 */

export const EVENT_KINDS = [
  'session_started',
  'turn_started',
  'turn_ended',
  'limit_stop',
  'quota_resume',
  'prompt_blocked',
  'prompt_idle',
  'session_ended',
  'wait_declared',
  'wait_cleared',
  'herdr_restarted',
  'pane_gone',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** One line of a session's spool file, and the body `POST /events` takes. */
export interface SpoolLine {
  key: string
  session: string
  kind: EventKind
  at: string
  payload?: Record<string, unknown>
}

/**
 * What the lines so far add up to: the turns started, the time of the last line, and how often each kind has occurred
 * in the current turn. A rotated spool leaves this behind (`<file>.base`), so the numbering never starts over.
 */
export interface SpoolSummary {
  turns: number
  lastAt: string | null
  current: Partial<Record<EventKind, number>>
}

export const EMPTY_SUMMARY: SpoolSummary = { turns: 0, lastAt: null, current: {} }

export function summarize(base: SpoolSummary, lines: readonly { kind: string; at: string }[]): SpoolSummary {
  let { turns, lastAt } = base
  let current: Partial<Record<string, number>> = { ...base.current }
  for (const line of lines) {
    if (line.kind === 'turn_started') {
      turns++
      current = { turn_started: 1 }
    } else {
      current[line.kind] = (current[line.kind] ?? 0) + 1
    }
    lastAt = line.at
  }
  return { turns, lastAt, current }
}

/** The sums a rotation left in `<file>.base`; anything unreadable counts as none. */
export function parseSummary(text: string): SpoolSummary {
  try {
    const value = JSON.parse(text) as Partial<SpoolSummary>
    return {
      turns: typeof value.turns === 'number' ? value.turns : 0,
      lastAt: typeof value.lastAt === 'string' ? value.lastAt : null,
      current: value.current && typeof value.current === 'object' ? value.current : {},
    }
  } catch {
    return EMPTY_SUMMARY
  }
}

/**
 * The key of the next event of `kind`: session, event name, turn number. A kind that repeats inside one turn (a second
 * `prompt_idle`, a `session_started` after `/compact`) gets `:2`, `:3`, so it is never taken for a replay of the first.
 * The key is written into the spool line, so a replay carries the key it was born with.
 */
export function nextKey(summary: SpoolSummary, session: string, kind: EventKind): string {
  if (kind === 'turn_started') return `${session}:turn_started:${summary.turns + 1}`
  const ordinal = (summary.current[kind] ?? 0) + 1
  return `${session}:${kind}:${summary.turns}${ordinal > 1 ? `:${ordinal}` : ''}`
}

/** Strictly after the previous line, so the order of a session's events is the order of its spool even within a millisecond. */
export function nextAt(summary: SpoolSummary, nowMs: number): string {
  const last = summary.lastAt ? Date.parse(summary.lastAt) : Number.NEGATIVE_INFINITY
  return new Date(Math.max(nowMs, last + 1)).toISOString()
}

/** A spool file's lines; a line that is not an event (a torn write, a hand edit) is skipped, never fatal. */
export function parseSpool(text: string): SpoolLine[] {
  const lines: SpoolLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw) continue
    try {
      const line = JSON.parse(raw) as Partial<SpoolLine>
      if (typeof line.key === 'string' && typeof line.session === 'string' && typeof line.kind === 'string') {
        lines.push(line as SpoolLine)
      }
    } catch {
      // not a line this format wrote
    }
  }
  return lines
}

/** The file name of a session's spool: the name percent-encoded, so no name can leave the directory or collide. */
export function spoolFileName(session: string): string {
  const encoded = encodeURIComponent(session).replace(/^\./, '%2E')
  return `${encoded}.jsonl`
}

export const defaultSpoolDir = (home: string): string => `${home}/.local/share/factory/spool`
/** Where the server listens for hooks: a unix socket in the owner's directory, so the file's mode is the credential. */
export const defaultHookSocket = (home: string): string => `${home}/.local/share/factory/hook.sock`
