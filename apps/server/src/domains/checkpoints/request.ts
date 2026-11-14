import { err, ok, type Result } from '../../kernel/result.ts'
import { type Host, HOSTS, hostOf } from '../../kernel/hands.ts'
import type { MissingFields } from './decision.ts'

export { CHECK_BROKEN_NOTE } from '../../kernel/run.ts'

export { type Host, HOSTS, hostOf }

/**
 * A standalone Errand: a request for the owner's hands that no Issue raised. `ask-human.sh` posts one,
 * and so can an agent. It carries what a lead's Errand does not: the command to run, a `check` that exits 0 while it is
 * still needed, an expiry and a key that replaces an older open request with the same key.
 */

export const MAX_TEXT = 4000
export const MAX_COMMAND = 2000
export const MAX_SUMMARY_LINE = 200
/** the key's alphabet and length are `ask-human.sh`'s */
export const KEY_RE = /^[A-Za-z0-9._:/@-]{1,80}$/
const SOURCE_RE = /^[a-z0-9][a-z0-9._:-]{0,39}$/

/** Sources whose requests go through the Errand screen like a lead's Errand: an agent's `ask-human`, which may ask for what a token can do. */
export const SCREENED_SOURCES: readonly string[] = ['ask-human']

/** An Errand with no check and no expiry of its own is closed as expired after this long. */
export const DEFAULT_EXPIRY_MS = 7 * 24 * 3_600_000

export interface RequestInput {
  summary: string
  detail: string | null
  command: string | null
  check: string | null
  host: Host
  source: string
  key: string | null
  /** `null`: never; otherwise the instant it expires */
  expiresAt: Date | null
}

const DURATION = /^(\d+)([mhd])$/
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** `7d`, `36h`, `90m`, an ISO instant or `never`; null when it is none of them. `undefined` is "not given". */
export function readExpiry(raw: string, now: Date): Date | null | 'never' | undefined {
  const text = raw.trim()
  if (text === 'never') return 'never'
  const duration = DURATION.exec(text)
  if (duration) {
    const n = Number(duration[1])
    return n === 0 ? undefined : new Date(now.getTime() + n * UNIT_MS[duration[2] as keyof typeof UNIT_MS])
  }
  const instant = Date.parse(text)
  return Number.isNaN(instant) ? undefined : new Date(instant)
}

const asText = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null)

/** Reads a request: the text, and what rides with it. Every problem is named at once, nothing is stored on a bad one. */
export function readRequest(raw: unknown, now: Date): Result<RequestInput, MissingFields> {
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const problems: string[] = []
  const text = asText(body.text)
  if (text === null) problems.push('text')
  else if (text.length > MAX_TEXT) problems.push(`text (longer than ${MAX_TEXT} characters)`)
  const command = asText(body.command)
  if (command !== null && command.length > MAX_COMMAND) problems.push(`command (longer than ${MAX_COMMAND} characters)`)
  const check = asText(body.check)
  if (check !== null && check.length > MAX_COMMAND) problems.push(`check (longer than ${MAX_COMMAND} characters)`)
  const source = asText(body.source)
  if (source === null || !SOURCE_RE.test(source)) problems.push('source (a short name of who asks: a-z, 0-9, . _ : -)')
  const key = asText(body.key)
  if (key !== null && !KEY_RE.test(key)) problems.push('key (A-Za-z0-9._:/@- , 1-80 characters)')
  const where = asText(body.where)
  if (where !== null && !(HOSTS as readonly string[]).includes(where))
    problems.push(`where (one of ${HOSTS.join(', ')})`)
  let expiresAt: Date | null | undefined
  const given = asText(body.expires)
  if (given !== null) {
    const read = readExpiry(given, now)
    if (read === undefined) problems.push('expires (7d, 36h, 90m, an ISO time or never)')
    else expiresAt = read === 'never' ? null : read
  }
  if (problems.length > 0 || text === null || source === null) {
    return err({ kind: 'missing_field', fields: problems, detail: `a request needs: ${problems.join(', ')}` })
  }
  const [first = '', ...rest] = text.split('\n')
  const summary = first.trim().slice(0, MAX_SUMMARY_LINE)
  const detail = rest.join('\n').trim() !== '' || first.trim().length > MAX_SUMMARY_LINE ? text : null
  return ok({
    summary,
    detail,
    command,
    check,
    host: (where as Host | null) ?? hostOf(`${text}\n${command ?? ''}`),
    source,
    key,
    // no check and no expiry given: the default; a check keeps it until the check says otherwise
    expiresAt:
      expiresAt === undefined ? (check === null ? new Date(now.getTime() + DEFAULT_EXPIRY_MS) : null) : expiresAt,
  })
}

/**
 * How a check ended. `needed`: exit 0. `not_needed`: exit 1..125. `unrunnable`: the check itself could not answer (timeout, a
 * signal, never started). `broken`: a command in it was not found, so whatever it exited with says nothing.
 */
export type CheckVerdict = 'needed' | 'not_needed' | 'unrunnable' | 'broken'

export interface CheckRun {
  /** null: the process did not start, was killed by a signal or timed out */
  exit: number | null
  timedOut: boolean
  output: string
}

/** A shell's own line for a missing command: `sh: sysctl: command not found`, `sh: 1: sysctl: not found`. */
const NOT_FOUND = /(?:^|\n)[^\n]*\b[\w.+-]+: (?:command )?not found[^\n]*(?:\n|$)/

/**
 * A command that is missing (127), not executable (126), killed by a signal (128 and up), timed out or never started says
 * nothing about the need: the Errand stays open and the run is noted. A check that ran and exited 0 or 1..125 but whose
 * output says a command was not found is `broken`: `[ "$(sysctl -n x)" != 1 ]` exits 0 with an empty string when `sysctl`
 * is not on the PATH, and "still needed" would be a lie. Only a check that ran and answered non-zero closes an Errand.
 */
export function checkVerdict(run: CheckRun): CheckVerdict {
  if (run.timedOut || run.exit === null) return 'unrunnable'
  if (run.exit === 127 || (run.exit !== 126 && run.exit < 128 && NOT_FOUND.test(run.output))) return 'broken'
  if (run.exit === 0) return 'needed'
  return run.exit >= 126 ? 'unrunnable' : 'not_needed'
}

/** The first line of a check's output that says a command was not found (or the output's first line). */
export const brokenLine = (output: string): string =>
  (output.split('\n').find((line) => /not found/i.test(line)) ?? output.split('\n')[0] ?? '').trim().slice(0, 160)

export const CHECK_TIMEOUT_MS = 30_000
/** The text of a check that never ran, cut. A ran check's output is kept as its first and last lines (`kernel/run.ts`). */
export const CHECK_OUTPUT_MAX = 2048
/** Checks one pass runs; the rest wait for the next. */
export const CHECKS_PER_PASS = 20
/** A check that could not run this many passes in a row is said so on the Errand. */
export const CHECK_FAILS_NOTED = 3

/** The still-needed workflow looks at an Errand with no check after this long, and again after the same. */
export const NEEDED_AFTER_MS = 24 * 3_600_000
export const NEEDED_PER_PASS = 5

/** What a loop closure leaves as the Errand's note. */
export const closedNote = (kind: 'not_needed' | 'expired' | 'superseded', why: string): string => {
  const head = kind === 'not_needed' ? 'No longer needed' : kind === 'expired' ? 'Expired' : 'Superseded'
  return why === '' ? head : `${head}: ${why}`
}

/** A request as the still-needed look reads another one of the same source. */
export interface RequestFacts {
  id: string
  summary: string
  raisedAt: Date
  doneAt: Date | null
  closedKind: string | null
  closedBy: string | null
  doneNote: string | null
}

const EVIDENCE_MAX = 3500
const EVIDENCE_LINE = 280

/** What the factory holds about the same source's other requests: each with its age and how it ended, newest last. The model is told it is data. */
export function evidenceLines(
  own: string,
  others: readonly RequestFacts[],
  now: Date,
  clean: (text: string) => string,
): string {
  const hours = (from: Date): number => Math.max(0, Math.round((now.getTime() - from.getTime()) / 3_600_000))
  const lines = others
    .filter((other) => other.id !== own)
    .map((other) => {
      const state = other.doneAt
        ? `closed ${hours(other.doneAt)} h ago as ${other.closedKind ?? 'done'} by ${other.closedBy ?? 'unknown'}${other.doneNote ? ` (${clean(other.doneNote)})` : ''}`
        : 'open'
      return `raised ${hours(other.raisedAt)} h ago, ${state}: ${clean(other.summary)}`.slice(0, EVIDENCE_LINE)
    })
  while (lines.length > 1 && lines.join('\n').length > EVIDENCE_MAX) lines.shift()
  return lines.length === 0
    ? 'No other request from this source in the last 14 days.'
    : lines.join('\n').slice(0, EVIDENCE_MAX)
}

/** The days a closed request still counts as evidence. */
export const EVIDENCE_DAYS = 14
