/**
 * What the hook and the server agree on, without zod: the hook is a short-lived process whose start-up time is the
 * budget, so this file imports only `node:fs` (for the per-session lock below). The event kinds, the spool's line, the
 * counting that gives an event its key, and the lock around "read the spool, count, append".
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

export const EVENT_KINDS = [
  'session_started',
  'turn_started',
  'turn_ended',
  'limit_stop',
  'api_error',
  'quota_resume',
  'prompt_blocked',
  'prompt_idle',
  'session_ended',
  'wait_declared',
  'wait_cleared',
  'runner_restarted',
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

/** What an account is called in the registry and in the API: a short token, never free text. The hook and the server both check it. */
export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A role is a word: it ends up in a file name, a CLI argument and a column. */
export const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

// A per-session lock around "read the spool, count, append" (the hook) and "sum, rotate" (the server). Two hooks of one
// session that overlap would count the same turns and write the same key, and the server would drop the second event.
// `mkdir` is the lock: atomic everywhere, no flock needed.

/** How long a holder may keep the lock before it is taken for a crashed one's. Holders keep it for milliseconds. */
export const LOCK_STALE_MS = 2_000
const RETRY_MS = 5

/**
 * Takes `<file>.lock`, waiting up to `budgetMs`. Returns the release, or undefined when the budget ran out: the caller
 * then goes on without the lock (the hook with a key that cannot collide, the server by skipping its rotation).
 *
 * The holder writes a token into the lock; a release removes the lock only while the token is still its own, so a
 * holder whose lock was broken as stale cannot remove its successor's. A stale lock is broken by moving it aside
 * (atomic), never by removing it in place.
 */
export async function tryLock(
  file: string,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<(() => void) | undefined> {
  const path = `${file}.lock`
  const until = now() + budgetMs
  const token = `${process.pid}.${Math.random().toString(36).slice(2)}`
  for (;;) {
    try {
      mkdirSync(path)
      writeFileSync(`${path}/owner`, token)
      return () => {
        try {
          if (readFileSync(`${path}/owner`, 'utf8') !== token) return
          unlinkSync(`${path}/owner`)
          rmSync(path, { recursive: true })
        } catch {
          // already broken as stale, or released: nothing to give back
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    }
    try {
      if (now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        const aside = `${path}.stale.${token}`
        renameSync(path, aside)
        rmSync(aside, { recursive: true, force: true })
      }
    } catch {
      // released or broken by someone else between the two calls
    }
    if (now() >= until) return undefined
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }
}
