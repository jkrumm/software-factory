import type { IssueApi } from './api/issues.ts'
import {
  editCollection,
  listCollections,
  newCollection,
  pinCollection,
  showCollection,
} from './app/artifact-collections.ts'
import { linkArtifactToIssue, newStandaloneArtifact, setArtifactRetired } from './app/artifact-new.ts'
import { answerIssue } from './app/issue-answer.ts'
import { fileNewIssue, type NewIssueDeps } from './app/issue-new.ts'
import {
  cancelIssue,
  noteIssue,
  noteSession,
  pauseIssue,
  seatIssue,
  withdrawIssue,
  type WithdrawWrites,
} from './app/issue-owner.ts'
import type { CheckpointUses } from './app/checkpoints-uses.ts'
import type { WriteDeps } from './app/issues.ts'

/**
 * The owner's Issue verbs and the session note: `new` files through the planning stores (edges), the rest record events
 * on the Issue. `answer` goes through the checkpoints' own use case.
 */
export function composeIssues(input: {
  writes: WriteDeps & { uow: WithdrawWrites }
  filing: NewIssueDeps
  checkpoints: Pick<CheckpointUses, 'decisions' | 'answer'>
  /** the cost line of a seat's tier; absent: none (a server with no usage schema to read) */
  seatCost?: (tier: string) => Promise<string | null>
}): IssueApi {
  const { writes, filing, checkpoints } = input
  return {
    file: (request) => fileNewIssue(filing, request),
    seatCost: async (tier) => (await input.seatCost?.(tier).catch(() => null)) ?? null,
    newArtifact: (request) => newStandaloneArtifact(filing, request),
    linkArtifact: (request) => linkArtifactToIssue(filing, request),
    retireArtifact: (request) => setArtifactRetired(filing, request),
    listCollections: () => listCollections(filing),
    showCollection: (id) => showCollection(filing, id),
    newCollection: (request) => newCollection(filing, request),
    editCollection: (request) => editCollection(filing, request),
    pinCollection: (request) => pinCollection(filing, request),
    cancel: (request) => cancelIssue(writes, request),
    pause: (request) => pauseIssue(writes, request),
    withdraw: (request) => withdrawIssue(writes, request),
    note: (request) => noteIssue(writes, request),
    seat: (request) => seatIssue({ ...writes, roles: filing.roles }, request),
    answer: (request) => answerIssue(checkpoints, request),
    sessionNote: (request) => noteSession(writes, request),
  }
}
