import { join } from 'node:path'
import type { MacbookVerbPort, PushPort, SyncPort } from '../../domains/errands/ports.ts'
import { verbWords } from '../../domains/errands/need.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { type Run, runProcess } from '../process.ts'

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
export function askHumanPush(options: {
  bin: string | null
  home: string
  run?: Run
  /** the ssh alias of the MacBook (the one `ask-human.sh` pushes through); unset, the probe never runs */
  host?: string | null
}): PushPort {
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
      const host = options.host
      if (!host) return false
      try {
        const done = await run(
          ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'true'],
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

/** A verb of the gate (a pull, a sync with its make targets) is a hang guard here, never a budget. */
const VERB_TIMEOUT_MS = 10 * 60_000

/**
 * The MacBook's fixed verbs (`dotfiles-sync`, `report <name>`, `repo-pull <name>`) through the ssh alias `ask-human.sh` pushes
 * through. The words are the verb and one name the domain validated (`need.ts`); the gate validates them again. `BatchMode`
 * so a key that is not accepted fails at once; unset host, there is no MacBook to call.
 */
export function askHumanVerbs(options: { host: string | null; run?: Run }): MacbookVerbPort {
  const run = options.run ?? runProcess
  return {
    async run(verb, call) {
      if (!options.host) return err(portError('gone', 'no MacBook ssh alias is set (FACTORY_ASK_HUMAN_HOST)'))
      try {
        const done = await run(
          ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', options.host, ...verbWords(verb)],
          call?.timeoutMs ?? VERB_TIMEOUT_MS,
          { group: true },
        )
        return ok({ exit: done.exitCode, output: done.stdout })
      } catch (cause) {
        return err(portError('gone', `ssh could not start: ${String(cause).slice(0, 200)}`))
      }
    },
  }
}

/**
 * The MacBook's `dotfiles-sync` verb, through the same ssh alias and the same call as the other verbs (`askHumanVerbs`).
 */
export function askHumanSync(options: { host: string | null; run?: Run }): SyncPort {
  const verbs = askHumanVerbs(options)
  return { sync: () => verbs.run({ verb: 'dotfiles-sync' }) }
}
