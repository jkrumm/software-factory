import { QueueAnswer } from '@software-factory/contract'
import type { QueueWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** `factory-queue` through the agw port: the queue `{ repo, issues }` is the stdin. */
export function agwQueue(agw: AgwPort): QueueWorkflow {
  return {
    ask: (request, key) => agw.run({ workflow: 'factory-queue', input: request, key, output: QueueAnswer }),
  }
}
