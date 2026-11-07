/**
 * The exit-code table, copied from agent-workflows (`packages/cli/src/exit.ts`). It is the contract every caller
 * branches on, shared by both CLIs: a code is never added or changed here alone.
 */
export const EXIT = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 3,
  not_found: 4,
  conflict: 5,
  confirmation_required: 6,
  network: 7,
  rate_limited: 8,
  contract_mismatch: 9,
  pending: 10,
} as const

export type ExitKind = keyof typeof EXIT
export type ErrorKind = Exclude<ExitKind, 'ok'>

export interface ErrorFields {
  code?: string | null
  hint?: string
  details?: Record<string, unknown>
}

/** Every failure leaves through this: one JSON line on stderr and the kind's exit code. */
export class FactoryError extends Error {
  readonly code: string | null
  readonly hint: string
  readonly details: Record<string, unknown>

  constructor(
    readonly kind: ErrorKind,
    message: string,
    fields: ErrorFields = {},
  ) {
    super(message)
    this.name = 'FactoryError'
    this.code = fields.code ?? null
    this.hint = fields.hint ?? ''
    this.details = fields.details ?? {}
  }

  get exitCode(): number {
    return EXIT[this.kind]
  }

  toErrorLine(): string {
    const { kind, code, message, hint, details } = this
    return JSON.stringify({ error: { kind, code, message, hint, details } })
  }
}

export const usage = (message: string, hint = '') => new FactoryError('usage', message, { hint })

/** HTTP status → error kind, agw's table. */
export function kindForStatus(status: number): ErrorKind {
  if (status === 412) return 'contract_mismatch'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'usage'
  return 'general'
}
