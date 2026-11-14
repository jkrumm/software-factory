import { SpecScreenAnswer } from '@software-factory/contract'
import type { SpecScreenPort } from '../../domains/checkpoints/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** The Spec screen: `factory-spec-screen` through the agw port, with the Spec, its Issue and the owner's marks (`SpecScreenRequest`). */
export function agwSpecScreen(agw: AgwPort): SpecScreenPort {
  return {
    screen: (input, key) => agw.run({ workflow: 'factory-spec-screen', input, key, output: SpecScreenAnswer }),
  }
}
