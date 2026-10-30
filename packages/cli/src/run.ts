import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_ROLES_FILE,
  ErrorBody,
  Health,
  loadRoleTable,
  Prompt,
  type Quota,
  QueueState,
  QueueView,
  QuotaList,
  type RoleEntry,
  Session,
  SessionList,
  Spawn,
  SpawnList,
  Status,
  WaitOn,
} from '@software-factory/contract'
import type { z } from 'zod'
import { defaultHookSocket } from '@software-factory/contract/spool'
import pkg from '../package.json' with { type: 'json' }
import { EXIT, FactoryError, kindForStatus, usage } from './exit.ts'

export const BIN = 'factory'
export const DEFAULT_URL = 'http://127.0.0.1:7793'
const TIMEOUT_MS = 10_000

const HELP = `usage: ${BIN} [--format json|plain] <command>

commands:
  version         the CLI's version
  health          the server's /health
  spawn list      the spawn queue, newest first
  spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>]
                  queue a spawn (the parent defaults to $FACTORY_SESSION: the send-back rule counts a session's workers)
  spawn requeue <key>
                  put a failed spawn back in the queue with a fresh retry budget
  status          one screen: what needs a look, sessions by state (walled, blocked, stuck first), the queue with its
                  hold reasons, accounts with their readings, notes not yet delivered
  session list [--all]
                  the sessions, newest first, with their derived state (--all adds the dead)
  session get <id>
                  one session: state, turn, wait, pane, Claude session id, herdr's last word
  session wait --on workers|deploy|owner | --done [--session <id>]
                  declare what this session is waiting on, or that the wait is over (default: $FACTORY_SESSION)
  session note <session> <text> [--id <id>]
                  type <text> into the session once it is at its prompt (held while it works), confirmed by its next
                  turn; --id makes a repeated call one note (default: a fresh id per call). Use -- before text that
                  starts with a dash
  queue get [--project <path>]
                  the queue state (run, pace or drain) of the global scope or a project, the effective one, and every scope set
  queue set run|pace|drain [--project <path>]
                  set it: drain starts nothing new (queued spawns stay queued), pace allows one session per project and
                  spends only toward the weekly pace; the most restrictive scope that applies wins
  quota get       the newest reading of every account (percent of the 5-hour window and the week, resets, fresh or not)
  quota refresh   read the account picker now and store the readings
  role list       the role table: role, tier, effort (reads the tracked file, no server and no token)
  role get <role> one role: {"role", "tier", "effort"}
  hook <event>    the Claude Code hook entry (session-start, user-prompt-submit, stop, stop-failure, notification,
                  session-end); reads the hook JSON on stdin, spools it, tells the server, always exits 0

--all            list: include dead sessions
--on <what>      session wait: workers, deploy or owner
--done           session wait: the wait is over
--session <id>   session wait: the session (default $FACTORY_SESSION)
--id <id>        session note: the note's idempotency key
--repo, --prompt, --role, --parent  spawn create
--project <path> queue: the project (a repo inside the allowed roots); without it the global scope
--format json    one JSON line (default)
--format plain   tab-separated lines, or the bare value
FACTORY_URL      the server (default ${DEFAULT_URL})
FACTORY_TOKEN    the bearer token the server requires (not needed for version, health, session wait|note and role)
FACTORY_ROLES_FILE  the role table (default: config/roles.json of this checkout or release)
FACTORY_SOCKET   the server's unix socket for session wait and note (default ~/.local/share/factory/hook.sock)

Data goes to stdout, messages to stderr as one JSON line; the exit codes are agw's. ${BIN} never prompts.
`

export interface Io {
  env: Record<string, string | undefined>
  out(text: string): void
  err(text: string): void
}

type Format = 'json' | 'plain'

const notContract = (path: string, detail: string) =>
  new FactoryError('contract_mismatch', `${path} did not answer the shape this CLI expects: ${detail}`, {
    hint: 'the server and the CLI are from different releases',
  })

const cell = (value: unknown) => (value === null || value === undefined ? '-' : String(value))

interface CallOptions<S extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PUT'
  /** sent as JSON with a POST or PUT; `{}` when absent */
  body?: unknown
  auth: boolean
  /**
   * Through the server's unix socket instead of its port: how a session in a pane reaches it, with no token (the socket's
   * file mode is the credential). Only `POST /sessions/:id/wait` and `POST /events` are served there.
   */
  socket?: boolean
  /** the schema every answer in `accept` must satisfy */
  schema: S
  /** statuses that carry the schema's body besides 2xx */
  also?: number[]
}

/**
 * Calls the server and returns the body parsed by the contract's schema. Every failure is a `FactoryError` with agw's
 * kind: a body that does not parse is `contract_mismatch` (exit 9), whatever the status was.
 */
async function call<S extends z.ZodType>(
  io: Io,
  path: string,
  options: CallOptions<S>,
): Promise<{ status: number; body: z.output<S> }> {
  const socket = options.socket ? io.env.FACTORY_SOCKET || (io.env.HOME ? defaultHookSocket(io.env.HOME) : '') : ''
  if (options.socket && !socket) throw usage('no socket: set FACTORY_SOCKET or HOME')
  const base = options.socket ? 'http://localhost' : (io.env.FACTORY_URL || DEFAULT_URL).replace(/\/+$/, '')
  const token = options.socket ? undefined : io.env.FACTORY_TOKEN
  if (options.auth && !token) {
    throw new FactoryError('auth', 'no FACTORY_TOKEN set', {
      hint: 'run it under secrets-run with the repo .env.tpl, or export FACTORY_TOKEN',
    })
  }
  let response: Response
  let text: string
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.method && options.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      },
      body: options.method && options.method !== 'GET' ? JSON.stringify(options.body ?? {}) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(options.socket ? { unix: socket } : {}),
    })
    text = await response.text()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new FactoryError('network', `server unreachable at ${base}: ${reason}`, {
      hint: `is the server up? make verify checks the deployment; ${BIN} version works offline`,
    })
  }
  let json: unknown
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: the schema below, or the error message, deals with it.
  }

  const parsed = options.schema.safeParse(json)
  // A status the schema is expected to cover still falls back to the plain error when the body is not the schema's: a
  // 503 from anything but this server is an outage, not a drifted contract.
  if (!response.ok && !(options.also?.includes(response.status) && parsed.success)) {
    const message = ErrorBody.safeParse(json)
    throw new FactoryError(
      kindForStatus(response.status),
      message.success ? message.data.error : `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      { details: { status: response.status } },
    )
  }
  if (!parsed.success) throw notContract(path, parsed.error.issues[0]?.message ?? 'unparseable body')
  return { status: response.status, body: parsed.data }
}

const spawnLine = (s: Spawn) =>
  [s.key, s.status, s.account, s.resumeAt, s.attempts, s.session, s.role, s.hold].map(cell).join('\t')

const queueLine = (q: QueueView) => [q.scope.project ?? 'global', q.state, q.effective, q.setAt].map(cell).join('\t')

const quotaLine = (q: Quota) =>
  [
    q.account,
    q.fiveHourUsed,
    q.weeklyUsed,
    q.fiveHourResetsAt,
    q.weeklyResetsAt,
    q.fresh ? 'fresh' : 'stale',
    q.authOk ? 'auth ok' : 'auth failed',
  ]
    .map(cell)
    .join('\t')

const promptLine = (p: Prompt) =>
  [p.id, p.session, p.status, p.sentCount, p.sentAt, p.deliveredAt, p.error].map(cell).join('\t')

/** The status screen: attention first, then each section a header and tab-separated rows. */
export function statusScreen(s: Status): string {
  const section = (title: string, rows: string[]) => [title, ...(rows.length ? rows.map((r) => `  ${r}`) : ['  -'])]
  return [
    ...section('ATTENTION', s.attention),
    ...section(
      'SESSIONS',
      s.sessions.map((x) =>
        [
          x.state,
          x.since ?? '-',
          x.id,
          x.role ?? '-',
          x.account ?? '-',
          `turn ${x.turn}`,
          x.wait ? `wait ${x.wait}` : '',
        ]
          .filter(Boolean)
          .join('\t'),
      ),
    ),
    ...section(
      `QUEUE (${s.queue.effective})`,
      s.queue.spawns.map((x) =>
        [
          x.key,
          x.status,
          x.hold ? `hold ${x.hold}` : '',
          x.account ?? '-',
          x.resumeAt ? `at ${x.resumeAt}` : '',
          x.error ?? '',
        ]
          .filter(Boolean)
          .join('\t'),
      ),
    ),
    ...section('ACCOUNTS', s.accounts.map(quotaLine)),
    ...section('NOTES', [
      ...s.notes.map(promptLine),
      ...(s.notesMore > 0 ? [`... ${s.notesMore} more not shown`] : []),
    ]),
  ].join('\n')
}

const roleLine = (r: RoleEntry) => [r.role, r.tier, r.effort].join('\t')

const sessionLine = (s: Session) =>
  [s.id, s.state, s.wait, s.turn, s.pane, s.claudeSessionId, s.lastEventAt].map(cell).join('\t')

interface Flags {
  all?: boolean
  on?: string
  done?: boolean
  session?: string
  project?: string
  id?: string
  repo?: string
  prompt?: string
  role?: string
  parent?: string
}

async function execute(words: string[], format: Format, flags: Flags, io: Io): Promise<void> {
  const print = (json: unknown, plain: string) => io.out(`${format === 'json' ? JSON.stringify(json) : plain}\n`)
  const key = words.join(' ')

  if (key === 'version') return print({ version: pkg.version }, pkg.version)

  if (key === 'health') {
    const { body } = await call(io, '/health', { auth: false, schema: Health, also: [503] })
    print(body, `${body.status}\t${body.version}`)
    if (body.status !== 'ok') {
      throw new FactoryError('general', `server is not ok: ${body.status}${body.reason ? ` (${body.reason})` : ''}`)
    }
    return
  }

  if (key === 'spawn list') {
    const { body } = await call(io, '/spawns', { auth: true, schema: SpawnList })
    const lines = body.spawns.map(spawnLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'spawn' && words[1] === 'create') {
    const name = words[2]
    if (!name || words.length > 3 || !flags.repo || !flags.prompt) {
      throw usage('usage: spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>]')
    }
    const parent = flags.parent ?? io.env.FACTORY_SESSION
    const { body } = await call(io, '/spawns', {
      method: 'POST',
      auth: true,
      schema: Spawn,
      body: {
        key: name,
        repo: resolve(flags.repo),
        prompt: flags.prompt,
        ...(flags.role ? { role: flags.role } : {}),
        ...(parent ? { parent } : {}),
      },
    })
    return print(body, spawnLine(body))
  }

  if (key === 'status') {
    const { body } = await call(io, '/status', { auth: true, schema: Status })
    return print(body, statusScreen(body))
  }

  if (words[0] === 'session' && words[1] === 'note') {
    const target = words[2]
    const text = words.slice(3).join(' ')
    if (!target || !text) throw usage('usage: session note <session> <text> [--id <id>]')
    const { body } = await call(io, `/sessions/${encodeURIComponent(target)}/note`, {
      method: 'POST',
      auth: false,
      socket: true,
      schema: Prompt,
      body: { id: flags.id ?? `note:${crypto.randomUUID()}`, text },
    })
    return print(body, promptLine(body))
  }

  if (words[0] === 'spawn' && words[1] === 'requeue') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: spawn requeue <key>')
    const { body } = await call(io, `/spawns/${encodeURIComponent(target)}/requeue`, {
      method: 'POST',
      auth: true,
      schema: Spawn,
    })
    return print(body, spawnLine(body))
  }

  if (key === 'session list') {
    const { body } = await call(io, `/sessions${flags.all ? '?all=1' : ''}`, { auth: true, schema: SessionList })
    const lines = body.sessions.map(sessionLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'session' && words[1] === 'get') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: session get <id>')
    const { body } = await call(io, `/sessions/${encodeURIComponent(target)}`, { auth: true, schema: Session })
    return print(body, sessionLine(body))
  }

  if (key === 'session wait') {
    const target = flags.session ?? io.env.FACTORY_SESSION
    if (!target) throw usage('no session: set FACTORY_SESSION or pass --session <id>')
    if (Boolean(flags.done) === (flags.on !== undefined))
      throw usage('usage: session wait --on workers|deploy|owner | --done')
    const on = flags.on === undefined ? undefined : WaitOn.safeParse(flags.on)
    if (on && !on.success) throw usage(`--on must be workers, deploy or owner, got: ${flags.on}`)
    const { body } = await call(io, `/sessions/${encodeURIComponent(target)}/wait`, {
      method: 'POST',
      auth: false,
      socket: true,
      schema: Session,
      body: on?.success ? { on: on.data } : { done: true },
    })
    return print(body, sessionLine(body))
  }

  if (key === 'queue get') {
    const query = flags.project === undefined ? '' : `?project=${encodeURIComponent(resolve(flags.project))}`
    const { body } = await call(io, `/queue${query}`, { auth: true, schema: QueueView })
    return print(body, queueLine(body))
  }

  if (words[0] === 'queue' && words[1] === 'set') {
    const state = QueueState.safeParse(words[2])
    if (!state.success || words.length > 3) throw usage('usage: queue set run|pace|drain [--project <path>]')
    const { body } = await call(io, '/queue', {
      method: 'PUT',
      auth: true,
      schema: QueueView,
      body: { state: state.data, ...(flags.project === undefined ? {} : { project: resolve(flags.project) }) },
    })
    return print(body, queueLine(body))
  }

  if (key === 'quota get' || key === 'quota refresh') {
    const refresh = key === 'quota refresh'
    const { body } = await call(io, refresh ? '/quota/refresh' : '/quota', {
      method: refresh ? 'POST' : 'GET',
      auth: true,
      schema: QuotaList,
    })
    const lines = body.quota.map(quotaLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'role') {
    const table = await loadRoleTable(io.env.FACTORY_ROLES_FILE || DEFAULT_ROLES_FILE).catch((error) => {
      throw new FactoryError('general', error instanceof Error ? error.message : String(error))
    })
    if (key === 'role list') {
      const roles = [...table.values()]
      return print({ roles }, roles.map(roleLine).join('\n'))
    }
    if (words[1] === 'get' && words.length === 3) {
      const entry = table.get(words[2] ?? '')
      if (!entry) {
        throw new FactoryError('not_found', `unknown role ${words[2]}`, {
          hint: `one of ${[...table.keys()].join(', ')}`,
        })
      }
      return print(entry, roleLine(entry))
    }
    throw usage('usage: role list | role get <role>')
  }

  throw usage(words.length ? `unknown command: ${key}` : 'no command', `${BIN} --help lists the commands`)
}

/** Runs one invocation and returns its exit code. Nothing here reads stdin or asks anything. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
    } catch (error) {
      throw usage(error instanceof Error ? error.message : String(error), `${BIN} --help lists the flags`)
    }
    if (parsed.values.help) {
      io.out(HELP)
      return EXIT.ok
    }
    const format = parsed.values.format ?? 'json'
    if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
    if (!parsed.positionals.length) {
      io.out(HELP)
      return EXIT.ok
    }
    await execute(parsed.positionals, format, parsed.values, io)
    return EXIT.ok
  } catch (error) {
    if (error instanceof FactoryError) {
      io.err(`${error.toErrorLine()}\n`)
      return error.exitCode
    }
    io.err(`${new FactoryError('general', error instanceof Error ? error.message : String(error)).toErrorLine()}\n`)
    return EXIT.general
  }
}

const OPTIONS = {
  format: { type: 'string' },
  all: { type: 'boolean' },
  on: { type: 'string' },
  done: { type: 'boolean' },
  session: { type: 'string' },
  project: { type: 'string' },
  id: { type: 'string' },
  repo: { type: 'string' },
  prompt: { type: 'string' },
  role: { type: 'string' },
  parent: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const
