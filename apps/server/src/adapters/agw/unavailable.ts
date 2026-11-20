import type { AgwCall, AgwPort } from '../../kernel/agw.ts'
import { err, portError, type PortError, type Result } from '../../kernel/result.ts'

/**
 * What five `factory-*` workflows answer when their model failed: a valid neutral answer whose reason starts "<what> unavailable:"
 * (judge, triage, steward, queue, hygiene). Until agw lets those runs fail, the factory reads that reason itself: such an
 * answer is not an answer.
 */
const UNAVAILABLE = /^\s*(judge|triage|steward|queue|hygiene) unavailable\b/i

/** True when the answer is the neutral one a failed model run leaves, not a judgment. */
export const isUnavailable = (answer: { reason: string }): boolean => UNAVAILABLE.test(answer.reason)

/**
 * The agw port for a workflow that fails closed inside agw: a run that failed, or an answer that says it is unavailable, is a
 * failed call (`gone`). The callers already retry a failed call (the Judge's tries, a loop's rounds and retry window) and
 * record nothing as asked, settled or paged on it.
 */
export function failingOnUnavailable(agw: AgwPort): AgwPort {
  return {
    async run<T>(call: AgwCall<T>): Promise<Result<T, PortError>> {
      const result = await agw.run(call)
      if (!result.ok) return result
      const reason = (result.value as { reason?: unknown }).reason
      if (typeof reason !== 'string' || !isUnavailable({ reason })) return result
      return err(portError('gone', `agw ${call.workflow} could not answer: ${reason.slice(0, 200)}`))
    },
  }
}
