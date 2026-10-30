export interface ProcessResult {
  exitCode: number
  stdout: string
}

/** Stands in for an exit code when the process had to be killed: a transient failure like any other non-zero exit. */
export const EXIT_TIMEOUT = -1

/** Longest one `herdr` invocation may run before it is killed. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 10_000

/** The command could not be started at all (no such binary): retrying will not help. */
export class CannotExecute extends Error {
  constructor(
    readonly command: string,
    cause: unknown,
  ) {
    super(`cannot execute ${command}: ${String(cause)}`)
    this.name = 'CannotExecute'
  }
}

/** What the factory is given to run on is not for herdr, which would pass it on to every agent pane it starts. */
const SECRET_ENV = ['FACTORY_TOKEN', 'FACTORY_DB_PASSWORD', 'DATABASE_URL']

export function childEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...process.env, ...extra }
  for (const name of SECRET_ENV) delete env[name]
  return env
}

/** Runs a command and reads its stdout; past `timeoutMs` it is killed and the exit code is `EXIT_TIMEOUT`. */
export async function runProcess(
  cmd: string[],
  timeoutMs: number,
  env: Record<string, string | undefined> = childEnv(),
): Promise<ProcessResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>
  try {
    proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env })
  } catch (cause) {
    throw new CannotExecute(cmd[0] ?? '', cause)
  }

  // The deadline also covers a child that is gone but whose stdout a grandchild keeps open.
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
