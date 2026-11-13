import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AdmitAnswer } from '@software-factory/contract'
import { readState, statePathOf, withState, type FakeTerminal } from '../fakes/hc-state.ts'
import { hook, sessionOf } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop, working as workingIn } from '../loops/support.ts'

/**
 * A lead whose turn ends on an API error, against the real server and Postgres with the fake hc: a Cloudflare 403 (which
 * Claude Code types `authentication_failed` and prints with "Please run /login") is resumed on a backoff and never taken for
 * a login; a burst across leads is one edge incident, resumed staggered; a 401 marks the account and raises one Errand.
 * Time is moved by ageing the stored facts, so the real 1 / 3 / 10 minute rules run.
 */
setDefaultTimeout(120_000)

let lab: Lab
let dir: string
let projects: string

const REPOS = ['app', 'app2', 'app3']
const CLOUDFLARE = 'Please run /login · API Error: 403 Attention Required! | Cloudflare'
const LOGIN = 'Please run /login · API Error: 401 {"type":"authentication_error"}'
const RULE = '─'.repeat(60)

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-apierr-')
  projects = join(dir, 'config', 'projects')
  await mkdir(projects, { recursive: true })
  const registry = join(dir, 'accounts.json')
  await writeFile(registry, JSON.stringify({ accounts: { me: { dir: join(dir, 'config') } } }))
  lab = await startLab({
    leads: true,
    // a project holds at most 8 leads and the lead of an earlier test keeps its claim: the leads are spread over three repos
    repos: Object.fromEntries(
      REPOS.map((name) => [name, { project: `apiVersion: factory/v2\nname: ${name}\nleads: 8\n` }]),
    ),
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_ACCOUNTS_FILE: registry,
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_STEWARD_IDLE_MS: '0',
      FACTORY_STEWARD_IDLE_BACKGROUND_MS: '0',
      FACTORY_API_DETECT_MS: '0',
      FACTORY_API_PROBE_MS: '0',
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

// Each test counts its own leads: the ones before it are no longer followed.
afterEach(async () => {
  await lab.world.db.sql`UPDATE factory.lead_attempts SET gone_at = now() WHERE gone_at IS NULL`
})

let spread = 0
/** An Issue with its lead working, in the next repo of the three. */
const working = (_lab: Lab, _repo: string, title: string) =>
  workingIn(lab, REPOS[spread++ % REPOS.length] ?? 'app', title)

const statePath = () => statePathOf(join(lab.world.bin, 'calls.jsonl'))
const terminalOf = (session: string): FakeTerminal => {
  const found = Object.values(readState(statePath()).terminals).find(
    (terminal) => terminal.state === 'live' && terminal.labels['factory.key'] === session,
  )
  if (!found) throw new Error(`no live terminal ${session}`)
  return found
}

/** The session starts and its first turn opens, as Claude Code does with the brief. */
async function open(issue: string, transcript?: string): Promise<string> {
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, {
    source: 'startup',
    session_id: `c-${issue}`,
    ...(transcript ? { transcript_path: transcript } : {}),
  })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })
  return session
}

/** What herdr-core shows once Claude Code printed the error: the core calls it `blocked`, the screen shows an empty prompt. */
async function showError(session: string, line: string, draft = ''): Promise<void> {
  const screen = ['⏺ Reading the file', '', `⏺ ${line}`, '', RULE, `❯ ${draft}`, RULE, '  ? for shortcuts'].join('\n')
  const { address } = terminalOf(session)
  await withState(statePath(), (state) => {
    const terminal = state.terminals[address]
    if (!terminal) throw new Error('terminal vanished')
    terminal.status = { state: 'blocked' }
    terminal.screen = screen
  })
}

const fail = (session: string, message: string, error = 'authentication_failed') =>
  hook(lab.world, 'stop-failure', session, { error, last_assistant_message: message })

/** Moves time on: every stored hook fact (so the order of a session's events holds) and every `continue` is that many seconds older. */
async function age(seconds: number): Promise<void> {
  await lab.world.db.sql`UPDATE factory.lead_hook_events SET at = at - ${seconds} * interval '1 second'`
  await lab.world.db
    .sql`UPDATE factory.lead_deliveries SET claimed_at = claimed_at - ${seconds} * interval '1 second' WHERE kind = 'resume'`
  await lab.world.db
    .sql`UPDATE factory.account_auth_marks SET cleared_at = cleared_at - ${seconds} * interval '1 second' WHERE cleared_at IS NOT NULL`
}

const tickAnswer = async () => {
  const ran = await runLoop(lab, 'leads')
  expect(ran.error).toBeNull()
  return JSON.parse(/api errors (\{.*\})$/.exec(ran.summary ?? '')?.[1] ?? '{}') as {
    detected: number
    resumed: number
    marked: number
    cleared: number
    edges: number
  }
}

const idleNotes = async (issue: string): Promise<string[]> => {
  const rows = await lab.world.db
    .sql`SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND actor = 'steward' AND result = 'applied'`
  return rows.map((row: { text: string }) => row.text)
}

test('a Cloudflare 403 is resumed after 1 minute, then 3, 10, 10, 10 and never a sixth time; the steward stays silent meanwhile', async () => {
  const issue = await working(lab, 'app', 'the probe on /health fails')
  const session = await open(issue)
  await showError(session, CLOUDFLARE)
  expect((await fail(session, CLOUDFLARE)).code).toBe(0)

  // before the first minute: nothing is typed, and the steward does not nudge a session the API-error path handles
  expect((await tickAnswer()).resumed).toBe(0)
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 0')
  expect(await idleNotes(issue)).toEqual([])
  expect(terminalOf(session).sent).toEqual([])

  const waits = [61, 181, 601, 601, 601]
  for (const [index, seconds] of waits.entries()) {
    await age(seconds)
    expect((await tickAnswer()).resumed).toBe(1)
    // the same pass again types nothing twice
    expect((await tickAnswer()).resumed).toBe(0)
    expect(terminalOf(session).sent).toHaveLength(index + 1)
  }
  const terminal = terminalOf(session)
  expect(terminal.sent[0]).toStartWith('continue')
  expect(terminal.sent[0]).toContain('Cloudflare challenge 403')
  expect(terminal.sent[0]).not.toContain('\n')
  // typed with the core's override, and only because the screen showed the error above an empty prompt
  expect(terminal.forced).toEqual([0, 1, 2, 3, 4])
  expect(terminal.keys ?? []).toEqual([])

  // five were spent: no sixth, however long it waits
  await age(3_600)
  expect((await tickAnswer()).resumed).toBe(0)
  expect(terminalOf(session).sent).toHaveLength(5)

  const deliveries = await lab.world.db
    .sql`SELECT key FROM factory.lead_deliveries WHERE issue_id = ${issue} AND kind = 'resume' ORDER BY claimed_at`
  expect(deliveries).toHaveLength(5)
  // no edge incident for one lead, and no account was marked
  expect(await lab.world.db.sql`SELECT 1 FROM factory.api_edge_incidents`).toHaveLength(0)
  expect(await lab.world.db.sql`SELECT 1 FROM factory.account_auth_marks`).toHaveLength(0)

  // with the resumes spent the steward nudges it like any quiet lead
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 1')
})

test('a resumed turn that starts ends the incident: the next error is a new one with a fresh count', async () => {
  const issue = await working(lab, 'app', 'the queue stalls on a long job')
  const session = await open(issue)
  await showError(session, CLOUDFLARE)
  await fail(session, CLOUDFLARE)
  await age(61)
  expect((await tickAnswer()).resumed).toBe(1)
  // the lead's turn begins and ends cleanly
  await hook(lab.world, 'user-prompt-submit', session, { session_id: 'again' })
  await hook(lab.world, 'stop', session, { stop_hook_active: false, background_tasks: [{ status: 'running' }] })
  expect((await tickAnswer()).resumed).toBe(0)
  await fail(session, 'API Error: 529 {"type":"overloaded_error"}', 'overloaded')
  await age(61)
  expect((await tickAnswer()).resumed).toBe(1)
  expect(terminalOf(session).sent).toHaveLength(2)
  expect(terminalOf(session).sent[1]).toContain('resume 1 of 5')
})

test('a draft in the prompt is submitted, never appended to', async () => {
  const issue = await working(lab, 'app', 'the review of the range is pending')
  const session = await open(issue)
  await showError(session, CLOUDFLARE, 'run /review on the range')
  await fail(session, CLOUDFLARE)
  await age(61)
  expect((await tickAnswer()).resumed).toBe(1)
  const terminal = terminalOf(session)
  expect(terminal.sent).toEqual([])
  expect(terminal.keys).toEqual([['enter']])
})

test('a screen that is not the API-error state gets nothing typed', async () => {
  const issue = await working(lab, 'app', 'a dialog is open')
  const session = await open(issue)
  const { address } = terminalOf(session)
  await withState(statePath(), (state) => {
    const terminal = state.terminals[address]
    if (!terminal) throw new Error('terminal vanished')
    terminal.status = { state: 'blocked' }
    terminal.screen = [
      '⏺ API Error: 403 Attention Required! | Cloudflare',
      RULE,
      '❯ 1. Yes',
      '  2. No',
      RULE,
      '  Esc to cancel',
    ].join('\n')
  })
  await fail(session, CLOUDFLARE)
  await age(61)
  expect((await tickAnswer()).resumed).toBe(0)
  expect(terminalOf(session).sent).toEqual([])
  expect(terminalOf(session).keys ?? []).toEqual([])
  // nothing was typed, so no resume was spent: the claim was given back and the next pass looks again
  expect(
    await lab.world.db.sql`SELECT 1 FROM factory.lead_deliveries WHERE issue_id = ${issue} AND kind = 'resume'`,
  ).toHaveLength(0)
  expect((await tickAnswer()).resumed).toBe(0)
})

test('a turn that ended on an error with no StopFailure hook is found in the transcript and resumed', async () => {
  const transcript = join(projects, 'tail.jsonl')
  const issue = await working(lab, 'app', 'the hook is not installed')
  const session = await open(issue, transcript)
  await showError(session, CLOUDFLARE)
  const line = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: CLOUDFLARE }] },
    error: 'authentication_failed',
    isApiErrorMessage: true,
    apiErrorStatus: 403,
  }
  await writeFile(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go on' } }),
      JSON.stringify(line),
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
    ].join('\n'),
  )
  // the session looks mid-turn; the tail says otherwise
  const found = await tickAnswer()
  expect(found.detected).toBe(1)
  const view = JSON.parse((await lab.cli(['lead', 'get', issue])).out) as { state: string }
  expect(view.state).toBe('idle')
  await age(61)
  expect((await tickAnswer()).resumed).toBe(1)
  expect(terminalOf(session).sent[0]).toContain('Cloudflare challenge 403')
  // read again, the same error is the same fact
  expect((await tickAnswer()).detected).toBe(0)
})

test('an error in the middle of a response (core status "error", no HTTP status) is resumed with a note that the last response may be cut off', async () => {
  const transcript = join(projects, 'mid.jsonl')
  const issue = await working(lab, 'app', 'the response was cut off')
  const session = await open(issue, transcript)
  const message = 'API Error: Server error mid-response. The response above may be incomplete.'
  await showError(session, message)
  const { address } = terminalOf(session)
  await withState(statePath(), (state) => {
    const terminal = state.terminals[address]
    if (terminal) terminal.status = { state: 'error' }
  })
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: message }] },
      error: 'server_error',
      isApiErrorMessage: true,
      apiErrorStatus: null,
    }),
  )
  expect((await tickAnswer()).detected).toBe(1)
  await age(61)
  expect((await tickAnswer()).resumed).toBe(1)
  const [sent] = terminalOf(session).sent
  expect(sent).toContain('server error mid-response')
  expect(sent).toContain('re-check what you actually did')
})

test('three leads that fail within five minutes are one edge incident: resumed staggered, one friction row', async () => {
  // the earlier tests left their leads behind; this one counts its own
  const issues = [
    await working(lab, 'app', 'edge incident one'),
    await working(lab, 'app', 'edge incident two'),
    await working(lab, 'app', 'edge incident three'),
  ]
  const sessions: string[] = []
  for (const issue of issues) {
    const session = await open(issue)
    sessions.push(session)
    await showError(session, CLOUDFLARE)
    await fail(session, CLOUDFLARE)
  }
  // The owner's own plan session hit the same edge: counted in the row, never typed into.
  await withState(statePath(), (state) => {
    state.terminals.tplan = {
      address: 'tplan',
      labels: {},
      state: 'live',
      status: { state: 'blocked' },
      reported: true,
      turn: 0,
      exit_code: null,
      argv: ['claude'],
      cwd: '/tmp',
      env: {},
      name: 'plan-app-abc123',
      screen: ['⏺ Reading', '', `⏺ ${CLOUDFLARE}`, '', RULE, '❯ ', RULE].join('\n'),
      sent: [],
    }
  })
  await age(61)
  const sentBefore = sessions.map((s) => terminalOf(s).sent.length)
  // one goes out now; the others wait for the stagger
  const first = await tickAnswer()
  expect(first.resumed).toBe(1)
  expect(first.edges).toBeGreaterThanOrEqual(1)
  expect((await tickAnswer()).resumed).toBe(0)
  await age(31)
  expect((await tickAnswer()).resumed).toBe(1)
  await age(31)
  expect((await tickAnswer()).resumed).toBe(1)
  const sentAfter = sessions.map((s) => terminalOf(s).sent.length)
  expect(sentAfter.map((n, i) => n - (sentBefore[i] ?? 0))).toEqual([1, 1, 1])

  // the same leads fail again after a resume, more than five minutes on: the same outage again, not another row
  await age(400)
  for (const session of sessions) {
    await hook(lab.world, 'user-prompt-submit', session, { session_id: 'again' })
    await showError(session, CLOUDFLARE)
    await fail(session, CLOUDFLARE)
  }
  await tickAnswer()

  // one row, with the leads and the window
  const edges = await lab.world.db.sql`SELECT key, leads, plans FROM factory.api_edge_incidents`
  expect(edges).toHaveLength(1)
  expect(edges[0]?.leads).toBeGreaterThanOrEqual(3)
  expect(edges[0]?.plans).toBe(1)
  expect(readState(statePath()).terminals.tplan?.sent).toEqual([])
  // and the friction read carries it as `api_transient`
  const friction = await lab.cli(['read', 'friction', '--days', '1'])
  const counts = (friction.json as { counts: { key: string; group: string; count: number }[] }).counts
  expect(counts.find((c) => c.key === 'api_transient:total')?.count).toBe(1)
  const row = counts.filter((c) => c.group === 'api_transient' && !c.key.endsWith(':total'))
  expect(row).toHaveLength(1)
  expect((row[0] as unknown as { label: string }).label).toContain('1 plan sessions (not resumed)')
})

test('a 401 marks the account once, raises one Errand, stops admissions on it and resumes its leads when the Errand is done', async () => {
  const issue = await working(lab, 'app', 'the login broke')
  const session = await open(issue)
  const second = await working(lab, 'app', 'a second lead on the same account')
  const secondSession = await open(second)
  for (const [s] of [[session], [secondSession]] as const) {
    await showError(s, LOGIN)
    await fail(s, LOGIN)
  }
  await age(3_600)

  const first = await tickAnswer()
  expect(first.marked).toBe(1)
  expect(first.resumed).toBe(0)
  const errands = await lab.world.db
    .sql`SELECT id, request_key, command FROM factory.errands WHERE request_key = 'account-login:me' AND done_at IS NULL`
  expect(errands).toHaveLength(1)
  expect(errands[0]?.command).toContain('claude-relogin me')
  // asked again by the next pass: the same Errand, no second mark
  const again = await tickAnswer()
  expect(again.marked).toBe(0)
  expect(await lab.world.db.sql`SELECT 1 FROM factory.errands WHERE request_key = 'account-login:me'`).toHaveLength(1)
  // nothing was typed into either lead: the factory moves nothing
  expect(terminalOf(session).sent).toEqual([])
  expect(terminalOf(secondSession).sent).toEqual([])

  // no new admissions on the account
  const next = await lab.file('app3', 'one more Issue while the login is broken')
  await lab.cli(['capacity', 'refresh'])
  const admit = AdmitAnswer.parse((await lab.cli(['capacity', 'admit'])).json)
  expect(admit.admitted.map((a) => String(a.issue))).not.toContain(next)
  const account = (
    (await lab.cli(['capacity', 'get'])).json as { accounts: { account: string; authOk: boolean }[] }
  ).accounts.find((a) => a.account === 'me')
  expect(account?.authOk).toBe(false)

  // the steward does not nudge a session waiting for a login
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 0')

  // the owner logs in and marks the Errand done: the account answers again, its leads are resumed after a minute
  const done = await lab.cli(['errand', 'done', String(errands[0]?.id), '--note', 'logged in'])
  expect(done.code).toBe(0)
  const cleared = await tickAnswer()
  expect(cleared.cleared).toBe(1)
  expect(cleared.resumed).toBe(0)
  await age(61)
  const resumed = await tickAnswer()
  expect(resumed.resumed).toBe(2)
  expect(terminalOf(session).sent).toHaveLength(1)
  expect(terminalOf(secondSession).sent).toHaveLength(1)
})
