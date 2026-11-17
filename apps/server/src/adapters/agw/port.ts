import type { AgwCall, AgwPort } from '../../kernel/agw.ts'
import { AGW_IDLE_MS } from '../../kernel/agw.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'

export interface AgwOptions {
  bin: string
  /** the idle watchdog: an `agw` process silent this long is killed; a call has no other limit (`rules/agent-limits.md`) */
  idleMs?: number
}

interface Finished {
  code: number
  out: string
  err: string
  /** the process was killed by the idle watchdog */
  hung: boolean
}

/** After the kill, the pipes get this long to drain before the call lets them go. */
const PIPE_GRACE_MS = 500

/** Kills the program and everything it started: it leads its own process group (`detached`). */
function killGroup(proc: { pid: number; kill: (signal: NodeJS.Signals) => void }): void {
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/**
 * Runs `agw` to the end or until it goes silent. The program leads its own process group, so the watchdog kills what it
 * started too, and a grandchild that still holds the pipes does not keep the call waiting: after the kill they get a short
 * grace. Output on either pipe is progress and restarts the idle clock; there is no other limit on how long it runs.
 */
async function exec(
  bin: string,
  args: string[],
  stdin: string | null,
  idleMs: number,
  purpose: string,
): Promise<Finished> {
  const proc = Bun.spawn([bin, ...args], {
    stdin: stdin === null ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, AGW_PURPOSE: purpose },
    detached: true,
  })
  let lastActivity = Date.now()
  let hung = false
  const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  const readers = [stdoutReader, stderrReader]
  const collect = async (reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string> => {
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      lastActivity = Date.now()
      text += decoder.decode(value, { stream: true })
    }
  }
  const finished = Promise.all([collect(stdoutReader), collect(stderrReader), proc.exited])
  const timer = setInterval(
    () => {
      if (hung || Date.now() - lastActivity < idleMs) return
      hung = true
      killGroup(proc)
    },
    Math.max(10, Math.min(idleMs / 4, 5_000)),
  )
  try {
    const gaveUp = new Promise<null>((resolve) => {
      const watch = setInterval(() => {
        if (!hung) return
        clearInterval(watch)
        setTimeout(() => resolve(null), PIPE_GRACE_MS)
      }, 20)
      void finished.finally(() => clearInterval(watch))
    })
    const done = await Promise.race([finished, gaveUp])
    if (done === null) {
      await Promise.allSettled(readers.map((reader) => reader.cancel()))
      return { code: 137, out: '', err: '', hung: true }
    }
    return { code: done[2], out: done[0], err: done[1], hung }
  } finally {
    clearInterval(timer)
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The run id of a still-pending answer: in the envelope on stdout, else in the hint `agw run wait <runId>` on stderr. */
function runIdOf(finished: Finished): string | null {
  const envelope = parseJson(finished.out)
  if (isRecord(envelope) && typeof envelope.runId === 'string') return envelope.runId
  return /agw run wait ([0-9A-Za-z-]+)/.exec(finished.err)?.[1] ?? null
}

/**
 * `agw <workflow> --format json --idempotency-key <key>` with the input on stdin. Exit 10 is pending: the printed resume
 * command (`agw run wait <runId>`) runs until the run ends. The envelope's `output` is checked against the call's schema.
 * Every failure is a `PortError`; a process is killed only when it goes silent (`AGW_IDLE_MS`), never for taking long.
 */
export function agwPort(options: AgwOptions): AgwPort {
  const idleMs = options.idleMs ?? AGW_IDLE_MS
  return {
    async run<T>(call: AgwCall<T>): Promise<Result<T, PortError>> {
      // agw takes 1 to 64 of [A-Za-z0-9_.-] as a purpose (a colon is refused with a 400)
      const purpose = `software-factory.${call.workflow.replaceAll(' ', '.')}`
      try {
        let finished = await exec(
          options.bin,
          [...call.workflow.split(' '), '--format', 'json', '--idempotency-key', call.key],
          JSON.stringify(call.input),
          idleMs,
          purpose,
        )
        while (finished.code === 10 && !finished.hung) {
          const runId = runIdOf(finished)
          if (!runId)
            return err(portError('unreadable', `agw ${call.workflow} is pending and named no run to wait for`))
          finished = await exec(options.bin, ['run', 'wait', runId, '--format', 'json'], null, idleMs, purpose)
        }
        if (finished.hung) {
          return err(portError('timeout', `agw ${call.workflow} went silent for ${Math.round(idleMs / 1000)} s`))
        }
        if (finished.code !== 0) {
          const said = finished.err.trim() || finished.out.trim()
          return err(portError('gone', `agw ${call.workflow} exited ${finished.code}: ${said.slice(0, 300)}`))
        }
        const envelope = parseJson(finished.out)
        if (!isRecord(envelope))
          return err(portError('unreadable', `agw ${call.workflow} did not print a run envelope`))
        if (envelope.status !== 'done') {
          return err(portError('gone', `agw ${call.workflow} run ${String(envelope.status)}`))
        }
        const parsed = call.output.safeParse(envelope.output)
        if (!parsed.success) {
          const first = parsed.error.issues[0]
          return err(
            portError(
              'unreadable',
              `agw ${call.workflow} output does not parse: ${first ? `${first.path.join('.') || 'output'} ${first.message}` : 'unknown'}`,
            ),
          )
        }
        return ok(parsed.data)
      } catch (error) {
        return err(portError('gone', `agw could not run: ${error instanceof Error ? error.message : String(error)}`))
      }
    },
  }
}
