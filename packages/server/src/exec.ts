export interface ProcessResult {
  exitCode: number
  stdout: string
  /** only with `control.stderr`: what the process said on stderr (empty when it was killed) */
  stderr?: string
}

/** Stands in for an exit code when the process had to be killed: a transient failure like any other non-zero exit. */
export const EXIT_TIMEOUT = -1

/** Stands in for an exit code when the caller's signal stopped the process. */
export const EXIT_STOPPED = -2

/** Longest one `hc` invocation may run before it is killed. */
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

/** What the factory is given to run on is not for `hc`, which would pass its environment on. */
const SECRET_ENV = ['FACTORY_TOKEN', 'FACTORY_DB_PASSWORD', 'DATABASE_URL', 'FACTORY_GITHUB_TOKEN', 'NTFY_TOKEN']

export function childEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...process.env, ...extra }
  for (const name of SECRET_ENV) delete env[name]
  return env
}

/** The process groups running now: every way out of this process takes them along, a lost database lock's `process.exit` too. */
const groups = new Set<number>()

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group is gone: what was wanted.
  }
}

process.on('exit', () => {
  for (const pid of groups) killGroup(pid)
})

/**
 * Runs a command and reads its stdout; past `timeoutMs` it is killed and the exit code is `EXIT_TIMEOUT`. `input`, if given,
 * is written to its stdin, which is then closed. `group` gives it a process group of its own, so a kill reaches what it started (`make`
 * and its recipes); `signal` kills it early, and the exit code is `EXIT_STOPPED`.
 */
export async function runProcess(
  cmd: string[],
  timeoutMs: number,
  env: Record<string, string | undefined> = childEnv(),
  input?: string,
  control: { group?: boolean; signal?: AbortSignal; stderr?: boolean } = {},
): Promise<ProcessResult> {
  if (control.signal?.aborted) return { exitCode: EXIT_STOPPED, stdout: '' }
  let proc: Bun.Subprocess<Bun.SpawnOptions.Writable, 'pipe', 'pipe' | 'ignore'>
  try {
    proc = Bun.spawn(cmd, {
      stdin: input === undefined ? 'ignore' : Buffer.from(input),
      stdout: 'pipe',
      stderr: control.stderr ? 'pipe' : 'ignore',
      env,
      detached: control.group === true,
    })
  } catch (cause) {
    throw new CannotExecute(cmd[0] ?? '', cause)
  }

  // The deadline also covers a child that is gone but whose stdout a grandchild keeps open.
  let timer: Timer | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const finished = Promise.all([proc.stdout.text(), proc.stderr ? proc.stderr.text() : undefined, proc.exited]).then(
    ([stdout, stderr, exitCode]) => ({ stdout, exitCode, ...(stderr === undefined ? {} : { stderr }) }),
  )
  finished.catch(() => {})
  let onAbort = () => {}
  const stopped = new Promise<'stopped'>((resolve) => {
    onAbort = () => resolve('stopped')
    control.signal?.addEventListener('abort', onAbort, { once: true })
  })
  if (control.group) groups.add(proc.pid)
  const kill = () => {
    if (control.group) killGroup(proc.pid)
    else proc.kill('SIGKILL')
  }
  try {
    const outcome = await Promise.race([finished, deadline, stopped])
    if (outcome !== 'timeout' && outcome !== 'stopped') return outcome
    kill()
    return {
      exitCode: outcome === 'timeout' ? EXIT_TIMEOUT : EXIT_STOPPED,
      stdout: '',
      ...(control.stderr ? { stderr: '' } : {}),
    }
  } finally {
    clearTimeout(timer)
    groups.delete(proc.pid)
    control.signal?.removeEventListener('abort', onAbort)
  }
}
