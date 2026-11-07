import { z } from 'zod'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from './exec.ts'

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

/**
 * One RPC call to herdr-core, the way `hc connect` speaks it: line-delimited JSON-RPC 2.0 on stdin and stdout. Each call
 * is its own short-lived `hc connect` process (a `hello`, the request, stdin closed, the reply read by id), so a call
 * has nothing to leak and a timeout is a kill. The caller owns the time limit; `childEnv` keeps the factory's secrets
 * out of the client's environment.
 */
export class HcClient {
  constructor(private readonly options: HcClientOptions) {}

  /**
   * One long-lived `hc connect`: `hello`, then `events.subscribe` with no filter. The answer is the snapshot; after it the
   * connection carries only notifications. Ends (`closed`) on EOF, a dead process, a subscribe error or `idleMs` without
   * a line; the caller reconnects. Throws `CannotExecute` for a missing binary.
   */
  subscribe(handlers: HcStreamHandlers, idleMs: number = STREAM_IDLE_MS): HcStream {
    const env = childEnv(this.options.session ? { HC_SESSION: this.options.session } : {})
    let proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
    try {
      proc = Bun.spawn([this.options.bin, 'connect'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env })
    } catch (cause) {
      throw new CannotExecute(this.options.bin, cause)
    }
    try {
      void proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: ID, method: 'events.subscribe', params: {} })}\n`,
      )
      void proc.stdin.flush()
    } catch {
      proc.kill('SIGKILL')
    }

    let idle: Timer | undefined
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => proc.kill('SIGKILL'), idleMs)
    }
    arm()
    const handle = (line: string) => {
      let json: unknown
      try {
        json = JSON.parse(line)
      } catch {
        handlers.onBadLine()
        return
      }
      const frame = Frame.safeParse(json)
      if (!frame.success) return handlers.onBadLine()
      const { id, method, params, result, error } = frame.data
      if (id === ID) {
        const answer = error ? undefined : SubscribeAnswer.safeParse(result)
        if (answer?.success) handlers.onSnapshot(answer.data.seq, answer.data.terminals)
        else proc.kill('SIGKILL')
      } else if (method === 'event') {
        const event = EventParams.safeParse(params)
        if (event.success) handlers.onEvent(event.data)
        else handlers.onBadLine()
      } else if (method === 'missed') {
        const missed = MissedParams.safeParse(params)
        if (missed.success) handlers.onMissed(missed.data.seq, missed.data.terminals)
        else handlers.onBadLine()
      }
    }
    const read = async () => {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of proc.stdout) {
        arm()
        pending += decoder.decode(chunk, { stream: true })
        for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
          const line = pending.slice(0, at)
          pending = pending.slice(at + 1)
          if (line.trim()) handle(line)
        }
      }
      // A line cut off by the end of the stream is the hole the caller must close.
      if (pending.trim()) handlers.onBadLine()
    }
    const closed = read()
      .catch(() => {})
      .then(() => proc.exited)
      .then(() => {
        clearTimeout(idle)
      })
    return {
      closed,
      close: () => {
        clearTimeout(idle)
        proc.kill('SIGKILL')
      },
    }
  }

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
      const text = `${kind ?? reply.error.code}: ${reply.error.message}`
      throw new HcError(`hc ${method}: ${text}`, { kind: kind ?? String(reply.error.code), hint })
    }
    const parsed = schema.safeParse(reply.result)
    if (!parsed.success) {
      throw new HcError(`hc ${method} answered something unexpected: ${JSON.stringify(reply.result).slice(0, 120)}`)
    }
    return parsed.data
  }
}

/** What the core says about one terminal, as far as the witness reads it. Unknown keys are kept. */
export const TerminalRecord = z
  .object({
    address: z.string(),
    labels: z.record(z.string(), z.string()).default({}),
    state: z.string(),
    name: z.string().nullable().default(null),
    cwd: z.string().optional(),
    argv: z.array(z.string()).default([]),
    status: z.object({ state: z.string() }).loose().nullable().default(null),
    reported: z.boolean().default(false),
    turn: z.number().default(0),
    exit_code: z.number().nullable().default(null),
    foreground: z
      .object({ name: z.string(), argv: z.array(z.string()).default([]), cwd: z.string().optional() })
      .loose()
      .nullable()
      .default(null),
  })
  .loose()
export type TerminalRecord = z.infer<typeof TerminalRecord>

export const ServerStatus = z.object({ pid: z.number(), core: z.object({ id: z.string() }).loose() }).loose()

/** One change the core announced: `seq` orders them, `terminal` is absent for a document change. */
export interface HcEvent {
  seq: number
  terminal?: string
  type: string
  data: unknown
}

export interface HcStreamHandlers {
  /** the subscription's answer: every terminal now, and the sequence the events after it follow */
  onSnapshot(seq: number, terminals: unknown[]): void
  onEvent(event: HcEvent): void
  /** this subscriber fell behind: the terminals as they are at `seq` replace everything known */
  onMissed(seq: number, terminals: unknown[]): void
  /** a line that is not JSON (a truncated one was seen once): the state may have a hole */
  onBadLine(): void
}

/** A live subscription: `closed` resolves when the process is gone, whoever ended it. */
export interface HcStream {
  closed: Promise<void>
  close(): void
}

/** The core sends a heartbeat every 15 s: a stream silent for three of them is dead. */
export const STREAM_IDLE_MS = 45_000

const Frame = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
})
const SubscribeAnswer = z.object({ seq: z.number(), terminals: z.array(z.unknown()) })
const EventParams = z.object({ seq: z.number(), terminal: z.string().optional(), type: z.string(), data: z.unknown() })
const MissedParams = z.object({ seq: z.number(), terminals: z.array(z.unknown()) })

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
