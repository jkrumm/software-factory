import type { TriageWorkflow } from '../../domains/intake/ports.ts'
import { err, portError } from '../../kernel/result.ts'

/**
 * Package 7 brings `factory-triage`, the agw workflow that decides amend-or-new when the deterministic match is unsure.
 * Until then the answer is "unreachable", which intake reads as: file anew.
 */
export const stubTriageWorkflow: TriageWorkflow = {
  amendOrNew: () => Promise.resolve(err(portError('gone', 'factory-triage is not wired yet (package 7)'))),
}
