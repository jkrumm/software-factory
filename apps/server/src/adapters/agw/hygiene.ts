import { HygieneAnswer } from '@software-factory/contract'
import type { HygieneWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** `factory-hygiene` through the agw port: `{ repo, cwd, ref, stale, slop, max }` is the stdin, `cwd` the checkout it reads. */
export function agwHygiene(agw: AgwPort): HygieneWorkflow {
  return {
    ask: (request, key) => agw.run({ workflow: 'factory-hygiene', input: request, key, output: HygieneAnswer }),
  }
}
