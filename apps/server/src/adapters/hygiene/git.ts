import { type PortError } from '../../kernel/result.ts'
import { childEnv, EXIT_TIMEOUT, type ProcessResult, runProcess } from '../hc/process.ts'

/** The commands the sweep runs; the defaults are the PATH's, the tests put fakes here. */
export interface Tools {
  git: string
  make: string
  bun: string
}

export const GIT_TIMEOUT_MS = 60_000

/** A command that ran and did not succeed, or did not finish; `kind` is what the port reports. */
export class ProcessFailed extends Error {
  constructor(
    message: string,
    readonly kind: PortError['kind'] = 'gone',
  ) {
    super(message)
  }
}

/** Runs `cmd` in `cwd` under the server's secret-free environment; the process cannot start -> `CannotExecute`. */
export function exec(cmd: string[], timeoutMs: number, cwd?: string): Promise<ProcessResult> {
  return runProcess(cmd, timeoutMs, childEnv(), undefined, cwd)
}

/** `cmd` with stderr folded into stdout, which `runProcess` alone drops. */
export const withStderr = (cmd: string[]): string[] => ['/bin/sh', '-c', 'exec "$@" 2>&1', 'sh', ...cmd]

/** The stdout of `git <args>` in `cwd`; a non-zero exit or a timeout is a `ProcessFailed`. */
export async function gitOut(tools: Tools, cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const what = `git ${args[0] ?? ''}`
  const result = await exec([tools.git, '-c', 'core.quotePath=false', ...args], timeoutMs, cwd)
  if (result.exitCode === EXIT_TIMEOUT) {
    throw new ProcessFailed(`${what} did not finish in ${Math.round(timeoutMs / 1000)} s`, 'timeout')
  }
  if (result.exitCode !== 0) throw new ProcessFailed(`${what} failed (exit ${result.exitCode})`)
  return result.stdout
}

/** The stdout of `git <args>`, or undefined when it did not succeed. */
export async function gitTry(tools: Tools, cwd: string, args: string[]): Promise<string | undefined> {
  return gitOut(tools, cwd, args).then(
    (out) => out,
    () => undefined,
  )
}
