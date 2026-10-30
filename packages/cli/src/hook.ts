// `factory hook <event>`: runs inside every Claude Code hook of a factory session. It must be quick and it must never
// fail the session, so it imports nothing but node:fs and the zod-free half of the contract, and every path ends in
// exit 0. Order matters: the spool first (the fact survives anything), the server second (best effort, 300 ms).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
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

export const HOOK_EVENTS = [
  'session-start',
  'user-prompt-submit',
  'stop',
  'stop-failure',
  'notification',
  'session-end',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

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

/** Appends one line with a single O_APPEND write, so concurrent hooks of one session never interleave. */
function append(dir: string, file: string, line: SpoolLine): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
}

/** Never throws a failure into the session: the caller turns every outcome into exit 0. */
export async function runHook(event: string, io: HookIo): Promise<void> {
  const session = io.env.FACTORY_SESSION
  if (!session) return

  let input: Input = {}
  try {
    const parsed: unknown = JSON.parse(await io.stdin())
    if (parsed && typeof parsed === 'object') input = parsed as Input
  } catch {
    // an empty or broken payload still says that the event happened
  }
  const mapped = toEvent(event, input)
  if (!mapped) return

  const home = io.env.HOME
  const dir = io.env.FACTORY_SPOOL_DIR || (home ? defaultSpoolDir(home) : '')
  // No place to spool is no place to lose an event to a stray relative path.
  if (!dir) return
  const file = join(dir, spoolFileName(session))
  const summary = readSummary(file)
  const line: SpoolLine = {
    key: nextKey(summary, session, mapped.kind),
    session,
    kind: mapped.kind,
    at: nextAt(summary, io.now()),
    ...(mapped.payload ? { payload: mapped.payload } : {}),
  }
  append(dir, file, line)

  const socket = io.env.FACTORY_SOCKET || (home ? defaultHookSocket(home) : '')
  if (!socket) return
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
}

/** The `factory hook` entry point: the exit code is always 0. */
export async function hookMain(
  argv: string[],
  env: Record<string, string | undefined>,
  stdin: () => Promise<string> = () => (process.stdin.isTTY ? Promise.resolve('') : Bun.stdin.text()),
): Promise<number> {
  if (!env.FACTORY_SESSION) return 0
  try {
    await runHook(argv[0] ?? '', { env, stdin, now: Date.now })
  } catch {
    // a hook that cannot record anything still lets the session go on
  }
  return 0
}
