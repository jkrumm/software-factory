import { type PortError } from '../../kernel/result.ts'
import { GitTimeout, gitIn, type ProcessResult, runProcess } from '../process.ts'

/** The commands the sweep runs; the defaults are the PATH's, the tests put fakes here. */
export interface Tools {
  git: string
  make: string
  bun: string
  /** the dead-code analyzer (`deadcode` probe); absent from the PATH the probe is skipped */
  fallow: string
  /** the advisory scanner for Cargo, Python and Swift lockfiles (`advisories` probe); absent from the PATH those lockfiles are skipped */
  osv: string
  /** GitHub's CLI, for facts about the repo on GitHub (`ci`, `deps`) */
  gh: string
  /** the command a scripted fix puts before its check, so the check runs in one of the host's test slots (`factory slot run`); empty: no slot, the fix is not run */
  slot: string[]
  /** the command that takes a project's merge window around what follows `--project <name> --` (`factory merge-lock`); empty: no fix lands a pull request */
  mergeLock: string[]
}

/** The tools of the sweep by their PATH names; `HygieneCheckerOptions` and the tests replace single ones. */
export const defaultTools = (git = 'git'): Tools => ({
  git,
  make: 'make',
  bun: 'bun',
  fallow: 'fallow',
  osv: 'osv-scanner',
  gh: 'gh',
  slot: ['factory', 'slot', 'run', '--name', 'hygiene-fix', '--'],
  mergeLock: ['factory', 'merge-lock'],
})

const GIT_TIMEOUT_MS = 60_000

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
  return runProcess(cmd, timeoutMs, { cwd })
}

export { withStderr } from '../process.ts'

/** The stdout of `git <args>` in `cwd`; a non-zero exit or a timeout is a `ProcessFailed`. */
export async function gitOut(tools: Tools, cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const what = `git ${args[0] ?? ''}`
  const result = await gitIn(cwd, ['-c', 'core.quotePath=false', ...args], { git: tools.git, timeoutMs }).catch(
    (error: unknown) => {
      if (!(error instanceof GitTimeout)) throw error
      throw new ProcessFailed(`${what} did not finish in ${Math.round(timeoutMs / 1000)} s`, 'timeout')
    },
  )
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
