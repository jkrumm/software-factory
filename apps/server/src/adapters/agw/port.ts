import type { AgwCall, AgwPort } from '../../kernel/agw.ts'
import { AGW_HANG_GUARD_MS } from '../../kernel/agw.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'

export interface AgwOptions {
  bin: string
  /** the whole call, pending runs included; 30 minutes, never a shorter budget (`rules/agent-limits.md`) */
  hangGuardMs?: number
}

interface Finished {
  code: number
  out: string
  err: string
  /** the process was killed at the hang guard */
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
 * Runs `agw` to the end or to the hang guard. The program leads its own process group, so the guard kills what it started
 * too, and a grandchild that still holds the pipes does not keep the call waiting: after the kill they get a short grace.
 */
async function exec(
  bin: string,
  args: string[],
  stdin: string | null,
  killAt: number,
  purpose: string,
): Promise<Finished> {
  const proc = Bun.spawn([bin, ...args], {
    stdin: stdin === null ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, AGW_PURPOSE: purpose },
    detached: true,
  })
  let hung = false
  const timer = setTimeout(
    () => {
      hung = true
      killGroup(proc)
    },
    Math.max(1, killAt - Date.now()),
  )
  const stdout = proc.stdout as ReadableStream<Uint8Array>
  const stderr = proc.stderr as ReadableStream<Uint8Array>
  const finished = Promise.all([new Response(stdout).text(), new Response(stderr).text(), proc.exited])
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
      await Promise.allSettled([stdout.cancel(), stderr.cancel()])
      return { code: 137, out: '', err: '', hung: true }
    }
    return { code: done[2], out: done[0], err: done[1], hung }
  } finally {
    clearTimeout(timer)
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
 * Every failure is a `PortError`; the process is killed only at the hang guard.
 */
export function agwPort(options: AgwOptions): AgwPort {
  const guard = options.hangGuardMs ?? AGW_HANG_GUARD_MS
  return {
    async run<T>(call: AgwCall<T>): Promise<Result<T, PortError>> {
      const deadline = Date.now() + guard
      const purpose = `software-factory:${call.workflow}`
      try {
        let finished = await exec(
          options.bin,
          [call.workflow, '--format', 'json', '--idempotency-key', call.key],
          JSON.stringify(call.input),
          deadline,
          purpose,
        )
        while (finished.code === 10 && !finished.hung) {
          const runId = runIdOf(finished)
          if (!runId)
            return err(portError('unreadable', `agw ${call.workflow} is pending and named no run to wait for`))
          finished = await exec(options.bin, ['run', 'wait', runId, '--format', 'json'], null, deadline, purpose)
        }
        if (finished.hung) {
          return err(
            portError('timeout', `agw ${call.workflow} did not end within ${Math.round(guard / 60_000)} minutes`),
          )
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
