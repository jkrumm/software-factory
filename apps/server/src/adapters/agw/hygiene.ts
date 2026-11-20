import { HygieneAnswer } from '@software-factory/contract'
import type { HygieneWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'
import { failingOnUnavailable } from './unavailable.ts'

/** `factory-hygiene` through the agw port: `{ repo, cwd, ref, stale, slop, max }` is the stdin, `cwd` the checkout it reads. */
export function agwHygiene(raw: AgwPort): HygieneWorkflow {
  const agw = failingOnUnavailable(raw)
  return {
    ask: (request, key) => agw.run({ workflow: 'factory-hygiene', input: request, key, output: HygieneAnswer }),
  }
}
