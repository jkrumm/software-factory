import { StewardAnswer, TriageAnswer } from '@software-factory/contract'
import type { SettleWorkflow, StewardWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'
import { failingOnUnavailable } from './unavailable.ts'

/** `factory-steward` through the agw port. */
export function agwSteward(raw: AgwPort): StewardWorkflow {
  const agw = failingOnUnavailable(raw)
  return {
    ask: (stall, key) => agw.run({ workflow: 'factory-steward', input: stall, key, output: StewardAnswer }),
  }
}

/** `factory-triage` in settle mode through the agw port. */
export function agwSettle(raw: AgwPort): SettleWorkflow {
  const agw = failingOnUnavailable(raw)
  return {
    settle: (request, key) => agw.run({ workflow: 'factory-triage', input: request, key, output: TriageAnswer }),
  }
}
