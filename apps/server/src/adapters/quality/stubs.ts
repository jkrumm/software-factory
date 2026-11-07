import type { LeadCheckout } from '../../domains/quality/ports.ts'
import { ok } from '../../kernel/result.ts'

/**
 * Stands in for the lead's package (4), which knows where each attempt's worktree was cut. It answers that nothing is
 * known, so a ship is judged by the commits it names alone: the branch the lead worked on adds no commits to the bar.
 */
export const stubLeadCheckout: LeadCheckout = { of: async () => ok(null) }
