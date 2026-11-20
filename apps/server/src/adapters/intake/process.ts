import { CannotExecute, runProcess } from '../process.ts'

/** What a helper run came to; a timeout is `exit: null`. */
export interface ProcessResult {
  exit: number | null
  stdout: string
}

/** Runs a command with a process timeout (a helper's, not an agent's) and returns its output; never throws for a failed start. */
export type RunProcess = (
  command: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<ProcessResult>

/** The environment a helper gets: nothing of the server's secrets, a PATH and a HOME. */
export function helperEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    LC_ALL: 'C',
    ...extra,
  }
}

/** The shared `runProcess` in the shape intake reads: stderr after stdout in one text, a timeout `null`, a failed start the message. */
export const runHelper: RunProcess = async (command, timeoutMs, env = helperEnv()) => {
  try {
    const done = await runProcess(command, timeoutMs, { env, stderr: 'capture' })
    return { exit: done.timedOut ? null : done.exitCode, stdout: done.stdout + done.stderr }
  } catch (error) {
    if (!(error instanceof CannotExecute)) throw error
    return { exit: -1, stdout: error.message }
  }
}
