import { type Judged, tracePort } from '../kernel/telemetry.ts'
import { withoutSecrets } from './secret-env.ts'

/** Stands in for an exit code when the process had to be killed for taking too long. */
export const EXIT_TIMEOUT = -1
/** Stands in for an exit code when the caller's signal stopped the process. */
export const EXIT_STOPPED = -2

/** Longest one `hc` or `git` invocation may run before it is killed, unless the caller says more. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 10_000

export interface ProcessResult {
  exitCode: number
  stdout: string
}

/** What `runProcess` knows beyond the exit code and stdout. */
export interface ProcessOutcome extends ProcessResult {
  /** what the program wrote on stderr; empty unless the call asked for it (`stderr: 'capture'`) */
  stderr: string
  /** the time limit (or the caller's signal) killed it; the exit code is then `EXIT_TIMEOUT` or `EXIT_STOPPED` and the output is empty */
  timedOut: boolean
  /** the CPU time the program used (user and system), µs; absent when it was killed or the runtime did not say */
  cpuUs?: number
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

export interface RunOptions {
  /** the child's whole environment; default `childEnv()` */
  env?: Record<string, string>
  cwd?: string
  /** written to its stdin, which is then closed; absent: stdin is closed at once */
  input?: string
  /** gives it a process group of its own, so a kill reaches what it started (`make` and its recipes, the `ssh` under `git fetch`) */
  group?: boolean
  /** kills it early; the exit code is then `EXIT_STOPPED` */
  signal?: AbortSignal
  /** `ignore` (default) drops stderr; `capture` returns it in `stderr` */
  stderr?: 'ignore' | 'capture'
}

export type Run = (cmd: string[], timeoutMs: number, options?: RunOptions) => Promise<ProcessResult>

/** `cmd` with stderr folded into stdout, which `runProcess` alone drops. */
export const withStderr = (cmd: string[]): string[] => ['/bin/sh', '-c', 'exec "$@" 2>&1', 'sh', ...cmd]

/** The server's own secrets stay out of every child it starts (`adapters/secret-env.ts`); `extra` is named by the caller. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(withoutSecrets(extra)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/** Kills a program that leads its own process group and everything it started; a program that does not, on its own. */
export function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone: what was wanted
    }
  }
}

/** The process groups running now: every way out of this process takes them along. */
const groups = new Set<number>()

process.on('exit', () => {
  for (const pid of groups) killGroup(pid)
})

/**
 * Runs a command and reads its stdout; past `timeoutMs` it is killed and the exit code is `EXIT_TIMEOUT`. The timeout is
 * a helper's hang guard (git, sysctl, `hc`), never a budget for an agent (`rules/agent-limits.md`); every call has one.
 * A start that fails throws `CannotExecute`. A grandchild that still holds the pipes does not keep the call waiting: after
 * a kill the call returns at once.
 */
export const runProcess = (
  cmd: readonly string[],
  timeoutMs: number,
  options: RunOptions = {},
): Promise<ProcessOutcome> =>
  tracePort(
    { name: `process.${programOf(cmd)}`, port: 'process', attrs: { program: programOf(cmd), verb: verbOf(cmd) } },
    () => spawnProcess(cmd, timeoutMs, options),
    judgeOutcome,
  )

/** The program's file name, which is all a span says of the command: never its arguments. */
const programOf = (cmd: readonly string[]): string => {
  const name = (cmd[0] ?? '').split('/').pop() ?? ''
  return /^[A-Za-z0-9._-]{1,32}$/.test(name) ? name : 'other'
}

/** The first word after the program's flags when it is a plain lowercase verb (`git status`, `hc run`); a path, a message or a shell script is not one. */
const verbOf = (cmd: readonly string[]): string | null => {
  if (programOf(cmd) === 'sh') return null
  const args = cmd.slice(1)
  const at = args[0] === '-C' ? 2 : 0
  const verb = args[at]
  return verb !== undefined && /^[a-z][a-z-]{0,23}$/.test(verb) ? verb : null
}

/** A kill by the time limit is a failed call; a caller's own stop and a non-zero exit (`git diff --quiet`) are answers, not failures. */
const judgeOutcome = (outcome: ProcessOutcome): Judged => {
  if (outcome.timedOut) {
    return outcome.exitCode === EXIT_TIMEOUT
      ? { result: 'timeout', failed: true }
      : { result: 'stopped', failed: false }
  }
  return outcome.exitCode === 0
    ? { result: 'ok', failed: false }
    : { result: 'exit', failed: false, attrs: { 'exit.code': outcome.exitCode } }
}

const spawnProcess = async (
  cmd: readonly string[],
  timeoutMs: number,
  options: RunOptions,
): Promise<ProcessOutcome> => {
  const capture = options.stderr === 'capture'
  const stopped = (timedOut: boolean): ProcessOutcome => ({
    exitCode: timedOut ? EXIT_TIMEOUT : EXIT_STOPPED,
    stdout: '',
    stderr: '',
    timedOut: true,
  })
  if (options.signal?.aborted) return stopped(false)
  let proc: Bun.Subprocess<Bun.SpawnOptions.Writable, 'pipe', 'pipe' | 'ignore'>
  try {
    proc = Bun.spawn([...cmd], {
      stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
      stdout: 'pipe',
      stderr: capture ? 'pipe' : 'ignore',
      env: options.env ?? childEnv(),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      detached: options.group === true,
    }) as typeof proc
  } catch (cause) {
    throw new CannotExecute(cmd[0] ?? '', cause)
  }
  let timer: Timer | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const text = (stream: unknown): Promise<string> =>
    stream ? new Response(stream as ReadableStream<Uint8Array>).text() : Promise.resolve('')
  const finished = Promise.all([text(proc.stdout), text(proc.stderr), proc.exited]).then(
    ([stdout, stderr, exitCode]): ProcessOutcome => {
      const cpu = proc.resourceUsage()?.cpuTime.total
      return { exitCode, stdout, stderr, timedOut: false, ...(cpu === undefined ? {} : { cpuUs: Number(cpu) }) }
    },
  )
  finished.catch(() => {})
  let onAbort = () => {}
  const aborted = new Promise<'stopped'>((resolve) => {
    onAbort = () => resolve('stopped')
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
  if (options.group) groups.add(proc.pid)
  try {
    const outcome = await Promise.race([finished, deadline, aborted])
    if (outcome !== 'timeout' && outcome !== 'stopped') return outcome
    if (options.group) killGroup(proc.pid)
    else proc.kill('SIGKILL')
    return stopped(outcome === 'timeout')
  } finally {
    clearTimeout(timer)
    groups.delete(proc.pid)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

const GIT_TIMEOUT_MS = 30_000

export interface GitOptions {
  run?: Run
  git?: string
  signal?: AbortSignal
  /** the program leads a process group of its own, so a kill reaches what it started; always so with a `signal` */
  group?: boolean
  /** environment added to the secret-free one (`LC_ALL`) */
  env?: Record<string, string>
}

export class GitTimeout extends Error {}

/** Git in a repo: no prompt, the server's secrets left out, a process timeout. A timeout throws; an exit code is the caller's. */
export async function gitIn(
  repo: string,
  args: string[],
  options: GitOptions & { timeoutMs?: number } = {},
): Promise<ProcessResult & { stderr?: string }> {
  const run = options.run ?? runProcess
  const done: ProcessResult & { stderr?: string } = await run(
    [options.git ?? 'git', '-C', repo, ...args],
    options.timeoutMs ?? GIT_TIMEOUT_MS,
    {
      env: childEnv({ GIT_TERMINAL_PROMPT: '0', ...options.env }),
      stderr: 'capture',
      ...(options.group || options.signal ? { group: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )
  if (done.exitCode === EXIT_TIMEOUT) throw new GitTimeout(`git ${args[0]} did not finish in time`)
  return done
}
