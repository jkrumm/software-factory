import { join } from 'node:path'
import type { Runbook } from '../../domains/intake/ports.ts'
import { ok } from '../../kernel/result.ts'
import { type RunProcess, runProcess } from './process.ts'

const RUNBOOK_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 10_000

/**
 * A heal rule's runbook: `make restart` in the project's repo, run by the settle pass outside any transaction. A repo
 * whose Makefile has no `restart` target is skipped with that reason (the Makefile contract: a target a repo lacks is
 * not an error to run, it is a rule that cannot help).
 */
export function makeRestartRunbook(options: { sourceRoot: string; run?: RunProcess }): Runbook {
  const run = options.run ?? runProcess
  return {
    async run({ repo }) {
      const dir = join(options.sourceRoot, repo)
      const probe = await run(['make', '-C', dir, '-n', 'restart'], PROBE_TIMEOUT_MS)
      if (probe.exit !== 0) return ok({ ran: false, reason: 'no restart target' })
      const done = await run(['sh', '-c', 'exec make -C "$1" restart 2>&1', 'sh', dir], RUNBOOK_TIMEOUT_MS)
      if (done.exit === null)
        return ok({ ran: true, exit: -1, tail: `did not finish in ${RUNBOOK_TIMEOUT_MS / 1000} s` })
      return ok({ ran: true, exit: done.exit, tail: done.stdout.trim().slice(-500) })
    },
  }
}
