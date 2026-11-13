import { describe, expect, test } from 'bun:test'
import type { EventKind } from '@software-factory/contract/spool'
import {
  type ApiIncident,
  kindOfApiError,
  DEFAULT_RESUME_RULES,
  dueAt,
  edgeIncidents,
  type ErrorPoint,
  type Pending,
  planResumes,
  resumeKey,
  resumeText,
  spent,
} from '../../src/domains/leads/apierror.ts'
import { deriveSession, type HookFact } from '../../src/domains/leads/session.ts'
import { issueId } from '../../src/kernel/ids.ts'
import { apiErrorAbove, atPrompt } from '../../src/adapters/hc/screen.ts'

const CLOUDFLARE = 'Please run /login · API Error: 403 Attention Required! | Cloudflare'

describe('reading an API error', () => {
  test.each([
    // The live incident of 2026-11-13: typed `authentication_failed` and printing /login, and neither a login problem.
    ['the Cloudflare 403', { error: 'authentication_failed', status: 403, text: CLOUDFLARE }, 'transient'],
    ['the same without a status', { error: 'authentication_failed', text: CLOUDFLARE }, 'transient'],
    ['a 429', { error: 'rate_limit', text: 'API Error: 429 Too Many Requests' }, 'transient'],
    ['a 500', { text: 'API Error: 500 Internal server error' }, 'transient'],
    ['a 502', { text: 'API Error: 502 Bad Gateway' }, 'transient'],
    ['a 503', { text: 'API Error: 503 Service Unavailable' }, 'transient'],
    ['a 504', { text: 'API Error: 504 Gateway Timeout' }, 'transient'],
    ['a 529 overloaded', { error: 'overloaded', text: 'API Error: 529 {"type":"overloaded_error"}' }, 'transient'],
    ['a timeout', { text: 'API Error: Request timed out.' }, 'transient'],
    ['a reset', { text: 'API Error: read ECONNRESET' }, 'transient'],
    ['a refused connection', { text: 'API Error: connect ECONNREFUSED' }, 'transient'],
    // The fields, not the words: `server_error` with no status, and a 403 typed `authentication_failed`.
    [
      'a server error mid-response',
      {
        error: 'server_error',
        status: null,
        text: 'API Error: Server error mid-response. The response above may be incomplete.',
      },
      'transient',
    ],
    ['a bare server_error', { error: 'server_error', text: '' }, 'transient'],
    [
      'a 403 typed authentication_failed with no words',
      { error: 'authentication_failed', status: 403, text: '' },
      'transient',
    ],
    ['a 401', { error: 'authentication_failed', status: 401, text: 'Please run /login · API Error: 401' }, 'auth'],
    ['a 401 in the text only', { text: 'Please run /login · API Error: 401 {"type":"authentication_error"}' }, 'auth'],
    ['an expired OAuth token', { text: 'API Error: OAuth token has expired. Please run /login' }, 'auth'],
    ['a revoked token', { text: 'API Error: the token has been revoked' }, 'auth'],
    ['a bare authentication type', { error: 'authentication_failed', text: '' }, 'auth'],
    // `/login` alone says nothing, and neither does a 403 with no challenge.
    ['/login alone', { text: 'Please run /login' }, 'other'],
    ['a plain 403', { status: 403, text: 'API Error: 403 forbidden' }, 'other'],
    ['a bad request', { error: 'invalid_request', text: 'API Error: 400 invalid' }, 'other'],
  ] as const)('%s', (_name, facts, expected) => {
    expect(kindOfApiError(facts).class).toBe(expected)
  })

  test('a response cut off mid-way says so, and its resume note tells the lead to re-check what it did', () => {
    const kind = kindOfApiError({
      error: 'server_error',
      status: null,
      text: 'API Error: Server error mid-response. The response above may be incomplete.',
    })
    expect(kind).toEqual({ class: 'transient', label: 'server error mid-response', partial: true })
    expect(resumeText(kind, 1, 5)).toContain('may be cut off: re-check what you actually did')
    expect(resumeText(kindOfApiError({ text: CLOUDFLARE }), 1, 5)).not.toContain('cut off')
  })

  test('the label names the error', () => {
    expect(kindOfApiError({ status: 403, text: CLOUDFLARE }).label).toBe('Cloudflare challenge 403')
    expect(kindOfApiError({ text: 'API Error: 529 overloaded' }).label).toBe('HTTP 529 overloaded')
  })
})

let seq = 0
const T0 = Date.parse('2026-11-13T09:47:00Z')
const fact = (kind: EventKind, secondsAfter: number, payload: Record<string, unknown> = {}): HookFact => ({
  key: `s:${kind}:${seq}`,
  kind,
  at: new Date(T0 + secondsAfter * 1000),
  seq: seq++,
  payload,
})
const error = (secondsAfter: number, message = CLOUDFLARE) =>
  fact('api_error', secondsAfter, { error: 'authentication_failed', message })

describe('a session whose turn ended on an API error', () => {
  const started = [fact('session_started', 0), fact('turn_started', 1)]

  test('the error ends the turn (no Stop follows it): idle, in an incident that names the error', () => {
    const view = deriveSession([...started, error(30)])
    expect(view.state).toBe('idle')
    expect(view.idleSince).toEqual(new Date(T0 + 30_000))
    expect(view.apiIncident).toMatchObject({
      errors: 1,
      kind: { class: 'transient', label: 'Cloudflare challenge 403' },
    })
  })

  test('a resumed turn that fails again is the same incident; only a turn that ends cleanly closes it', () => {
    const again = deriveSession([...started, error(30), fact('turn_started', 100), error(130)])
    expect(again.apiIncident).toMatchObject({
      errors: 2,
      firstAt: new Date(T0 + 30_000),
      lastAt: new Date(T0 + 130_000),
    })
    const worked = deriveSession([...started, error(30), fact('turn_started', 100), fact('turn_ended', 400)])
    expect(worked.state).toBe('idle')
    expect(worked.apiIncident).toBeNull()
    // while it is working again it is not pending, but the incident stays until the turn ends
    expect(deriveSession([...started, error(30), fact('turn_started', 100)]).state).toBe('working')
  })

  test('an error half an hour after the last is a new incident', () => {
    const view = deriveSession([...started, error(30), fact('turn_started', 100), error(30 + 31 * 60)])
    expect(view.apiIncident).toMatchObject({ errors: 1, firstAt: new Date(T0 + (30 + 31 * 60) * 1000) })
  })
})

const incident = (firstSecond: number, text = CLOUDFLARE, lastSecond = firstSecond): ApiIncident => ({
  key: `s:api_error:${firstSecond}`,
  firstAt: new Date(T0 + firstSecond * 1000),
  lastAt: new Date(T0 + lastSecond * 1000),
  errors: 1,
  kind: kindOfApiError({ text }),
  text,
})
const pending = (n: number, firstSecond: number, over: Partial<Pending> = {}): Pending => ({
  session: `lead-${n}-1`,
  issue: issueId(n),
  attempt: 1,
  account: 'me',
  incident: { ...incident(firstSecond), key: `lead-${n}-1:api_error:${firstSecond}` },
  resumes: [],
  mark: null,
  ...over,
})
const at = (second: number) => new Date(T0 + second * 1000)

describe('the resume plan of a transient error', () => {
  test('a continue after 1 minute, then 3, then 10, 10 and 10, and none after five', () => {
    const resumes: Date[] = []
    const sent: number[] = []
    for (let second = 0; second <= 4_000; second++) {
      const p = pending(1, 0, { resumes })
      const plan = planResumes({ now: at(second), pending: [p], points: [] })
      if (plan.steps.length === 0) continue
      const [step] = plan.steps
      if (step?.kind !== 'resume') throw new Error('a resume was planned')
      expect(step.n).toBe(resumes.length + 1)
      expect(step.key).toBe(resumeKey('lead-1-1', 'lead-1-1:api_error:0', step.n))
      expect(step.text).toContain('Cloudflare challenge 403')
      expect(step.text).toStartWith('continue')
      sent.push(second)
      resumes.push(at(second))
    }
    expect(sent).toEqual([60, 240, 840, 1_440, 2_040])
    expect(spent({ resumes }, DEFAULT_RESUME_RULES)).toBe(true)
    expect(dueAt(pending(1, 0, { resumes }), DEFAULT_RESUME_RULES)).toBeNull()
  })

  test('nothing is due before the first minute', () => {
    expect(planResumes({ now: at(59), pending: [pending(1, 0)], points: [] }).steps).toEqual([])
  })

  test('an error that is neither kind is left to the steward', () => {
    const other = pending(1, 0, { incident: incident(0, 'API Error: 400 invalid request') })
    expect(planResumes({ now: at(900), pending: [other], points: [] }).steps).toEqual([])
  })
})

describe('an edge incident', () => {
  const points = (...entries: [number, number][]): ErrorPoint[] =>
    entries.map(([n, second]) => ({ session: `lead-${n}-1`, key: `k${n}`, at: at(second) }))

  test('three leads within five minutes are one incident; two are not, nor are three spread over ten', () => {
    expect(edgeIncidents(points([1, 0], [2, 100], [3, 290]), DEFAULT_RESUME_RULES)).toEqual([
      { key: 'edge:k1', from: at(0), to: at(290), sessions: ['lead-1-1', 'lead-2-1', 'lead-3-1'] },
    ])
    expect(edgeIncidents(points([1, 0], [2, 100]), DEFAULT_RESUME_RULES)).toEqual([])
    expect(edgeIncidents(points([1, 0], [2, 400], [3, 800]), DEFAULT_RESUME_RULES)).toEqual([])
  })

  test('its leads are resumed one per stagger window, not all at once', () => {
    const burst = [pending(1, 0), pending(2, 10), pending(3, 20)]
    const pts = points([1, 0], [2, 10], [3, 20])
    // all three are due at 60 s+; one goes out, the others wait for the stagger
    const first = planResumes({ now: at(90), pending: burst, points: pts })
    expect(first.steps.map((s) => (s.kind === 'resume' ? s.pending.session : 'x'))).toEqual(['lead-1-1'])
    expect(first.edges).toHaveLength(1)
    const afterFirst = [pending(1, 0, { resumes: [at(90)] }), pending(2, 10), pending(3, 20)]
    expect(planResumes({ now: at(100), pending: afterFirst, points: pts }).steps).toEqual([])
    const second = planResumes({ now: at(121), pending: afterFirst, points: pts })
    expect(second.steps.map((s) => (s.kind === 'resume' ? s.pending.session : 'x'))).toEqual(['lead-2-1'])
  })

  test('leads that failed alone are not held by each other', () => {
    const two = [pending(1, 0), pending(2, 10)]
    const plan = planResumes({ now: at(90), pending: two, points: points([1, 0], [2, 10]) })
    expect(plan.steps).toHaveLength(2)
    expect(plan.edges).toEqual([])
  })
})

describe('the plan of an auth error', () => {
  const login = (n: number, over: Partial<Pending> = {}) =>
    pending(n, 0, { incident: incident(0, 'Please run /login · API Error: 401'), ...over })

  test('the account is marked once however many leads failed on it, and nothing is resumed', () => {
    const plan = planResumes({ now: at(900), pending: [login(1), login(2), login(3, { account: 'iu' })], points: [] })
    expect(plan.steps.map((s) => (s.kind === 'mark_account' ? `${s.account}:${s.sessions.length}` : 'x'))).toEqual([
      'me:2',
      'iu:1',
    ])
  })

  test('a marked account waits for the owner: no second mark, no resume', () => {
    const open = { markedAt: at(10), clearedAt: null }
    expect(planResumes({ now: at(900), pending: [login(1, { mark: open })], points: [] }).steps).toEqual([])
  })

  test('once the owner closed the mark the lead is resumed like a transient one, a minute after', () => {
    const closed = { markedAt: at(10), clearedAt: at(300) }
    expect(planResumes({ now: at(330), pending: [login(1, { mark: closed })], points: [] }).steps).toEqual([])
    const plan = planResumes({ now: at(361), pending: [login(1, { mark: closed })], points: [] })
    expect(plan.steps.map((s) => s.kind)).toEqual(['resume'])
  })

  test('a 401 after the mark was closed is a new login problem: marked again', () => {
    const closed = { markedAt: at(10), clearedAt: at(300) }
    const again = login(1, { mark: closed, incident: incident(500, 'API Error: 401', 500) })
    const plan = planResumes({ now: at(900), pending: [again], points: [] })
    expect(plan.steps.map((s) => s.kind)).toEqual(['mark_account'])
  })
})

describe('the screen of a session that ended on an API error', () => {
  const rule = '─'.repeat(40)
  const screen = (box: string, above = `⏺ ${CLOUDFLARE}`) =>
    ['⏺ Reading the file', '', above, '', rule, box, rule, '  ? for shortcuts'].join('\n')

  test('the error line above an empty prompt is found, and the prompt counts as ready', () => {
    const empty = screen('❯ ')
    expect(apiErrorAbove(empty)).toContain('API Error: 403')
    expect(atPrompt(empty, { pressOnly: true })).toBe(true)
  })

  test('an error further up the conversation, or none, is not the state', () => {
    expect(apiErrorAbove(screen('❯ ', '⏺ Done.'))).toBeNull()
    const old = ['⏺ API Error: 529', '⏺ a', '⏺ b', '⏺ c', '⏺ d', '', rule, '❯ ', rule].join('\n')
    expect(apiErrorAbove(old)).toBeNull()
    expect(apiErrorAbove('no box here')).toBeNull()
  })
})
