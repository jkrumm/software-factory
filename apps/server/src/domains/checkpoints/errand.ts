import type { Id } from '../../kernel/ids.ts'
import { err, ok, type Result } from '../../kernel/result.ts'
import type { MissingFields } from './decision.ts'

export type ErrandId = Id<'errand'>

export interface ErrandInput {
  summary: string
  detail: string | null
}

export const MAX_SUMMARY = 200
export const MAX_DETAIL = 4000

/** Reads an Errand: one line for the owner, and the steps his hands must take. */
export function readErrand(raw: unknown): Result<ErrandInput, MissingFields> {
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const problems: string[] = []
  const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
  if (summary === '') problems.push('summary')
  if (summary.length > MAX_SUMMARY) problems.push(`summary (longer than ${MAX_SUMMARY} characters)`)
  const detail = typeof body.detail === 'string' && body.detail.trim() !== '' ? body.detail.trim() : null
  if (detail !== null && detail.length > MAX_DETAIL) problems.push(`detail (longer than ${MAX_DETAIL} characters)`)
  if (problems.length > 0) {
    return err({ kind: 'missing_field', fields: problems, detail: `an Errand needs: ${problems.join(', ')}` })
  }
  return ok({ summary, detail })
}
