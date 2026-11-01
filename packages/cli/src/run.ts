import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_ROLES_FILE,
  DoorRoute,
  DoorRouteList,
  type DoorUnrouted,
  DoorUnroutedList,
  Health,
  Issue,
  IssueList,
  type IssueSummary,
  loadRoleTable,
  Project,
  ProjectList,
  ProjectSyncResult,
  Prompt,
  type Quota,
  Placement,
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
import pkg from '../package.json' with { type: 'json' }
import { BIN, call, DEFAULT_URL, type Io } from './client.ts'
import { EXIT, FactoryError, usage } from './exit.ts'

const HELP = `usage: ${BIN} [--format json|plain] <command>

commands:
  version         the CLI's version
  health          the server's /health
  spawn list      the spawn queue, newest first
  spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>] [--space <path>] [--new-space]
                  [--placement tab|child]
                  queue a spawn (idempotent by key; the parent defaults to $FACTORY_SESSION: the send-back rule counts a
                  session's workers). The tab goes into the space of --space (default: the repo; a fan worker's
                  worktree names its main checkout); --new-space asks for a space of its own; --placement child makes it a hidden
                  child of the parent's terminal (a tab if there is none), tab a tab (default: worker roles child, others
                  tab). Uses the token when
                  FACTORY_TOKEN is set and the socket otherwise
  spawn get <key> one spawn: status, hold, account, pane, tab, workspace (token or socket, as spawn create)
  spawn requeue <key>
                  put a failed spawn back in the queue with a fresh retry budget
  status          one screen: what needs a look, sessions by state (walled, blocked, stuck first), the queue with its
                  hold reasons, accounts with their readings, notes not yet delivered
  session list [--all]
                  the sessions, newest first, with their derived state (--all adds the dead)
  session get <id>
                  one session: state, turn, wait, pane, tab, Claude session id, the runner's last word (token or socket)
  session wait --on workers|deploy|owner | --done [--session <id>]
                  declare what this session is waiting on, or that the wait is over (default: $FACTORY_SESSION)
  session note <session> <text> [--id <id>]
                  type <text> into the session once it is at its prompt (held while it works), confirmed by its next
                  turn; --id makes a repeated call one note (default: a fresh id per call). Use -- before text that
                  starts with a dash
  issue new --repo <path> --title <text> [--facts @file|-] [--key <key>] [--source request|alert]
                  file an Issue. --facts is JSON up to 32 KiB, from a file or stdin, kept as data. --key makes a replay one
                  Issue, whatever became of it (default: a fresh key per call). A repo must be inside the allowed roots
                  (token or socket, as spawn create)
  issue list      the Issues, newest first (token or socket)
  issue show <id> one Issue with its facts (token or socket)
  project list    the projects: manifest or defaults, leads, who holds the claim and who waits, broken manifests (token or socket)
  project show <name>
                  one project: the manifest in force, the make contract (which of check, test, deploy, verify, restart, quality, logs,
                  status its Makefile has), the claim, a manifest that does not parse (token or socket)
  project sync    read every project's project.yaml and Makefile now (token)
  door route set <source> <monitor> <repo>
                  send the alerts of a monitor (Kuma: its name; HyperDX: the alert's title without trailing numbers) to a
                  repo: they become Issues there. The repo must be inside the allowed roots and never IuRoot. Token only.
                  Use -- before a monitor that starts with a dash
  door route rm <source> <monitor>
                  remove a route: its alerts count as unrouted again
  door route list the routes, with how many quiet alerts (an up with no open Issue) each counted
  door unrouted   the monitors that raised alerts with no route: source, monitor, count, last seen, last title
  door token new <source> [--rotate]
                  write a fresh token (32 random bytes, base64url) for the source into the door's tokens file
                  (FACTORY_DOOR_TOKENS_FILE, default ~/.config/factory/door-tokens.json, mode 0600) and print it once.
                  Offline, no server. An existing source needs --rotate; the door reads the file at start, so restart it
  queue get [--project <path>]
                  the queue state (run, pace or drain) of the global scope or a project, the effective one, and every scope set
                  (token or socket)
  queue set run|pace|drain [--project <path>]
                  set it: drain starts nothing new (queued spawns stay queued), pace allows one session per project and
                  spends only toward the weekly pace; the most restrictive scope that applies wins
  slot run [--name <label>] -- <cmd> [args…]
                  run <cmd> in one of the host's test slots (FACTORY_SLOTS on the server, default 2): waits for a free one,
                  renews the lease while the command runs, gives it back when it ends. The exit code, stdout and stderr are
                  the command's own. Fails open: no server, or no slot within FACTORY_SLOT_WAIT_MS (default 600000), runs the
                  command anyway with one line on stderr. Goes by the socket, needs no token
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
--repo, --prompt, --role, --parent, --space, --new-space, --placement  spawn create
--title, --facts, --key, --source  issue new
--rotate         door token new: replace the source's token
--name <label>   slot run: what the slot is for (default: the command)
--project <path> queue: the project (a repo inside the allowed roots); without it the global scope
--format json    one JSON line (default)
--format plain   tab-separated lines, or the bare value
FACTORY_URL      the server (default ${DEFAULT_URL})
FACTORY_TOKEN    the bearer token the server requires (not needed for version, health, session wait|note, slot run and role;
                 spawn create|get, session get, queue get and issue new|list|show fall back to the socket without it)
FACTORY_ROLES_FILE  the role table (default: config/roles.json of this checkout or release)
FACTORY_SOCKET   the server's unix socket for what a pane may do without a token (default ~/.local/share/factory/hook.sock)
FACTORY_DOOR_TOKENS_FILE  door token new: the door's tokens file
FACTORY_SLOT_WAIT_MS  slot run: longest wait for a slot before running without one (default 600000)

Data goes to stdout, messages to stderr as one JSON line; the exit codes are agw's. ${BIN} never prompts.
`

type Format = 'json' | 'plain'

const cell = (value: unknown) => (value === null || value === undefined ? '-' : String(value))

const spawnLine = (s: Spawn) =>
  [s.key, s.status, s.account, s.resumeAt, s.attempts, s.session, s.role, s.hold].map(cell).join('\t')

const projectLine = (p: Project) =>
  [
    p.name,
    p.source,
    p.manifest.deploy.mode,
    `leads ${p.manifest.leads}`,
    `held ${p.claim.holders.join(',') || '-'}`,
    `queued ${p.claim.queued.join(',') || '-'}`,
    p.manifestError ? `broken ${p.manifestError.issue === null ? '' : `#${p.manifestError.issue}`}` : '',
  ]
    .filter(Boolean)
    .join('\t')

/** One project in full: the plain form is a few lines, the json form the whole object. */
const projectScreen = (p: Project): string =>
  [
    projectLine(p),
    `repo\t${p.repo}`,
    `ship\t${p.manifest.ship.map((r) => `${r.paths.join(',')} via ${r.via}`).join('; ')}`,
    `hold\t${p.manifest.deploy.hold}`,
    `make\t${
      p.makeTargets === null
        ? 'not read'
        : p.makeTargets.makefile
          ? Object.entries(p.makeTargets)
              .filter(([name]) => name !== 'makefile')
              .map(([name, has]) => `${name} ${has ? 'yes' : 'no'}`)
              .join(', ')
          : 'no Makefile'
    }`,
    ...(p.manifestError ? [`error\t${p.manifestError.message}`] : []),
  ].join('\n')

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

const issueLine = (i: IssueSummary) =>
  [i.id, i.state, i.reason ?? i.outcome, i.source, i.repo, i.title].map(cell).join('\t')

const routeLine = (r: DoorRoute) => [r.source, r.monitor, r.repo, r.quiet, r.lastQuietAt].map(cell).join('\t')

const unroutedLine = (u: DoorUnrouted) => [u.source, u.monitor, u.count, u.lastSeen, u.lastTitle].map(cell).join('\t')

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
  space?: string
  'new-space'?: boolean
  placement?: string
  name?: string
  title?: string
  facts?: string
  key?: string
  source?: string
  rotate?: boolean
}

/** `--facts @file` or `--facts -`: the text must be JSON, and the server keeps the size limit. */
async function readFacts(from: string, io: Io): Promise<unknown> {
  if (from !== '-' && !from.startsWith('@')) throw usage('--facts takes @file or - (stdin)')
  const text = await (from === '-'
    ? (io.stdin?.() ?? Promise.resolve(''))
    : Bun.file(from.slice(1))
        .text()
        .catch(() => {
          throw usage(`cannot read ${from.slice(1)}`)
        }))
  try {
    return JSON.parse(text)
  } catch {
    throw usage('--facts is not valid JSON')
  }
}

/** `door route set|rm|list`, `door unrouted` and `door token new`. */
async function door(words: string[], format: Format, flags: Flags, io: Io): Promise<void> {
  const print = (json: unknown, plain: string) => io.out(`${format === 'json' ? JSON.stringify(json) : plain}\n`)
  const key = words.slice(0, 3).join(' ')

  if (key === 'door route set') {
    const [, , , source, monitor, repo] = words
    if (!source || !monitor || !repo || words.length > 6) throw usage('usage: door route set <source> <monitor> <repo>')
    const { body } = await call(io, '/door/routes', {
      method: 'PUT',
      auth: true,
      schema: DoorRoute,
      body: { source, monitor, repo: resolve(repo) },
    })
    return print(body, routeLine(body))
  }

  if (key === 'door route rm') {
    const [, , , source, monitor] = words
    if (!source || !monitor || words.length > 5) throw usage('usage: door route rm <source> <monitor>')
    const { body } = await call(io, '/door/routes', {
      method: 'DELETE',
      auth: true,
      schema: DoorRoute,
      body: { source, monitor },
    })
    return print(body, routeLine(body))
  }

  if (words.join(' ') === 'door route list') {
    const { body } = await call(io, '/door/routes', { auth: true, schema: DoorRouteList })
    const lines = body.routes.map(routeLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words.join(' ') === 'door unrouted') {
    const { body } = await call(io, '/door/unrouted', { auth: true, schema: DoorUnroutedList })
    const lines = body.unrouted.map(unroutedLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (key === 'door token new') {
    const source = words[3]
    if (!source || words.length > 4) throw usage('usage: door token new <source> [--rotate]')
    const { newToken, TokenExists, tokensFileFrom, TokensError } = await import('@software-factory/door/tokens')
    try {
      const token = newToken(tokensFileFrom(io.env), source, { rotate: flags.rotate })
      return print({ source, token }, token)
    } catch (error) {
      if (error instanceof TokenExists) throw new FactoryError('conflict', error.message)
      if (error instanceof TokensError) throw new FactoryError('general', error.message)
      throw error
    }
  }

  throw usage(
    'usage: door route set <source> <monitor> <repo> | door route rm <source> <monitor> | door route list | door unrouted | door token new <source>',
  )
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
      throw usage(
        'usage: spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>] [--space <path>] [--new-space] [--placement tab|child]',
      )
    }
    const placement = flags.placement === undefined ? undefined : Placement.safeParse(flags.placement).data
    if (flags.placement !== undefined && !placement) throw usage('--placement is tab or child')
    const parent = flags.parent ?? io.env.FACTORY_SESSION
    // With a token it is the HTTP route; a pane has none, and goes by the socket (the same body, the same checks).
    const { body } = await call(io, '/spawns', {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: Spawn,
      body: {
        key: name,
        repo: resolve(flags.repo),
        prompt: flags.prompt,
        ...(flags.role ? { role: flags.role } : {}),
        ...(parent ? { parent } : {}),
        ...(flags.space ? { space: resolve(flags.space) } : {}),
        ...(flags['new-space'] ? { new_space: true } : {}),
        ...(placement ? { placement } : {}),
      },
    })
    return print(body, spawnLine(body))
  }

  if (words[0] === 'spawn' && words[1] === 'get') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: spawn get <key>')
    const { body } = await call(io, `/spawns/${encodeURIComponent(target)}`, {
      auth: true,
      socket: 'fallback',
      schema: Spawn,
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
    const { body } = await call(io, `/sessions/${encodeURIComponent(target)}`, {
      auth: true,
      socket: 'fallback',
      schema: Session,
    })
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

  if (key === 'issue new') {
    if (!flags.repo || !flags.title) {
      throw usage('usage: issue new --repo <path> --title <text> [--facts @file|-] [--key <key>] [--source <source>]')
    }
    const facts = flags.facts === undefined ? undefined : await readFacts(flags.facts, io)
    const { body } = await call(io, '/issues', {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: Issue,
      body: {
        repo: resolve(flags.repo),
        title: flags.title,
        source_key: flags.key ?? crypto.randomUUID(),
        ...(flags.source ? { source: flags.source } : {}),
        ...(facts === undefined ? {} : { facts }),
      },
    })
    return print(body, issueLine(body))
  }

  if (key === 'issue list') {
    const { body } = await call(io, '/issues', { auth: true, socket: 'fallback', schema: IssueList })
    const lines = body.issues.map(issueLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'issue' && words[1] === 'show') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: issue show <id>')
    const { body } = await call(io, `/issues/${encodeURIComponent(target)}`, {
      auth: true,
      socket: 'fallback',
      schema: Issue,
    })
    return print(body, issueLine(body))
  }

  if (key === 'project list') {
    const { body } = await call(io, '/projects', { auth: true, socket: 'fallback', schema: ProjectList })
    const lines = body.projects.map(projectLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'project' && words[1] === 'show') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: project show <name>')
    const { body } = await call(io, `/projects/${encodeURIComponent(target)}`, {
      auth: true,
      socket: 'fallback',
      schema: Project,
    })
    return print(body, projectScreen(body))
  }

  if (key === 'project sync') {
    const { body } = await call(io, '/projects/sync', { method: 'POST', auth: true, schema: ProjectSyncResult })
    const lines = [
      `synced ${body.synced}`,
      ...body.broken.map((b) => `broken ${b.project}${b.issue === null ? '' : ` #${b.issue}`}`),
      ...body.errors.map((e) => `error ${e}`),
    ]
    return print(body, lines.join('\n'))
  }
  if (words[0] === 'door') return door(words, format, flags, io)

  if (key === 'queue get') {
    const query = flags.project === undefined ? '' : `?project=${encodeURIComponent(resolve(flags.project))}`
    const { body } = await call(io, `/queue${query}`, { auth: true, socket: 'fallback', schema: QueueView })
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

/** Runs one invocation and returns its exit code. Nothing asks anything; stdin is read only for `--facts -`. */
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
    // The command's own exit code is this process's: it does not go through `execute`, which only prints.
    if (parsed.positionals[0] === 'slot') {
      if (parsed.positionals[1] !== 'run') throw usage('usage: slot run [--name <label>] -- <cmd> [args…]')
      const { slotRun } = await import('./slot.ts')
      return await slotRun({ name: parsed.values.name, command: parsed.positionals.slice(2) }, io)
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
  space: { type: 'string' },
  'new-space': { type: 'boolean' },
  placement: { type: 'string' },
  name: { type: 'string' },
  title: { type: 'string' },
  facts: { type: 'string' },
  key: { type: 'string' },
  source: { type: 'string' },
  rotate: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const
