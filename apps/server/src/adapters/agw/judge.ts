import { JudgeVerdictWire } from '@software-factory/contract'
import type { JudgePort } from '../../domains/checkpoints/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** The Judge: `factory-ask` through the agw port, with the Decision as it is (`JudgeInput`). */
export function agwJudge(agw: AgwPort): JudgePort {
  return {
    judge: (input, key) => agw.run({ workflow: 'factory-ask', input, key, output: JudgeVerdictWire }),
  }
}
