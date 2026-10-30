import { parseArgs } from 'node:util'
import { ErrorBody, Health, Spawn, SpawnList } from '@software-factory/contract'
import type { z } from 'zod'
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
  spawn requeue <key>
                  put a failed spawn back in the queue with a fresh retry budget

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

const notContract = (path: string, detail: string) =>
  new FactoryError('contract_mismatch', `${path} did not answer the shape this CLI expects: ${detail}`, {
    hint: 'the server and the CLI are from different releases',
  })

const cell = (value: unknown) => (value === null || value === undefined ? '-' : String(value))

interface CallOptions<S extends z.ZodType> {
  method?: 'GET' | 'POST'
  auth: boolean
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
      method: options.method ?? 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: options.method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

const spawnLine = (s: Spawn) => [s.key, s.status, s.account, s.resumeAt, s.attempts, s.session].map(cell).join('\t')

async function execute(words: string[], format: Format, io: Io): Promise<void> {
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
