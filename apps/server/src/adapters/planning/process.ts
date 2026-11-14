export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** the CPU time the program used (user and system), µs; absent when the runtime did not say */
  cpuUs?: number
}

/** A process that could not start (the program is missing, the directory is gone). */
export class CannotStart extends Error {}

/** Runs read-only helpers for their output and adds up the CPU they took, so a loop can say what its readings cost. */
export interface TextRunner {
  /**
   * The program's stdout; null when it could not start, timed out, or exited non-zero (with `partial`, a non-zero exit
   * that still printed something counts: lsof exits 1 when it could not look at some process).
   */
  run(cmd: readonly string[], options?: { timeoutMs?: number; partial?: boolean }): Promise<string | null>
  /** the CPU the helpers used since the last call, ms */
  takeCpuMs(): number
}

export function textRunner(defaultTimeoutMs: number): TextRunner {
  let cpuUs = 0
  return {
    async run(cmd, options = {}) {
      try {
        const out = await runProcess(cmd, { timeoutMs: options.timeoutMs ?? defaultTimeoutMs })
        cpuUs += out.cpuUs ?? 0
        if (out.timedOut) return null
        if (out.code === 0 || (options.partial && out.stdout.trim() !== '')) return out.stdout
        return null
      } catch {
        return null
      }
    },
    takeCpuMs() {
      const ms = Math.round(cpuUs / 1000)
      cpuUs = 0
      return ms
    },
  }
}

/** After the kill, the pipes get this long to drain before the call gives up on them. */
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
 * Runs a program to the end or to its timeout, and says how it ended. The timeout is a helper's hang guard (git, sysctl,
 * the account picker), never a budget for an agent. Never prompts: stdin is closed. The program leads its own process
 * group, so the timeout kills what it started too (the `ssh` under `git fetch`), and a grandchild that still holds the
 * pipes does not keep the call waiting: after the kill the pipes get a short grace and are then let go.
 */
export async function runProcess(
  cmd: readonly string[],
  options: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([...cmd], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
  } catch (error) {
    throw new CannotStart(`cannot run ${cmd[0]}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(proc)
  }, options.timeoutMs)
  const stdout = proc.stdout as ReadableStream<Uint8Array>
  const stderr = proc.stderr as ReadableStream<Uint8Array>
  const finished = Promise.all([new Response(stdout).text(), new Response(stderr).text(), proc.exited])
  try {
    const gaveUp = new Promise<null>((resolve) => {
      const watch = setInterval(() => {
        if (!timedOut) return
        clearInterval(watch)
        setTimeout(() => resolve(null), PIPE_GRACE_MS)
      }, 20)
      void finished.finally(() => clearInterval(watch))
    })
    const done = await Promise.race([finished, gaveUp])
    if (done === null) {
      // A grandchild outside the group still holds the pipes: take what the program said and let them go.
      await Promise.allSettled([stdout.cancel(), stderr.cancel()])
      return { code: 137, stdout: '', stderr: '', timedOut: true }
    }
    const cpu = proc.resourceUsage()?.cpuTime.total
    return {
      code: done[2],
      stdout: done[0],
      stderr: done[1],
      timedOut,
      ...(cpu === undefined ? {} : { cpuUs: Number(cpu) }),
    }
  } finally {
    clearTimeout(timer)
  }
}
