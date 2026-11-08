import { ErrandScreenAnswer } from '@software-factory/contract'
import type { ErrandScreenPort } from '../../domains/checkpoints/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** The Errand screen: `factory-errand` through the agw port, with the Errand and its Issue as they are (`ErrandScreenRequest`). */
export function agwErrandScreen(agw: AgwPort): ErrandScreenPort {
  return {
    screen: (input, key) => agw.run({ workflow: 'factory-errand', input, key, output: ErrandScreenAnswer }),
  }
}
