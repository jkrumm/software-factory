// `factory hook <event>`: runs inside every Claude Code hook of a factory session. It must be quick and it must never
// fail the session, so it imports nothing but node:fs and the zod-free half of the contract, and every path ends in
// exit 0. Order matters: the spool first (the fact survives anything), the server second (best effort, 300 ms).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCOUNT_NAME,
  defaultHookSocket,
  defaultSpoolDir,
  type EventKind,
  nextAt,
  nextKey,
  parseSpool,
  parseSummary,
  type SpoolLine,
  spoolFileName,
  summarize,
} from '@software-factory/contract/spool'
import { tryLock } from '@software-factory/contract/spool-lock'

export const HOOK_EVENTS = [
  'session-start',
  'user-prompt-submit',
  'stop',
  'stop-failure',
  'notification',
  'session-end',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** How long a hook waits for another hook of its session before it writes a key that cannot collide. */
export const LOCK_BUDGET_MS = 200

/** The post to the server may take this long and no longer. */
export const POST_TIMEOUT_MS = 300

type Input = Record<string, unknown>

const text = (value: unknown, max = 500): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined

/** Only what the server derives from: no prompt text, no assistant message, nothing large. */
function pick(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const defined = Object.entries(entries).filter(([, v]) => v !== undefined)
  return defined.length ? Object.fromEntries(defined) : undefined
}

/** The §3 event a hook payload stands for, or nothing when the factory has no use for it. */
export function toEvent(
  event: string,
  input: Input,
  env: Record<string, string | undefined> = {},
): { kind: EventKind; payload?: Record<string, unknown> } | undefined {
  switch (event) {
    case 'session-start':
      return {
        kind: 'session_started',
        payload: pick({
          source: text(input.source, 32),
          claudeSessionId: text(input.session_id, 128),
          transcriptPath: text(input.transcript_path, 1024),
          cwd: text(input.cwd, 1024),
          model: text(input.model, 128),
          // The account the picker chose: how the factory knows it for a session no spawn row describes (`rd`'s).
          account: ACCOUNT_NAME.test(env.CLAUDE_ACCOUNT_PICKED ?? '') ? env.CLAUDE_ACCOUNT_PICKED : undefined,
        }),
      }
    case 'user-prompt-submit':
      return { kind: 'turn_started', payload: pick({ claudeSessionId: text(input.session_id, 128) }) }
    case 'stop':
      return { kind: 'turn_ended', payload: pick({ stopHookActive: input.stop_hook_active === true || undefined }) }
    case 'stop-failure':
      // Only a rate limit is a wall; the other errors (overloaded, server_error, ...) end a turn the session recovers from.
      return input.error === 'rate_limit'
        ? { kind: 'limit_stop', payload: pick({ error: 'rate_limit', details: text(input.error_details) }) }
        : undefined
    case 'notification':
      return fromNotification(input)
    case 'session-end':
      return { kind: 'session_ended', payload: pick({ reason: text(input.reason, 64) }) }
    default:
      return undefined
  }
}

function fromNotification(input: Input): { kind: EventKind; payload?: Record<string, unknown> } | undefined {
  const type = input.notification_type
  if (type === 'permission_prompt') return { kind: 'prompt_blocked', payload: pick({ message: text(input.message) }) }
  if (type === 'idle_prompt') return { kind: 'prompt_idle' }
  const resume = typeof type === 'string' ? /^quota_auto_resume_(fired|stale|disabled)$/.exec(type) : null
  return resume ? { kind: 'quota_resume', payload: { state: resume[1] } } : undefined
}

export interface HookIo {
  env: Record<string, string | undefined>
  /** the hook's JSON, as Claude Code piped it */
  stdin(): Promise<string>
  now(): number
}

/** The spool's lines so far and the sums a rotation left behind, read in that order (see `rotateIfDue`). */
function readSummary(file: string) {
  let lines: SpoolLine[] = []
  try {
    lines = parseSpool(readFileSync(file, 'utf8'))
  } catch {
    // no spool yet
  }
  let base = ''
  try {
    base = readFileSync(`${file}.base`, 'utf8')
  } catch {
    // never rotated
  }
  return summarize(parseSummary(base), lines)
}

/** Appends one line with a single O_APPEND write. */
function append(file: string, line: SpoolLine): void {
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
}

/** The server's answer to a stop is asked within this long, like any post. */
export const STOP_CHECK_TIMEOUT_MS = 300

/**
 * Whether the server wants this stop turned back (FL5): the line to print, or nothing. Any failure, a slow answer or a
 * body that is not the expected one is nothing: a session is never held by a server that cannot say why.
 */
async function askStopCheck(socket: string, session: string): Promise<string | undefined> {
  try {
    const response = await fetch(`http://localhost/sessions/${encodeURIComponent(session)}/stop-check`, {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopHookActive: false }),
      signal: AbortSignal.timeout(STOP_CHECK_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const answer = (await response.json()) as { sendBack?: unknown; message?: unknown }
    return answer.sendBack === true && typeof answer.message === 'string' && answer.message ? answer.message : undefined
  } catch {
    return undefined
  }
}

/**
 * Never throws a failure into the session. The result is the one line the hook prints on stderr when a `Stop` is sent
 * back (exit 2), else nothing: every other outcome is a silent exit 0.
 */
export async function runHook(event: string, io: HookIo): Promise<string | undefined> {
  const session = io.env.FACTORY_SESSION
  if (!session) return undefined

  let input: Input = {}
  try {
    const parsed: unknown = JSON.parse(await io.stdin())
    if (parsed && typeof parsed === 'object') input = parsed as Input
  } catch {
    // an empty or broken payload still says that the event happened
  }
  const mapped = toEvent(event, input, io.env)
  if (!mapped) return undefined

  const home = io.env.HOME
  const socket = io.env.FACTORY_SOCKET || (home ? defaultHookSocket(home) : '')
  // A stop is asked about before it is recorded: a stop that is sent back is not an end, the turn goes on, and an
  // event that said it ended would show the session idle while it works. `stop_hook_active` is the loop guard: that
  // stop is let through, and recorded. A server that cannot answer lets the stop through too.
  if (event === 'stop' && input.stop_hook_active !== true && socket) {
    const sendBack = await askStopCheck(socket, session)
    if (sendBack) return sendBack
  }

  const dir = io.env.FACTORY_SPOOL_DIR || (home ? defaultSpoolDir(home) : '')
  // No place to spool is no place to lose an event to a stray relative path.
  if (!dir) return undefined
  const file = join(dir, spoolFileName(session))
  // Counting the spool and appending are one step: two overlapping hooks of a session must not write the same key.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const release = await tryLock(file, LOCK_BUDGET_MS)
  let line: SpoolLine
  try {
    const summary = readSummary(file)
    // Without the lock the count may be stale: a random suffix keeps the key unique, and the line is still counted later.
    const key = nextKey(summary, session, mapped.kind) + (release ? '' : `:${Math.random().toString(36).slice(2, 8)}`)
    line = {
      key,
      session,
      kind: mapped.kind,
      at: nextAt(summary, io.now()),
      ...(mapped.payload ? { payload: mapped.payload } : {}),
    }
    append(file, line)
  } finally {
    release?.()
  }

  if (!socket) return undefined
  try {
    const response = await fetch('http://localhost/events', {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(line),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
    await response.body?.cancel()
  } catch {
    // the server is down or slow: the spool has the event and the server reads it on its next pass
  }
  return undefined
}

/**
 * The `factory hook` entry point: exit 0 for every event and every failure, except a `Stop` the server sends back: exit 2
 * with its one line on stderr (Claude Code feeds that line to the session and lets it go on).
 */
export async function hookMain(
  argv: string[],
  env: Record<string, string | undefined>,
  stdin: () => Promise<string> = () => (process.stdin.isTTY ? Promise.resolve('') : Bun.stdin.text()),
  err: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<number> {
  if (!env.FACTORY_SESSION) return 0
  try {
    const sendBack = await runHook(argv[0] ?? '', { env, stdin, now: Date.now })
    if (sendBack) {
      err(`${sendBack}\n`)
      return 2
    }
  } catch {
    // a hook that cannot record anything still lets the session go on
  }
  return 0
}
