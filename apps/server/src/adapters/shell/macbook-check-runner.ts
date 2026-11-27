import type { CheckRunner, MacbookVerbPort } from '../../domains/errands/ports.ts'
import { macbookVerbOf } from '../../domains/errands/need.ts'
import { CHECK_OUTPUT_MAX, type CheckRun } from '../../domains/errands/request.ts'
import { EXIT_TIMEOUT } from '../process.ts'

/** The gate ends a report's output with `[exit N]`: the command's own exit, whatever the verb itself exited with. */
const REPORT_EXIT = /(?:^|\n)\[exit (\d+)\]\s*$/

/** The gate's time limit on a report: a run that hit it says nothing about the need. */
const GATE_TIMEOUT_EXIT = 124

/** The gate's own report limit is 60 s; this is the hang guard on the ssh call around it, so a stuck MacBook never holds the errands pass. */
export const MACBOOK_CHECK_HANG_MS = 75_000

const unrunnable = (output: string, timedOut = false): CheckRun => ({
  exit: null,
  timedOut,
  output: output.trim().slice(0, CHECK_OUTPUT_MAX),
})

/**
 * An Errand's `check` that is exactly one of the MacBook's fixed reports (`MACBOOK_REPORTS`) runs on the MacBook through the
 * gate's `report <name>` verb, and its own exit (the `[exit N]` the gate prints) is the check's exit. Any other check runs
 * where the factory does. A MacBook that cannot be reached, a gate that refuses the verb, or a report that timed out or left
 * no exit line is a check that could not run: the Errand stays open with a note, never closed on a guess.
 */
export function macbookCheckRunner(options: { shell: CheckRunner; macbook: MacbookVerbPort }): CheckRunner {
  return {
    async run(command) {
      const verb = macbookVerbOf(command, 'macbook')
      if (verb?.verb !== 'report') return options.shell.run(command)
      const done = await options.macbook.run(verb, { timeoutMs: MACBOOK_CHECK_HANG_MS })
      if (!done.ok) return unrunnable(`the MacBook could not be asked: ${done.error.detail}`)
      const { exit, output } = done.value
      if (exit === EXIT_TIMEOUT) return unrunnable(`report ${verb.name} timed out`, true)
      if (exit !== 0) return unrunnable(output || `the MacBook's gate answered exit ${exit} to report ${verb.name}`)
      const ended = REPORT_EXIT.exec(output)
      const code = ended?.[1] === undefined ? null : Number(ended[1])
      const text = ended === null ? output : output.slice(0, ended.index)
      if (code === null) return unrunnable(text || `report ${verb.name} left no exit line`)
      if (code === GATE_TIMEOUT_EXIT) return unrunnable(text, true)
      return { exit: code, timedOut: false, output: text.trim() }
    },
  }
}
