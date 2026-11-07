/** What a process run came to; a timeout is `exit: null`. */
export interface ProcessResult {
  exit: number | null
  stdout: string
}

/** Runs a command with a process timeout (a helper's, not an agent's) and returns its output; never throws for a failed start. */
export type RunProcess = (command: readonly string[], timeoutMs: number, env?: Record<string, string>) => Promise<ProcessResult>

/** The environment a helper gets: nothing of the server's secrets, a PATH and a HOME. */
export function helperEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    LC_ALL: 'C',
    ...extra,
  }
}

export const runProcess: RunProcess = async (command, timeoutMs, env = helperEnv()) => {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([...command], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  } catch (error) {
    return { exit: -1, stdout: error instanceof Error ? error.message : String(error) }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ])
    return { exit: timedOut ? null : exit, stdout: stdout + stderr }
  } finally {
    clearTimeout(timer)
  }
}
