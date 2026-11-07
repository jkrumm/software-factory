export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** A process that could not start (the program is missing, the directory is gone). */
export class CannotStart extends Error {}

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
    return { code: done[2], stdout: done[0], stderr: done[1], timedOut }
  } finally {
    clearTimeout(timer)
  }
}
