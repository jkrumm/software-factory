import type { IssueApi } from './api/issues.ts'
import { answerIssue } from './app/issue-answer.ts'
import { fileNewIssue, type NewIssueDeps } from './app/issue-new.ts'
import { cancelIssue, noteIssue, noteSession } from './app/issue-owner.ts'
import type { CheckpointUses } from './app/checkpoints-uses.ts'
import type { IssueWrites, WriteDeps } from './app/issues.ts'

/**
 * The owner's Issue verbs and the session note: `new` files through the planning stores (edges), the rest record events
 * on the Issue. `answer` goes through the checkpoints' own use case.
 */
export function composeIssues(input: {
  writes: WriteDeps & { uow: IssueWrites }
  filing: NewIssueDeps
  checkpoints: Pick<CheckpointUses, 'decisions' | 'answer'>
}): IssueApi {
  const { writes, filing, checkpoints } = input
  return {
    file: (request) => fileNewIssue(filing, request),
    cancel: (request) => cancelIssue(writes, request),
    note: (request) => noteIssue(writes, request),
    answer: (request) => answerIssue(checkpoints, request),
    sessionNote: (request) => noteSession(writes, request),
  }
}
