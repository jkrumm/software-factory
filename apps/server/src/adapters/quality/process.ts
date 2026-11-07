import { withoutSecrets } from '../secret-env.ts'

/** Stands in for an exit code when the process had to be killed for taking too long. */
export const EXIT_TIMEOUT = -1
/** Stands in for an exit code when the caller's signal stopped the process. */
export const EXIT_STOPPED = -2

export interface ProcessResult {
  exitCode: number
  stdout: string
}

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

export type Run = (
  cmd: string[],
  timeoutMs: number,
  options?: { env?: Record<string, string>; group?: boolean; signal?: AbortSignal },
) => Promise<ProcessResult>

/** The server's own secrets stay out of every child it starts (`adapters/secret-env.ts`). */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(withoutSecrets(extra)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/** The process groups running now: every way out of this process takes them along. */
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
 * Runs a command and reads its stdout (stderr is left out); past `timeoutMs` it is killed and the exit code is
 * `EXIT_TIMEOUT`. `group` gives it a process group of its own, so a kill reaches what it started (`make` and its
 * recipes); `signal` kills it early and the exit code is `EXIT_STOPPED`.
 */
export const runProcess: Run = async (cmd, timeoutMs, options = {}) => {
  if (options.signal?.aborted) return { exitCode: EXIT_STOPPED, stdout: '' }
  let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>
  try {
    proc = Bun.spawn(cmd, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: options.env ?? childEnv(),
      detached: options.group === true,
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
  let onAbort = () => {}
  const stopped = new Promise<'stopped'>((resolve) => {
    onAbort = () => resolve('stopped')
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
  if (options.group) groups.add(proc.pid)
  try {
    const outcome = await Promise.race([finished, deadline, stopped])
    if (outcome !== 'timeout' && outcome !== 'stopped') return outcome
    if (options.group) killGroup(proc.pid)
    else proc.kill('SIGKILL')
    return { exitCode: outcome === 'timeout' ? EXIT_TIMEOUT : EXIT_STOPPED, stdout: '' }
  } finally {
    clearTimeout(timer)
    groups.delete(proc.pid)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
