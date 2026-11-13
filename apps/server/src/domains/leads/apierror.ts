import type { IssueId } from '../../kernel/ids.ts'

/**
 * A lead's turn that ended on an API error (Claude Code's `StopFailure` hook, or the error line at the end of its
 * transcript). What the factory does about it depends on the class: a `transient` error is the edge's or the API's and a
 * `continue` gets the session going again; an `auth` error is the account's login and only a person can mend it;
 * anything else (`other`) is left to the steward's usual nudge.
 */
export type ApiErrorClass = 'transient' | 'auth' | 'other'

export interface ApiErrorKind {
  class: ApiErrorClass
  /** a few words for a note and a line: "Cloudflare 403", "HTTP 529 overloaded" */
  label: string
  /** the error came in the middle of a response ("Server error mid-response. The response above may be incomplete."): what the lead did last may be cut off */
  partial?: boolean
}

/** What a turn's error left behind. `status` is Claude Code's `apiErrorStatus` when the transcript carries one. */
export interface ApiErrorText {
  /** Claude Code's error type (`authentication_failed`, `overloaded`, ...); it does not decide alone, see `kindOfApiError` */
  error?: string | null
  status?: number | null
  /** the rendered error text, "Please run /login · API Error: 403 Attention Required! | Cloudflare" */
  text: string
}

const CLOUDFLARE = /attention required|cloudflare|cf-ray|checking your browser|just a moment/i
const AUTH_TEXT =
  /oauth token (has )?(expired|been revoked|revoked)|token (has been )?revoked|invalid (x-api-key|api key|authentication credentials|bearer token)|authentication_error|not logged in/i
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529])
const TRANSIENT_TEXT =
  /overloaded|timed? ?out|timeout|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network (error|connection)|connection (error|reset|refused|closed)|temporarily unavailable|internal server error|bad gateway|service unavailable|gateway time-?out|upstream/i
const PARTIAL = /mid-response|response above may be incomplete/i
const TRANSIENT_TYPES = new Set(['overloaded', 'server_error', 'rate_limit'])
const AUTH_TYPES = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold'])

const statusOf = (facts: ApiErrorText): number | null => {
  if (typeof facts.status === 'number' && facts.status >= 100 && facts.status <= 599) return facts.status
  const match = /API Error:?\s*(\d{3})\b/i.exec(facts.text) ?? /\b(40[0-9]|5\d\d)\b/.exec(facts.text)
  return match?.[1] ? Number(match[1]) : null
}

/**
 * Transient or auth, from the rendered text and the status before the error type. The type alone is wrong in the one case
 * that matters: Claude Code prints "Please run /login" and types the error `authentication_failed` for a Cloudflare 403
 * challenge, which needs no login at all (2026-11-13: 33 turns on three accounts, none needed a re-login). So a Cloudflare
 * page is transient whatever else the line says; a 401, an expired or revoked token and its kin are auth; a 429, 5xx, a
 * timeout or a reset is transient; anything else (a 403 with no challenge, a bad request, billing) is `other`.
 */
export function kindOfApiError(facts: ApiErrorText): ApiErrorKind {
  const kind = sortApiError(facts)
  return PARTIAL.test(facts.text) ? { ...kind, partial: true } : kind
}

function sortApiError(facts: ApiErrorText): ApiErrorKind {
  const status = statusOf(facts)
  const at = status === null ? '' : ` ${status}`
  if (CLOUDFLARE.test(facts.text)) return { class: 'transient', label: `Cloudflare challenge${at}` }
  if (status === 401 || AUTH_TEXT.test(facts.text)) {
    return { class: 'auth', label: status === null ? 'authentication failed' : `HTTP ${status} authentication failed` }
  }
  // The fields Claude Code writes (`error`, `apiErrorStatus`) before the words: all ten 403s typed `authentication_failed` on
  // 2026-11-13 were a Cloudflare challenge (a real login failure is a 401), whether or not the text still says so.
  if (status === 403 && facts.error === 'authentication_failed') {
    return { class: 'transient', label: 'HTTP 403 edge challenge' }
  }
  if (status !== null && TRANSIENT_STATUS.has(status)) {
    const overloaded = /overloaded/i.test(facts.text) || status === 529
    return { class: 'transient', label: `HTTP ${status}${overloaded ? ' overloaded' : ''}` }
  }
  if (TRANSIENT_TEXT.test(facts.text)) return { class: 'transient', label: 'network or server error' }
  if (facts.error && TRANSIENT_TYPES.has(facts.error)) {
    return { class: 'transient', label: PARTIAL.test(facts.text) ? 'server error mid-response' : facts.error }
  }
  if (PARTIAL.test(facts.text)) return { class: 'transient', label: 'server error mid-response' }
  // A bare type with no status and no text is all there is: an authentication type then is a login.
  if (status === null && facts.error && AUTH_TYPES.has(facts.error)) {
    return { class: 'auth', label: 'authentication failed' }
  }
  return { class: 'other', label: status === null ? (facts.error ?? 'API error') : `HTTP ${status}` }
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** An `api_error` hook fact's payload (`error`, `details`, `message`, and `status` from the transcript), read. */
export function kindOfPayload(payload: Record<string, unknown>): ApiErrorKind & { text: string } {
  const text = textOf(payload.message) ?? textOf(payload.details) ?? ''
  const kind = kindOfApiError({
    error: textOf(payload.error),
    status: typeof payload.status === 'number' ? payload.status : null,
    text,
  })
  return { ...kind, text }
}

// --- the incident, as the hook facts spell it ------------------------------------------------------------------------

/** A gap this long between two errors of a session makes the second a new incident, whatever came in between. */
export const INCIDENT_GAP_MS = 30 * 60_000

/** One session's open incident: the API errors since its last clean turn end, in the order they came. */
export interface ApiIncident {
  /** the key of the first error: what the resume deliveries and the edge incident are keyed on */
  key: string
  firstAt: Date
  lastAt: Date
  errors: number
  kind: ApiErrorKind
  text: string
}

// --- the resume plan -------------------------------------------------------------------------------------------------

/** After the error, then after each `continue` that did not hold: 1 min, 3, 10, then 10 again. */
export const RESUME_DELAYS_MS: readonly number[] = [60_000, 180_000, 600_000, 600_000, 600_000]

/** Leads that fail within this long of each other, three or more, are one incident of the edge, not three. */
export const EDGE_WINDOW_MS = 5 * 60_000
export const EDGE_MIN_LEADS = 3

/** Of an edge incident's leads, one is resumed per this long. */
export const STAGGER_MS = 30_000

export interface ResumeRules {
  delaysMs: readonly number[]
  staggerMs: number
  edgeWindowMs: number
  edgeMinLeads: number
}

export const DEFAULT_RESUME_RULES: ResumeRules = {
  delaysMs: RESUME_DELAYS_MS,
  staggerMs: STAGGER_MS,
  edgeWindowMs: EDGE_WINDOW_MS,
  edgeMinLeads: EDGE_MIN_LEADS,
}

/** An account's login mark as the plan reads it: closed (`clearedAt` set) once the owner has done the Errand. */
export interface AuthMark {
  markedAt: Date
  clearedAt: Date | null
}

/** A session whose turn ended on an API error and has not started a turn since, with what was done about it. */
export interface Pending {
  session: string
  issue: IssueId
  attempt: number
  account: string | null
  incident: ApiIncident
  /** when each `continue` of this incident was claimed, oldest first */
  resumes: readonly Date[]
  /** the account's mark; null: none was ever set */
  mark: AuthMark | null
}

/** One API error of one session as a point on the clock: what edge incidents are found in. */
export interface ErrorPoint {
  session: string
  key: string
  at: Date
}

export type Step =
  | { kind: 'resume'; pending: Pending; n: number; key: string; text: string }
  | { kind: 'mark_account'; account: string; sessions: string[]; label: string }

/** A burst of transient errors across leads: one backoff and one friction row, whatever the number of leads. */
export interface EdgeIncident {
  /** `edge:` and the key of the first error: stable while more leads join */
  key: string
  from: Date
  to: Date
  sessions: string[]
}

export interface Plan {
  steps: Step[]
  edges: EdgeIncident[]
}

/** The delivery key of a session's nth `continue` (1-based) of an incident. */
export const resumeKey = (session: string, incident: string, n: number): string => `resume:${session}:${incident}:${n}`
export const resumePrefix = (session: string, incident: string): string => `resume:${session}:${incident}:`

/**
 * The text typed for a resume: one line, never starting with `-`, and plain about being the factory's. A lead that reads
 * it knows the error was not its own doing and where to pick up.
 */
export function resumeText(kind: ApiErrorKind, n: number, max: number): string {
  const cut = kind.partial
    ? ' The error came in the middle of your response, so the last thing you did may be cut off: re-check what you actually did (files, commands, the Issue) before going on.'
    : ''
  return `continue. Factory note, as data: your turn ended on an API error (${kind.label}), not on anything you did; the account is fine.${cut} Carry on where you stopped (resume ${n} of ${max}).`
}

/** Edge incidents: greedily, the first error and every error of another session within `edgeWindowMs` of it, from `edgeMinLeads` sessions on. */
export function edgeIncidents(points: readonly ErrorPoint[], rules: ResumeRules): EdgeIncident[] {
  const sorted = [...points].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.key < b.key ? -1 : 1))
  const found: EdgeIncident[] = []
  let index = 0
  while (index < sorted.length) {
    const first = sorted[index]
    if (!first) break
    const within = sorted.slice(index).filter((p) => p.at.getTime() - first.at.getTime() <= rules.edgeWindowMs)
    const sessions = [...new Set(within.map((p) => p.session))]
    if (sessions.length >= rules.edgeMinLeads) {
      found.push({ key: `edge:${first.key}`, from: first.at, to: within.at(-1)?.at ?? first.at, sessions })
    }
    index += within.length
  }
  return found
}

/**
 * When a pending transient session is due its next `continue`, or null once the incident's resumes are spent. The clock
 * starts at the last `continue` (or the first error), and for an account the owner logged in again at the later of that and
 * the login.
 */
export function dueAt(pending: Pending, rules: ResumeRules): Date | null {
  const n = pending.resumes.length
  const delay = rules.delaysMs[n]
  if (delay === undefined) return null
  const anchors = [pending.resumes.at(-1) ?? pending.incident.firstAt]
  if (pending.mark?.clearedAt && pending.mark.clearedAt > pending.incident.lastAt) anchors.push(pending.mark.clearedAt)
  return new Date(Math.max(...anchors.map((a) => a.getTime())) + delay)
}

/** Whether the resumes of a pending session are spent: the steward's nudge is the lead's only help from then on. */
export const spent = (pending: Pick<Pending, 'resumes'>, rules: ResumeRules): boolean =>
  pending.resumes.length >= rules.delaysMs.length

/**
 * What a pass does about the sessions that ended a turn on an API error, from facts alone.
 *  - transient: `continue` once `dueAt` has passed, `delaysMs.length` times at most. In an edge incident the leads share
 *    one clock and one `continue` goes out per `staggerMs` among them, so the edge is not hit by all of them at once.
 *  - auth: the account is marked once (a step per account, however many leads), and nothing else is done; leads on an
 *    account whose mark the owner has closed since are resumed as a transient error is.
 *  - other: nothing.
 */
export function planResumes(input: {
  now: Date
  pending: readonly Pending[]
  points: readonly ErrorPoint[]
  rules?: ResumeRules
}): Plan {
  const rules = input.rules ?? DEFAULT_RESUME_RULES
  const { now } = input
  const edges = edgeIncidents(input.points, rules)
  const edgeOf = new Map<string, EdgeIncident>()
  for (const edge of edges) for (const session of edge.sessions) edgeOf.set(session, edge)

  const steps: Step[] = []
  const marked = new Set<string>()
  const stagger = new Set<string>()
  const ordered = [...input.pending].sort(
    (a, b) => a.incident.firstAt.getTime() - b.incident.firstAt.getTime() || (a.session < b.session ? -1 : 1),
  )
  for (const pending of ordered) {
    const { incident } = pending
    if (incident.kind.class === 'other') continue
    const reopened = pending.mark?.clearedAt != null && pending.mark.clearedAt > incident.lastAt
    if (incident.kind.class === 'auth' && !reopened) {
      const open = pending.mark?.clearedAt === null
      // A mark closed before this error does not hold for it: the login broke again.
      if (pending.account && !open && !marked.has(pending.account)) {
        marked.add(pending.account)
        steps.push({
          kind: 'mark_account',
          account: pending.account,
          sessions: ordered.filter((p) => p.account === pending.account).map((p) => p.session),
          label: incident.kind.label,
        })
      }
      continue
    }
    const due = dueAt(pending, rules)
    if (!due || due > now) continue
    const edge = edgeOf.get(pending.session)
    if (edge) {
      // One `continue` per stagger window across the edge's leads: another member's resume claimed a moment ago holds this one.
      const lastMember = ordered
        .filter((p) => edge.sessions.includes(p.session))
        .flatMap((p) => p.resumes)
        .reduce((latest, at) => Math.max(latest, at.getTime()), 0)
      if (now.getTime() - lastMember < rules.staggerMs || stagger.has(edge.key)) continue
      stagger.add(edge.key)
    }
    const n = pending.resumes.length + 1
    steps.push({
      kind: 'resume',
      pending,
      n,
      key: resumeKey(pending.session, incident.key, n),
      text: resumeText(incident.kind, n, rules.delaysMs.length),
    })
  }
  return { steps, edges }
}
