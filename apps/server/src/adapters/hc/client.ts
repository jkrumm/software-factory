import * as z from 'zod'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from './process.ts'

/**
 * A call to herdr-core that did not give an answer. `refusal` is set when the core replied with an error body: it looked
 * at the request and did nothing. Without it nothing is known (timeout, a dead process, output that is not a reply): the
 * call may or may not have taken effect.
 */
export class HcError extends Error {
  constructor(
    message: string,
    readonly refusal?: { kind: string; hint?: string },
  ) {
    super(message)
    this.name = 'HcError'
  }
}

export interface HcClientOptions {
  /** the command to run, normally `HC_BIN` */
  bin: string
  /** `HC_SESSION`: another core than the default one (tests); unset leaves the environment as it is */
  session?: string
}

const ID = 1

const Envelope = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.object({ kind: z.string().optional(), hint: z.string().optional() }).loose().optional(),
    })
    .optional(),
})
type Reply = { result: unknown } | { error: NonNullable<z.infer<typeof Envelope>['error']> }

/** The reply to the request (`id` 1) among the lines `hc connect` printed, if there is one. */
function findReply(stdout: string): Reply | undefined {
  for (const line of stdout.split('\n')) {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      continue
    }
    const envelope = Envelope.safeParse(json)
    if (!envelope.success || envelope.data.id !== ID) continue
    if (envelope.data.error) return { error: envelope.data.error }
    if ('result' in envelope.data) return { result: envelope.data.result }
  }
  return undefined
}

const snippet = (stdout: string): string => (stdout ? `: ${stdout.slice(0, 120)}` : '')

/**
 * One RPC call to herdr-core, the way `hc connect` speaks it: line-delimited JSON-RPC 2.0 on stdin and stdout. Each call
 * is its own short-lived `hc connect` process (a `hello`, the request, stdin closed, the reply read by id), so a call
 * has nothing to leak and a timeout is a kill. The caller owns the time limit; `childEnv` keeps the factory's secrets
 * out of the client's environment.
 */
export class HcClient {
  constructor(private readonly options: HcClientOptions) {}

  /** `method` with `params`; the `result` must parse as `schema`. Throws `HcError`, or `CannotExecute` for a missing binary. */
  async call<S extends z.ZodType>(method: string, params: object, schema: S, timeoutMs: number): Promise<z.output<S>> {
    const request = [
      { jsonrpc: '2.0', id: 0, method: 'hello', params: {} },
      { jsonrpc: '2.0', id: ID, method, params },
    ]
    const env = childEnv(this.options.session ? { HC_SESSION: this.options.session } : {})
    const result = await runProcess(
      [this.options.bin, 'connect'],
      timeoutMs,
      env,
      `${request.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )
    const reply = findReply(result.stdout)
    if (!reply) {
      const what = result.exitCode === EXIT_TIMEOUT ? 'timed out' : `exited ${result.exitCode}`
      throw new HcError(`hc ${method}: ${what} without a reply${snippet(result.stdout)}`)
    }
    if ('error' in reply) {
      const { kind, hint } = reply.error.data ?? {}
      throw new HcError(`hc ${method}: ${kind ?? reply.error.code}: ${reply.error.message}`, {
        kind: kind ?? String(reply.error.code),
        hint,
      })
    }
    const parsed = schema.safeParse(reply.result)
    if (!parsed.success) {
      throw new HcError(`hc ${method} answered something unexpected: ${JSON.stringify(reply.result).slice(0, 120)}`)
    }
    return parsed.data
  }
}

export { CannotExecute }
