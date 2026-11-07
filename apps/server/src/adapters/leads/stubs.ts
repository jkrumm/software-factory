import type { Claims, Seats, Windows } from '../../domains/leads/ports.ts'
import { ok } from '../../kernel/result.ts'

// Honest stubs for what capacity (package 3) owns. `main.ts` wires these until the orchestrator wires the real adapters.

/** `stubSeats`: every lead runs on the `default` account (no `CLAUDE_CONFIG_DIR`). Package 3 brings the account picker. */
export const stubSeats: Seats = { seat: async () => ok({ account: 'default' }) }

/** `stubClaims`: no repo claim is held, so there is nothing to give back. Package 3 brings the claims. */
export const stubClaims: Claims = { release: async () => ok(undefined) }

/** `stubWindows`: no window is known. Package 3 brings the accounts' windows. */
export const stubWindows: Windows = { wall: async () => ok({ resetAt: null }) }
