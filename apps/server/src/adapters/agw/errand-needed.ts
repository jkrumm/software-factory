import { ErrandNeededAnswer } from '@software-factory/contract'
import type { ErrandNeededPort } from '../../domains/checkpoints/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** The still-needed look: `factory-errand-needed` through the agw port, a request with no check and the facts the factory holds. */
export function agwErrandNeeded(agw: AgwPort): ErrandNeededPort {
  return {
    judge: (request, key) =>
      agw.run({ workflow: 'factory-errand-needed', input: request, key, output: ErrandNeededAnswer }),
  }
}
