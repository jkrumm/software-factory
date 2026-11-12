import { DigestAnswer } from '@software-factory/contract'
import type { DigestWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** `agw factory digest` (a two-word command) through the agw port: the `DigestRequest` is the stdin, the `DigestAnswer` the output. */
export function agwDigest(agw: AgwPort): DigestWorkflow {
  return {
    digest: (request, key) => agw.run({ workflow: 'factory digest', input: request, key, output: DigestAnswer }),
  }
}
