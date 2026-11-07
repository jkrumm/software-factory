export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** A process that could not start (the program is missing, the directory is gone). */
export class CannotStart extends Error {}

/**
 * Runs a program to the end or to its timeout, and says how it ended. The timeout is a helper's hang guard (git, sysctl,
 * the account picker), never a budget for an agent. Never prompts: stdin is closed.
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
    })
  } catch (error) {
    throw new CannotStart(`cannot run ${cmd[0]}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, options.timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    return { code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}
