import { QueueAnswer } from '@software-factory/contract'
import type { QueueWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'
import { failingOnUnavailable } from './unavailable.ts'

/** `factory-queue` through the agw port: the queue `{ repo, issues }` is the stdin. */
export function agwQueue(raw: AgwPort): QueueWorkflow {
  const agw = failingOnUnavailable(raw)
  return {
    ask: (request, key) => agw.run({ workflow: 'factory-queue', input: request, key, output: QueueAnswer }),
  }
}
