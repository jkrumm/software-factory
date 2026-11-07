import { withoutSecrets } from '../secret-env.ts'

export interface ProcessResult {
  exitCode: number
  stdout: string
}

/** Stands in for an exit code when the process had to be killed. */
export const EXIT_TIMEOUT = -1

/** Longest one `hc` or `git` invocation may run before it is killed, unless the caller says more. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 10_000

/** The command could not be started at all (no such binary). */
export class CannotExecute extends Error {
  constructor(
    readonly command: string,
    cause: unknown,
  ) {
    super(`cannot execute ${command}: ${String(cause)}`)
    this.name = 'CannotExecute'
  }
}

/** The server's environment for a child, without its secrets (`adapters/secret-env.ts`); `extra` is named by the caller. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return withoutSecrets(extra)
}

/**
 * Runs a command and reads its stdout; past `timeoutMs` it is killed and the exit code is `EXIT_TIMEOUT`. `input`, if
 * given, is written to its stdin, which is then closed.
 */
export async function runProcess(
  cmd: string[],
  timeoutMs: number,
  env: Record<string, string | undefined> = childEnv(),
  input?: string,
  cwd?: string,
): Promise<ProcessResult> {
  let proc: Bun.Subprocess<Bun.SpawnOptions.Writable, 'pipe', 'ignore'>
  try {
    proc = Bun.spawn(cmd, {
      stdin: input === undefined ? 'ignore' : Buffer.from(input),
      stdout: 'pipe',
      stderr: 'ignore',
      env,
      ...(cwd ? { cwd } : {}),
    })
  } catch (cause) {
    throw new CannotExecute(cmd[0] ?? '', cause)
  }
  let timer: Timer | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const finished = Promise.all([proc.stdout.text(), proc.exited]).then(([stdout, exitCode]) => ({ stdout, exitCode }))
  finished.catch(() => {})
  try {
    const outcome = await Promise.race([finished, deadline])
    if (outcome !== 'timeout') return outcome
    proc.kill('SIGKILL')
    return { exitCode: EXIT_TIMEOUT, stdout: '' }
  } finally {
    clearTimeout(timer)
  }
}
