import { FixClassesAnswer } from '@software-factory/contract'
import type { FixClassesWorkflow } from '../../domains/loops/ports.ts'
import type { AgwPort } from '../../kernel/agw.ts'

/** `factory-fix-classes` through the agw port: `{ repo, classes, commits }` is the stdin. */
export function agwFixClasses(agw: AgwPort): FixClassesWorkflow {
  return {
    ask: (request, key) => agw.run({ workflow: 'factory-fix-classes', input: request, key, output: FixClassesAnswer }),
  }
}
