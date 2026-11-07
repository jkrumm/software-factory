import { StewardAnswer, TriageAnswer } from '@software-factory/contract'
import type { SettleWorkflow, StewardWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** `factory-steward` through the agw port. */
export function agwSteward(agw: AgwPort): StewardWorkflow {
  return {
    ask: (stall, key) => agw.run({ workflow: 'factory-steward', input: stall, key, output: StewardAnswer }),
  }
}

/** `factory-triage` in settle mode through the agw port. */
export function agwSettle(agw: AgwPort): SettleWorkflow {
  return {
    settle: (request, key) => agw.run({ workflow: 'factory-triage', input: request, key, output: TriageAnswer }),
  }
}
