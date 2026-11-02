/** A lead's spawn, pane and session: one per attempt. */
export const leadKey = (issueId: number, attempt: number): string => `lead-${issueId}-${attempt}`
export const leadBranch = (issueId: number, attempt: number): string => `factory/${issueId}-${attempt}`
/** The first prompt of a lead, recorded under the id every prompt of the Issue's lead has. */
export const briefPromptId = (issueId: number, attempt: number): string => `issue:${issueId}:brief:${attempt}`
/** The note of a failed check, one per hold. */
export const regressionPromptId = (issueId: number, hold: number): string => `issue:${issueId}:regression:${hold}`
/** The owner's note to a lead, one per call id: the session notes of §3 key a prompt by it, so a repeated call types once. */
export const notePromptId = (issueId: number, call: string): string => `issue:${issueId}:note:${call}`
