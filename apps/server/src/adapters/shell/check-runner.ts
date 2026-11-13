import { CHECK_OUTPUT_MAX, CHECK_TIMEOUT_MS, type CheckRun } from '../../domains/checkpoints/request.ts'
import type { CheckRunner } from '../../domains/checkpoints/ports.ts'
import { CannotExecute, EXIT_STOPPED, EXIT_TIMEOUT, type Run, runProcess } from '../quality/process.ts'

/**
 * An Errand's `check`: `sh -c` in its own process group (a timeout takes what it started along), stderr folded into stdout,
 * 30 seconds, the output cut. The server's own secrets stay out of its environment (`childEnv`). The command is the asker's:
 * only a caller that can run a shell itself may set one (`api/policy.ts`).
 */
export function shellCheckRunner(run: Run = runProcess, timeoutMs = CHECK_TIMEOUT_MS): CheckRunner {
  return {
    async run(command): Promise<CheckRun> {
      try {
        // a command that does not parse never ran: `sh -n` says so, and only a check that ran may close a request
        const syntax = await run(['sh', '-n', '-c', command], timeoutMs, { group: true })
        if (syntax.exitCode !== 0) {
          return { exit: null, timedOut: false, output: 'the check is not valid shell' }
        }
        // the newline ends a trailing `# comment` before the closing parenthesis
        const result = await run(['sh', '-c', `(${command}\n) 2>&1`], timeoutMs, { group: true })
        const output = result.stdout.trim().slice(0, CHECK_OUTPUT_MAX)
        if (result.exitCode === EXIT_TIMEOUT) return { exit: null, timedOut: true, output }
        if (result.exitCode === EXIT_STOPPED) return { exit: null, timedOut: false, output }
        return { exit: result.exitCode, timedOut: false, output }
      } catch (cause) {
        const why = cause instanceof CannotExecute ? cause.message : String(cause)
        return { exit: null, timedOut: false, output: why.slice(0, CHECK_OUTPUT_MAX) }
      }
    },
  }
}
