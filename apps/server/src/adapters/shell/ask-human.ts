import { join } from 'node:path'
import type { PushPort } from '../../domains/checkpoints/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { type Run, runProcess } from '../quality/process.ts'

/** A dialog waits for a click; this is a hang guard on the script, never a budget. */
const HANG_GUARD_MS = 30 * 60_000

/** The probe is the reachability verb of the mini's dedicated MacBook key; it never waits long. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * The existing ask-human push: `ask-human.sh push <errand>` builds the request from the factory-held Errand and shows the
 * owner a dialog on the MacBook with the exact command; his answer closes the Errand through the factory CLI. Any exit is
 * an answer of some kind (done, denied, unanswered, unreachable) and none of it is the factory's to act on: the Errand
 * stays as the script left it. `bin` is the script's path; unset, the dotfiles' own copy is used. `probe` asks the same ssh
alias the script pushes through whether the MacBook answers: the gate's reachability verb, which runs nothing.
 */
export function askHumanPush(options: { bin: string | null; home: string; run?: Run; host?: string }): PushPort {
  const run = options.run ?? runProcess
  const bin = options.bin ?? join(options.home, 'SourceRoot', 'dotfiles', 'scripts', 'ask-human.sh')
  return {
    async push(errand) {
      try {
        const done = await run([bin, 'push', errand], HANG_GUARD_MS, { group: true })
        return ok({ exit: done.exitCode })
      } catch (cause) {
        return err(portError('gone', `ask-human.sh could not start: ${String(cause).slice(0, 200)}`))
      }
    },
    async probe() {
      try {
        const done = await run(
          ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', options.host ?? 'iumac', 'true'],
          PROBE_TIMEOUT_MS,
          { group: true },
        )
        return done.exitCode === 0
      } catch {
        return false
      }
    },
  }
}
