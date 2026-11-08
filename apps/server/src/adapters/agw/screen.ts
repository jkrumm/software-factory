import { ScreenAnswer } from '@software-factory/contract'
import type { ScreenWorkflow } from '../../domains/intake/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** `factory-screen` through the agw port: the `ScreenRequest` is the stdin, the `ScreenAnswer` the output. */
export function agwScreen(agw: AgwPort): ScreenWorkflow {
  return {
    screen: (request, key) => agw.run({ workflow: 'factory-screen', input: request, key, output: ScreenAnswer }),
  }
}
