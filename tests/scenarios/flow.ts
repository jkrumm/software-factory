import { join } from 'node:path'
import { AdmitAnswer, LoopRunReply, type TickAnswer } from '@software-factory/contract'
import { readState, statePathOf, withState } from './fakes/hc-state.ts'
import { type Caller, factory, type ServerProcess, type World } from './harness.ts'
import { patient } from './patience.ts'

/**
 * How a scenario moves an Issue: only through the routes and the loops a client has. It files with `issue new`, a signal or
 * an alert, settles and admits with `planning settle` and `capacity admit`, starts a lead with `loop run leads` against the
 * fake `hc`, speaks as the lead with the agent token and the hook, and as the owner with the owner's verbs. Nothing records an
 * event by a back door; a scenario reads the database to assert, never to arrange.
 */
export interface Flow {
  world: World
  server: ServerProcess
}

export interface Run {
  code: number
  out: string
  err: string
  /** stdout as JSON, null when it is not */
  json: unknown
}

/** `factory <args>` against the flow's server as a caller (the owner by default). */
export async function run(flow: Flow, args: string[], as: Caller = 'owner'): Promise<Run> {
  const raw = await factory(flow.world, args, { FACTORY_URL: flow.server.url }, { as })
  let json: unknown = null
  try {
    json = raw.out.trim() ? JSON.parse(raw.out) : null
  } catch {
    // plain output
  }
  return { ...raw, json }
}

/**
 * Like `run`, but a failure throws with the command and what it printed. A `version_conflict` ("try again") is retried: a
 * loop of the server may move the Issue between a verb's read and its write, the refusal wrote nothing, and a client is
 * told to repeat the call. A scenario that asserts the refusal itself uses `run`.
 */
export async function must(flow: Flow, args: string[], as: Caller = 'owner'): Promise<Run> {
  let result = await run(flow, args, as)
  for (let retry = 0; retry < 5 && result.code !== 0 && result.err.includes('version_conflict'); retry++) {
    await Bun.sleep(100)
    result = await run(flow, args, as)
  }
  if (result.code !== 0) throw new Error(`factory ${args.join(' ')} exited ${result.code}: ${result.err}${result.out}`)
  return result
}

const issueOf = (json: unknown): string => {
  const issue = (json as { issue?: unknown } | null)?.issue
  if (typeof issue !== 'string') throw new Error(`no Issue in ${JSON.stringify(json)}`)
  return issue
}

let filings = 0

/** The owner files an Issue (`issue new`); it begins `settling`. */
export async function fileIssue(
  flow: Flow,
  input: { repo: string; title: string; text?: string; key?: string; after?: string[] },
): Promise<string> {
  const args = ['issue', 'new', '--repo', input.repo, '--title', input.title, '--key', input.key ?? `flow-${++filings}`]
  if (input.text) args.push('--text', input.text)
  for (const after of input.after ?? []) args.push('--after', after)
  return issueOf((await must(flow, args)).json)
}

/** A door alert files an incident in the repo its monitor is routed to; returns the Issue. */
export async function fileIncident(flow: Flow, input: { repo: string; title: string }): Promise<string> {
  const monitor = `flow-monitor-${++filings}`
  await must(flow, ['door', 'route-set', '--source', 'kuma', '--monitor', monitor, '--repo', input.repo])
  const alert = {
    source: 'kuma',
    monitor,
    event: `down-${filings}`,
    status: 'down',
    title: input.title,
    facts: {},
  }
  return issueOf((await must(flow, ['signal', 'alert', '--body', JSON.stringify(alert)], 'machine')).json)
}

/** `planning settle`: the Issue is queued, waiting for the Issues in `after` to close. */
export async function settle(flow: Flow, issue: string, after: string[] = []): Promise<void> {
  await must(flow, ['planning', 'settle', '--body', JSON.stringify({ issue, after })])
}

/** The picker is polled once a minute and an account takes one new lead per sample: every pass follows a poll. */
export async function admit(flow: Flow): Promise<AdmitAnswer> {
  await must(flow, ['capacity', 'refresh'])
  return AdmitAnswer.parse((await must(flow, ['capacity', 'admit'])).json)
}

/** How long a scenario waits for an Issue's turn: an event with a deadline, never a count of passes (a loaded host is slow, not wrong). */
const ADMISSION_WAIT_MS = 120_000

/** Settles an Issue and admits passes until it is its turn (an account takes one lead per poll); throws if it never is within the wait. */
export async function admitted(flow: Flow, issue: string, after: string[] = []): Promise<void> {
  await settle(flow, issue, after)
  const deadline = Date.now() + patient(ADMISSION_WAIT_MS)
  for (;;) {
    const passed = await admit(flow)
    // A server whose planning loop runs on its own may have admitted it between the passes.
    if (passed.admitted.some((a) => a.issue === issue) || (await stateOf(flow.world, issue)).state === 'working') return
    if (Date.now() >= deadline) break
  }
  throw new Error(`${issue} was not admitted in ${ADMISSION_WAIT_MS / 1000} s`)
}

/** One pass of a loop now (`loop run <name>`); a failed pass throws. */
export async function runLoop(flow: Flow, name: string): Promise<LoopRunReply> {
  const reply = LoopRunReply.parse((await must(flow, ['loop', 'run', name])).json)
  if (reply.error) throw new Error(`loop ${name} failed: ${reply.error}`)
  return reply
}

const TICK = /^spool (\d+) lines, (\d+) lead\(s\) lost, outbox (\{.*\}), api errors (\{.*\})$/

/** One pass of the leads' loop (spool, lost leads, the outbox: it starts the admitted leads), as the tick answered before. */
export async function tick(flow: Flow): Promise<TickAnswer> {
  const { summary } = await runLoop(flow, 'leads')
  const match = TICK.exec(summary ?? '')
  if (!match) throw new Error(`the leads loop said: ${summary}`)
  return {
    replayed: Number(match[1]),
    lost: Number(match[2]),
    outbox: JSON.parse(match[3] ?? '{}'),
    apiErrors: JSON.parse(match[4] ?? '{}'),
  }
}

/** Where an Issue stands, read-only. */
export async function stateOf(
  world: World,
  issue: string,
): Promise<{ state: string; wait: string | null; outcome: string | null; version: number }> {
  const [row] = await world.db.sql`SELECT state, wait_reason, outcome, version FROM factory.issues WHERE id = ${issue}`
  if (!row) throw new Error(`no Issue ${issue}`)
  return {
    state: row.state as string,
    wait: (row.wait_reason as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    version: row.version as number,
  }
}

/** The lead of an attempt blocks its Issue (`issue block`, the agent token). */
export const block = (flow: Flow, issue: string, reason: string, attempt = 1): Promise<Run> =>
  must(flow, ['issue', 'block', issue, '--attempt', String(attempt), '--reason', reason], 'agent')

/** The lead's terminal ends, as if its process died: the core keeps it finished. */
export async function killTerminal(world: World, address: string): Promise<void> {
  await withState(statePathOf(join(world.bin, 'calls.jsonl')), (state) => {
    const terminal = state.terminals[address]
    if (!terminal) throw new Error(`no terminal ${address}`)
    terminal.state = 'finished'
    terminal.status = null
    terminal.exit_code = 137
  })
}

/**
 * The lead of an attempt is lost: its live terminal ends and the leads' loop notices (`lead_gone`). Below the limit the
 * Issue is queued for a new attempt, which `admit` and the next `tick` start.
 */
export async function loseLead(flow: Flow, issue: string, attempt: number): Promise<TickAnswer> {
  const key = sessionOf(issue, attempt)
  const live = Object.values(readState(statePathOf(join(flow.world.bin, 'calls.jsonl'))).terminals).find(
    (terminal) => terminal.state === 'live' && terminal.labels['factory.key'] === key,
  )
  if (!live) throw new Error(`no live terminal ${key}`)
  await killTerminal(flow.world, live.address)
  return tick(flow)
}

const ROOT = join(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'apps', 'cli', 'bin', 'factory.ts')

/** `factory hook <event>` the way Claude Code runs it: JSON on stdin, the session in the environment, the world's socket and spool. */
export async function hook(
  world: World,
  event: string,
  session: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, 'hook', event], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      FACTORY_SESSION: session,
      FACTORY_SOCKET: join(world.bin, 'hook.sock'),
      FACTORY_SPOOL_DIR: join(world.bin, 'spool'),
      ...env,
    },
    stdin: new Blob([JSON.stringify(input)]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  return { code, out, err }
}

/** The lead's session name for an Issue's attempt, as the factory names it. */
export const sessionOf = (issue: string, attempt = 1): string => `lead-${issue.slice('issue_'.length)}-${attempt}`

/** The lead reports it hit the account's window (the `stop-failure` hook with a rate limit), which stalls the Issue as `wall`. */
export const hitWall = (world: World, issue: string, attempt = 1) =>
  hook(world, 'stop-failure', sessionOf(issue, attempt), { error: 'rate_limit' })
