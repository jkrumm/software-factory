import { parseArgs } from 'node:util'
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

--format json    one JSON line (default)
--format plain   tab-separated lines, or the bare value
FACTORY_URL      the server (default ${DEFAULT_URL})
FACTORY_TOKEN    the bearer token the server requires (not needed for version and health)

Data goes to stdout, messages to stderr as one JSON line; the exit codes are agw's. ${BIN} never prompts.
`

export interface Io {
  env: Record<string, string | undefined>
  out(text: string): void
  err(text: string): void
}

type Format = 'json' | 'plain'

interface SpawnRow {
  key: string
  status: string
  account: string | null
  resumeAt: string | null
  attempts: number
  session: string | null
  error: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const notContract = (path: string) =>
  new FactoryError('contract_mismatch', `${path} did not answer the shape this CLI expects`, {
    hint: 'the server and the CLI are from different releases',
  })

const cell = (value: unknown) => (value === null || value === undefined ? '-' : String(value))

/** Calls the server and returns the parsed body; every failure is a `FactoryError` with agw's kind. */
async function call(io: Io, path: string, options: { auth: boolean }): Promise<unknown> {
  const base = (io.env.FACTORY_URL || DEFAULT_URL).replace(/\/+$/, '')
  const token = io.env.FACTORY_TOKEN
  if (options.auth && !token) {
    throw new FactoryError('auth', 'no FACTORY_TOKEN set', {
      hint: 'run it under secrets-run with the repo .env.tpl, or export FACTORY_TOKEN',
    })
  }
  let response: Response
  let text: string
  try {
    response = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    text = await response.text()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new FactoryError('network', `server unreachable at ${base}: ${reason}`, {
      hint: `is the server up? make verify checks the deployment; ${BIN} version works offline`,
    })
  }
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body passes through as text.
  }
  if (response.ok) return body
  const message = (body as { error?: unknown } | null)?.error
  throw new FactoryError(
    kindForStatus(response.status),
    typeof message === 'string' ? message : `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    { details: { status: response.status } },
  )
}

async function execute(words: string[], format: Format, io: Io): Promise<void> {
  const print = (json: unknown, plain: string) => io.out(`${format === 'json' ? JSON.stringify(json) : plain}\n`)
  const key = words.join(' ')

  if (key === 'version') return print({ version: pkg.version }, pkg.version)

  if (key === 'health') {
    const body = await call(io, '/health', { auth: false })
    if (!isRecord(body)) throw notContract('/health')
    print(body, `${cell(body.status)}\t${cell(body.version)}`)
    if (body.status !== 'ok') throw new FactoryError('general', `server is not ok: ${cell(body.status)}`)
    return
  }

  if (key === 'spawn list') {
    const answer = await call(io, '/spawns', { auth: true })
    if (!isRecord(answer) || !Array.isArray(answer.spawns)) throw notContract('/spawns')
    const spawns = answer.spawns as SpawnRow[]
    const lines = spawns.map((s) =>
      [s.key, s.status, s.account, s.resumeAt, s.attempts, s.session].map(cell).join('\t'),
    )
    if (format === 'plain' && !lines.length) return
    return print({ spawns }, lines.join('\n'))
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
    await execute(parsed.positionals, format, io)
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
  help: { type: 'boolean', short: 'h' },
} as const
