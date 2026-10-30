import { ErrorBody } from '@software-factory/contract'
import { defaultHookSocket } from '@software-factory/contract/spool'
import type { z } from 'zod'
import { FactoryError, kindForStatus, usage } from './exit.ts'

export const BIN = 'factory'
export const DEFAULT_URL = 'http://127.0.0.1:7793'
const TIMEOUT_MS = 10_000

export interface Io {
  env: Record<string, string | undefined>
  out(text: string): void
  err(text: string): void
}

const notContract = (path: string, detail: string) =>
  new FactoryError('contract_mismatch', `${path} did not answer the shape this CLI expects: ${detail}`, {
    hint: 'the server and the CLI are from different releases',
  })

interface CallOptions<S extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** sent as JSON with a POST or PUT; `{}` when absent */
  body?: unknown
  auth: boolean
  /**
   * Through the server's unix socket instead of its port: how a session in a pane reaches it, with no token (the socket's
   * file mode is the credential). `'fallback'` goes by the socket only when there is no `FACTORY_TOKEN`. The socket serves
   * a fixed set of routes (AGENTS.md lists them).
   */
  socket?: boolean | 'fallback'
  /** the schema every answer in `accept` must satisfy */
  schema: S
  /** statuses that carry the schema's body besides 2xx */
  also?: number[]
}

/**
 * Calls the server and returns the body parsed by the contract's schema. Every failure is a `FactoryError` with agw's
 * kind: a body that does not parse is `contract_mismatch` (exit 9), whatever the status was.
 */
export async function call<S extends z.ZodType>(
  io: Io,
  path: string,
  options: CallOptions<S>,
): Promise<{ status: number; body: z.output<S> }> {
  const viaSocket = options.socket === true || (options.socket === 'fallback' && !io.env.FACTORY_TOKEN)
  const socket = viaSocket ? io.env.FACTORY_SOCKET || (io.env.HOME ? defaultHookSocket(io.env.HOME) : '') : ''
  if (viaSocket && !socket) throw usage('no socket: set FACTORY_SOCKET or HOME')
  const base = viaSocket ? 'http://localhost' : (io.env.FACTORY_URL || DEFAULT_URL).replace(/\/+$/, '')
  const token = viaSocket ? undefined : io.env.FACTORY_TOKEN
  if (options.auth && !viaSocket && !token) {
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
      ...(viaSocket ? { unix: socket } : {}),
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
