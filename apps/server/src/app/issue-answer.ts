import type { DecisionId } from '../domains/checkpoints/decision.ts'
import type { OwnerActor } from '../kernel/events.ts'
import type { IssueId } from '../kernel/ids.ts'
import { err, type PortError, type Result } from '../kernel/result.ts'
import type { Answered, CheckpointError } from './checkpoints.ts'
import type { CheckpointUses } from './checkpoints-uses.ts'

export type IssueAnswerError =
  | CheckpointError
  | { kind: 'no_open_decision'; issueId: IssueId }
  /** several Decisions are open and none was named */
  | { kind: 'ambiguous'; issueId: IssueId; decisions: string[] }

/**
 * The legacy answer form (`POST /issues/:id/answer`): finds the Issue's open Decision and answers it with the same use
 * case as `decision answer`. The Decision named with `decision` must be one of the Issue's open ones; with none named, exactly
 * one may be open.
 */
export async function answerIssue(
  uses: Pick<CheckpointUses, 'decisions' | 'answer'>,
  input: { issueId: IssueId; answer: string; by?: OwnerActor | undefined; decision?: string | undefined },
): Promise<Result<Answered, IssueAnswerError | PortError>> {
  const open = await uses.decisions({ issueId: input.issueId, status: 'open', limit: 50 })
  if (!open.ok) return open
  const ids = open.value.map((decision) => decision.id)
  if (input.decision !== undefined) {
    if (!ids.some((id) => id === input.decision)) {
      return err({ kind: 'not_found', what: 'open Decision', id: input.decision })
    }
    return uses.answer({
      decisionId: input.decision as DecisionId,
      answer: input.answer,
      ...(input.by ? { by: input.by } : {}),
    })
  }
  const [only, ...others] = ids
  if (only === undefined) return err({ kind: 'no_open_decision', issueId: input.issueId })
  if (others.length > 0) return err({ kind: 'ambiguous', issueId: input.issueId, decisions: ids })
  return uses.answer({ decisionId: only, answer: input.answer, ...(input.by ? { by: input.by } : {}) })
}
